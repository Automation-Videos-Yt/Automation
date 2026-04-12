import { spawn } from "node:child_process";
import { scoped } from "../lib/logger";

const log = scoped("clip-prep");
const FFMPEG_BIN = process.env.FFMPEG_PATH ?? "ffmpeg";

export type ClipPrepInput = {
  sourcePath: string | null; // null => render a solid-color placeholder clip
  outputPath: string;
  durationSec: number;
  width: number;
  height: number;
  placeholderHex?: string; // used when sourcePath is null
  sourceDurationSec?: number; // if known, center the cut for variety
};

function buildArgs(input: ClipPrepInput): string[] {
  const dur = Math.max(0.5, input.durationSec);
  const { width, height } = input;

  // Placeholder (no source clip) — render a solid color + label text free.
  if (!input.sourcePath) {
    const bg = input.placeholderHex ?? "#0f172a";
    return [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${bg}:s=${width}x${height}:d=${dur.toFixed(3)}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=cl=stereo:r=44100`,
      "-t",
      dur.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      input.outputPath,
    ];
  }

  // Center-cut the source clip when we know its duration, otherwise start from 0.
  let startOffset = 0;
  if (input.sourceDurationSec && input.sourceDurationSec > dur + 0.5) {
    startOffset = Math.max(0, (input.sourceDurationSec - dur) / 2);
  }

  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  return [
    "-y",
    "-ss",
    startOffset.toFixed(3),
    "-i",
    input.sourcePath,
    "-t",
    dur.toFixed(3),
    "-vf",
    vf,
    "-an", // strip source audio; narration is layered later
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    input.outputPath,
  ];
}

export function prepareSceneClip(input: ClipPrepInput): Promise<void> {
  const args = buildArgs(input);
  const started = Date.now();
  log.info(
    {
      source: input.sourcePath ?? "<placeholder>",
      out: input.outputPath,
      dur: input.durationSec,
      res: `${input.width}x${input.height}`,
    },
    "prep start"
  );

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", (err) => {
      log.error({ err }, "ffmpeg spawn error");
      reject(err);
    });
    proc.on("close", (code) => {
      const elapsedMs = Date.now() - started;
      if (code === 0) {
        log.info({ elapsedMs, out: input.outputPath }, "prep done");
        resolve();
      } else {
        log.error({ elapsedMs, code, tail: stderr.slice(-800) }, "ffmpeg non-zero");
        reject(new Error(`ffmpeg prep exited ${code}: ${stderr.slice(-800)}`));
      }
    });
  });
}
