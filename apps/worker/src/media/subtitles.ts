import { writeFile } from "node:fs/promises";

export type WordSpan = { word: string; start: number; end: number };

function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function chunkWords(text: string, wordsPerCue: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerCue) {
    chunks.push(words.slice(i, i + wordsPerCue).join(" "));
  }
  return chunks;
}

/**
 * Phase 1 fallback: evenly distribute cues across audio duration.
 * Still used when Whisper alignment isn't available.
 */
export async function generateSrt(opts: {
  scriptText: string;
  audioDurationSec: number;
  outputPath: string;
  wordsPerCue?: number;
}): Promise<void> {
  const wordsPerCue = opts.wordsPerCue ?? 7;
  const cues = chunkWords(opts.scriptText, wordsPerCue);
  if (cues.length === 0) {
    await writeFile(opts.outputPath, "", "utf-8");
    return;
  }

  const perCue = opts.audioDurationSec / cues.length;
  const lines: string[] = [];

  cues.forEach((text, idx) => {
    const start = idx * perCue;
    const end = Math.min((idx + 1) * perCue, opts.audioDurationSec);
    lines.push(String(idx + 1));
    lines.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}`);
    lines.push(text);
    lines.push("");
  });

  await writeFile(opts.outputPath, lines.join("\n"), "utf-8");
}

/**
 * Word-accurate SRT from Whisper output: group N words per cue.
 * Each cue ends at the last word's end time (so captions track speech tightly).
 */
export async function generateSrtFromWords(opts: {
  words: WordSpan[];
  outputPath: string;
  wordsPerCue?: number;
}): Promise<void> {
  const wordsPerCue = opts.wordsPerCue ?? 5;
  const lines: string[] = [];
  let cueIdx = 1;

  for (let i = 0; i < opts.words.length; i += wordsPerCue) {
    const group = opts.words.slice(i, i + wordsPerCue);
    if (group.length === 0) continue;
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const text = group.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim();
    lines.push(String(cueIdx++));
    lines.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}`);
    lines.push(text);
    lines.push("");
  }

  await writeFile(opts.outputPath, lines.join("\n"), "utf-8");
}
