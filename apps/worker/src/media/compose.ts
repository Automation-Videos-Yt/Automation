import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { scoped } from "../lib/logger";

const log = scoped("compose");
const FFMPEG_BIN = process.env.FFMPEG_PATH ?? "ffmpeg";

function escapeForFilter(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,");
}

async function runFfmpeg(args: string[], phase: string): Promise<void> {
  const started = Date.now();
  log.debug({ phase, args: args.join(" ") }, "ffmpeg spawn");
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", (err) => {
      log.error({ phase, err }, "ffmpeg spawn error");
      reject(err);
    });
    proc.on("close", (code) => {
      const elapsedMs = Date.now() - started;
      if (code === 0) {
        log.info({ phase, elapsedMs }, "ffmpeg ok");
        resolve();
      } else {
        log.error(
          { phase, elapsedMs, code, tail: stderr.slice(-800) },
          "ffmpeg non-zero"
        );
        reject(new Error(`ffmpeg ${phase} exited ${code}: ${stderr.slice(-800)}`));
      }
    });
  });
}

export type ComposeOptions = {
  sceneClipPaths: string[]; // already normalized to target resolution + frame rate
  audioPath: string;
  subtitlePath: string; // may be empty; still passed through
  outputPath: string;
  tempDir: string;
  runId?: string;
};

/**
 * Two-step compose:
 *   1. Concat all scene clips into a single silent video via the concat demuxer.
 *   2. Overlay narration audio + burned-in subtitles and mux to MP4.
 *
 * The concat demuxer needs all inputs to share codec/res/fps — enforced by clipPrep.
 */
export async function composeFinalVideo(opts: ComposeOptions): Promise<void> {
  const rlog = opts.runId ? log.child({ runId: opts.runId }) : log;
  rlog.info(
    { scenes: opts.sceneClipPaths.length, out: opts.outputPath },
    "compose start"
  );

  // --- Step 1: concat ---
  const listPath = path.join(opts.tempDir, "concat.txt");
  const listBody = opts.sceneClipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(listPath, listBody, "utf-8");

  const concatOut = path.join(opts.tempDir, "concat.mp4");
  await runFfmpeg(
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      concatOut,
    ],
    "concat"
  );

  // --- Step 2: mux audio + subtitles ---
  const hasSubs = opts.subtitlePath && opts.subtitlePath.length > 0;
  // Portrait tuning: small white text with thick black outline, anchored near the bottom.
  const vf = hasSubs
    ? `subtitles='${escapeForFilter(opts.subtitlePath)}':force_style='Fontname=DejaVu Sans,Fontsize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60'`
    : null;

  const muxArgs = [
    "-y",
    "-i",
    concatOut,
    "-i",
    opts.audioPath,
    ...(vf ? ["-vf", vf] : []),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    vf ? "libx264" : "copy",
    ...(vf ? ["-preset", "veryfast", "-pix_fmt", "yuv420p"] : []),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    opts.outputPath,
  ];

  await runFfmpeg(muxArgs, "mux");
  rlog.info({ out: opts.outputPath }, "compose done");
}
