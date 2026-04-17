import { writeFile } from "node:fs/promises";

export type WordSpan = { word: string; start: number; end: number };

export type SubtitleSegment = { text: string; start: number; end: number };

type MutableSubtitleSegment = {
  text: string;
  start: number;
  end: number;
  forceCapitalizeStart?: boolean;
};

type SplitReason = "sentence" | "gap" | "max_words" | "duration" | "end";

type SegmentRange = {
  startIdx: number;
  endIdx: number;
  splitReasonToNext: SplitReason;
};

const SENTENCE_GAP_SEC = 0.5;
const PAUSE_BREAK_SEC = 0.35;
const MIN_CUE_DURATION_SEC = 1.0;
const MAX_CUE_DURATION_SEC = 3.0;
const MIN_WORDS_PER_CUE = 3;
const MAX_WORDS_PER_CUE = 8;
const MAX_LINE_CHARS = 34;
const MIN_SEGMENT_DURATION_SEC = 0.1;
const MICRO_GAP_SNAP_SEC = 0.06;
const MAX_REFINEMENT_ADJUST_SEC = 0.2;

const SENTENCE_END_RE = /[.!?]["')\]]*$/;
const CLAUSE_END_RE = /[,;:]["')\]]*$/;

const CONNECTOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "to",
  "was",
  "were",
  "with",
]);

const DEPENDENT_STARTER_WORDS = new Set([
  "to",
  "for",
  "with",
  "of",
  "in",
  "on",
  "at",
  "from",
  "into",
  "about",
  "by",
  "and",
  "or",
  "but",
  "so",
  "that",
]);

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

function normalizeToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9]+/i, "")
    .replace(/[^a-z0-9]+$/i, "");
}

function isSentenceEnd(word: string): boolean {
  return SENTENCE_END_RE.test(word.trim());
}

function isClauseEnd(word: string): boolean {
  return CLAUSE_END_RE.test(word.trim());
}

function isConnector(word: string): boolean {
  return CONNECTOR_WORDS.has(normalizeToken(word));
}

function looksLikeSentenceStart(word: string): boolean {
  const trimmed = word.trim();
  if (!trimmed) return false;
  const alpha = trimmed.match(/[A-Za-z]/);
  if (!alpha) return false;
  const idx = alpha.index ?? -1;
  return idx >= 0 && trimmed.charAt(idx) === trimmed.charAt(idx).toUpperCase();
}

function safeGapSec(curr: WordSpan, next: WordSpan): number {
  const gap = next.start - curr.end;
  if (!Number.isFinite(gap)) return 0;
  return Math.max(0, gap);
}

function normalizeWords(words: WordSpan[]): WordSpan[] {
  const clean = words
    .filter(
      (w) =>
        typeof w.word === "string" &&
        w.word.trim().length > 0 &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end),
    )
    .map((w) => ({
      word: w.word.trim(),
      start: Math.max(0, w.start),
      end: Math.max(0, w.end),
    }))
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));

  // Guard against negative or inverted timestamps while keeping chronology.
  for (let i = 0; i < clean.length; i++) {
    if (clean[i].end < clean[i].start) {
      clean[i].end = clean[i].start;
    }
    if (i > 0 && clean[i].start < clean[i - 1].end) {
      clean[i].start = clean[i - 1].end;
      if (clean[i].end < clean[i].start) {
        clean[i].end = clean[i].start;
      }
    }
  }

  return clean;
}

function deriveTranscriptSentenceHints(
  words: WordSpan[],
  transcriptText?: string,
): Set<number> {
  const hints = new Set<number>();
  if (!transcriptText || !transcriptText.trim()) return hints;

  const rawTokens = transcriptText
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (rawTokens.length === 0) return hints;

  const tokens = rawTokens.map((token) => ({
    norm: normalizeToken(token),
    sentenceEnd: isSentenceEnd(token),
  }));

  let tokenPtr = 0;
  for (let i = 0; i < words.length; i++) {
    const normWord = normalizeToken(words[i].word);
    if (!normWord) continue;

    while (tokenPtr < tokens.length && !tokens[tokenPtr].norm) {
      tokenPtr += 1;
    }

    let found = -1;
    const maxLookahead = Math.min(tokens.length, tokenPtr + 7);
    for (let j = tokenPtr; j < maxLookahead; j++) {
      if (tokens[j].norm === normWord) {
        found = j;
        break;
      }
    }
    if (found === -1) continue;
    if (tokens[found].sentenceEnd) hints.add(i);
    tokenPtr = found + 1;
  }

  return hints;
}

function rangeWordCount(range: SegmentRange): number {
  return range.endIdx - range.startIdx + 1;
}

function rangeDurationSec(range: SegmentRange, words: WordSpan[]): number {
  if (range.endIdx < range.startIdx) return 0;
  return Math.max(0, words[range.endIdx].end - words[range.startIdx].start);
}

function buildInitialRanges(
  words: WordSpan[],
  sentenceHints: Set<number>,
): SegmentRange[] {
  const ranges: SegmentRange[] = [];
  if (words.length === 0) return ranges;

  let startIdx = 0;
  for (let i = 0; i < words.length; i++) {
    const isLast = i === words.length - 1;
    const count = i - startIdx + 1;

    if (isLast) {
      ranges.push({
        startIdx,
        endIdx: i,
        splitReasonToNext: "end",
      });
      break;
    }

    const current = words[i];
    const next = words[i + 1];
    const sentenceBreak = isSentenceEnd(current.word) || sentenceHints.has(i);
    const gap = safeGapSec(current, next);
    const gapBreak = gap > SENTENCE_GAP_SEC;
    const pauseBreak = gap >= PAUSE_BREAK_SEC && count >= MIN_WORDS_PER_CUE;

    // Priority order: sentence boundary -> gap -> max words.
    if (sentenceBreak) {
      ranges.push({ startIdx, endIdx: i, splitReasonToNext: "sentence" });
      startIdx = i + 1;
      continue;
    }
    if (gapBreak) {
      ranges.push({ startIdx, endIdx: i, splitReasonToNext: "gap" });
      startIdx = i + 1;
      continue;
    }
    if (pauseBreak) {
      ranges.push({ startIdx, endIdx: i, splitReasonToNext: "gap" });
      startIdx = i + 1;
      continue;
    }
    if (count >= MAX_WORDS_PER_CUE) {
      ranges.push({ startIdx, endIdx: i, splitReasonToNext: "max_words" });
      startIdx = i + 1;
    }
  }

  return ranges;
}

function chooseSplitBoundary(range: SegmentRange, words: WordSpan[]): number {
  const start = range.startIdx;
  const end = range.endIdx;
  if (end <= start) return start;

  const totalDur = Math.max(0.001, words[end].end - words[start].start);
  let bestIdx = Math.floor((start + end) / 2);
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = start; i < end; i++) {
    const leftCount = i - start + 1;
    const rightCount = end - i;
    if (leftCount < 1 || rightCount < 1) continue;

    const leftDur = Math.max(0, words[i].end - words[start].start);
    const ratio = leftDur / totalDur;
    let score = -Math.abs(ratio - 0.5) * 2.0;

    if (isSentenceEnd(words[i].word)) score += 3;
    else if (isClauseEnd(words[i].word)) score += 1.8;

    const gap = safeGapSec(words[i], words[i + 1]);
    if (gap > 0.25) score += 1.2;
    if (leftCount >= 3 && rightCount >= 3) score += 0.8;

    if (isConnector(words[i].word)) score -= 1.0;
    if (isConnector(words[i + 1].word)) score -= 0.6;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function splitOverlongRanges(
  ranges: SegmentRange[],
  words: WordSpan[],
): SegmentRange[] {
  const out: SegmentRange[] = [];

  const splitRange = (range: SegmentRange): SegmentRange[] => {
    const count = rangeWordCount(range);
    const durationSec = rangeDurationSec(range, words);
    if (
      (count <= MAX_WORDS_PER_CUE && durationSec <= MAX_CUE_DURATION_SEC) ||
      count <= 1
    ) {
      return [range];
    }

    const splitAt = chooseSplitBoundary(range, words);
    if (splitAt <= range.startIdx || splitAt >= range.endIdx) {
      return [range];
    }

    const left: SegmentRange = {
      startIdx: range.startIdx,
      endIdx: splitAt,
      splitReasonToNext: "duration",
    };
    const right: SegmentRange = {
      startIdx: splitAt + 1,
      endIdx: range.endIdx,
      splitReasonToNext: range.splitReasonToNext,
    };

    return [...splitRange(left), ...splitRange(right)];
  };

  for (const range of ranges) {
    out.push(...splitRange(range));
  }

  return out;
}

function canMergeAcrossBoundary(reason: SplitReason): boolean {
  return reason === "max_words" || reason === "duration";
}

function mergeShortRangesByWordCount(ranges: SegmentRange[]): SegmentRange[] {
  const out = ranges.map((r) => ({ ...r }));
  let i = 0;

  while (i < out.length) {
    const current = out[i];
    const count = rangeWordCount(current);
    if (count >= MIN_WORDS_PER_CUE) {
      i += 1;
      continue;
    }

    let merged = false;

    if (
      i < out.length - 1 &&
      canMergeAcrossBoundary(current.splitReasonToNext)
    ) {
      const next = out[i + 1];
      out.splice(i, 2, {
        startIdx: current.startIdx,
        endIdx: next.endIdx,
        splitReasonToNext: next.splitReasonToNext,
      });
      merged = true;
    }

    if (
      !merged &&
      i > 0 &&
      canMergeAcrossBoundary(out[i - 1].splitReasonToNext)
    ) {
      const prev = out[i - 1];
      out.splice(i - 1, 2, {
        startIdx: prev.startIdx,
        endIdx: current.endIdx,
        splitReasonToNext: current.splitReasonToNext,
      });
      merged = true;
      i = Math.max(0, i - 1);
    }

    if (!merged) {
      i += 1;
    }
  }

  return out;
}

function mergeShortRangesByDuration(
  ranges: SegmentRange[],
  words: WordSpan[],
): SegmentRange[] {
  const out = ranges.map((r) => ({ ...r }));
  let i = 0;

  while (i < out.length) {
    const current = out[i];
    const durationSec = rangeDurationSec(current, words);
    if (durationSec >= MIN_CUE_DURATION_SEC) {
      i += 1;
      continue;
    }

    let merged = false;

    if (
      i < out.length - 1 &&
      canMergeAcrossBoundary(current.splitReasonToNext)
    ) {
      const next = out[i + 1];
      out.splice(i, 2, {
        startIdx: current.startIdx,
        endIdx: next.endIdx,
        splitReasonToNext: next.splitReasonToNext,
      });
      merged = true;
    }

    if (
      !merged &&
      i > 0 &&
      canMergeAcrossBoundary(out[i - 1].splitReasonToNext)
    ) {
      const prev = out[i - 1];
      out.splice(i - 1, 2, {
        startIdx: prev.startIdx,
        endIdx: current.endIdx,
        splitReasonToNext: current.splitReasonToNext,
      });
      merged = true;
      i = Math.max(0, i - 1);
    }

    if (!merged) {
      i += 1;
    }
  }

  return out;
}

function chooseLineBreakIndex(tokens: string[]): number | null {
  if (tokens.length <= 4) return null;

  const total = tokens.join(" ").length;
  if (total <= MAX_LINE_CHARS) return null;

  let bestIdx: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 1; i < tokens.length; i++) {
    const left = tokens.slice(0, i).join(" ");
    const right = tokens.slice(i).join(" ");
    let score = -Math.abs(left.length - right.length) / 10;

    if (
      left.length > MAX_LINE_CHARS * 1.35 ||
      right.length > MAX_LINE_CHARS * 1.35
    ) {
      score -= 1.8;
    }

    if (isClauseEnd(tokens[i - 1]) || isSentenceEnd(tokens[i - 1])) {
      score += 1.2;
    }
    if (isConnector(tokens[i - 1]) || isConnector(tokens[i])) {
      score -= 0.8;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function formatCueText(tokens: string[]): string {
  const normalized = tokens.join(" ").replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  if (normalized.length <= MAX_LINE_CHARS) {
    return normalized;
  }

  const splitAt = chooseLineBreakIndex(tokens);
  if (splitAt == null) return normalized;

  const line1 = tokens.slice(0, splitAt).join(" ").trim();
  const line2 = tokens.slice(splitAt).join(" ").trim();
  if (!line1 || !line2) return normalized;

  return `${line1}\n${line2}`;
}

function tokenizeText(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function normalizeSegments(
  segments: SubtitleSegment[],
): MutableSubtitleSegment[] {
  return segments
    .filter(
      (segment) =>
        !!segment &&
        typeof segment.text === "string" &&
        segment.text.trim().length > 0 &&
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end),
    )
    .map((segment) => ({
      text: formatCueText(tokenizeText(segment.text)),
      start: Math.max(0, segment.start),
      end: Math.max(0, segment.end),
    }))
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
}

function collectWordSequence(segments: Array<{ text: string }>): string[] {
  return segments.flatMap((segment) => tokenizeText(segment.text));
}

function canonicalWordIdentity(word: string): string {
  const normalized = normalizeToken(word);
  return normalized || word.trim().toLowerCase();
}

function findInternalSentenceBoundary(tokens: string[]): number {
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!isSentenceEnd(tokens[i])) continue;

    const leftCount = i + 1;
    const rightCount = tokens.length - leftCount;
    const nextStartsSentence = looksLikeSentenceStart(tokens[i + 1]);
    if (leftCount >= 2 && rightCount >= 2 && nextStartsSentence) {
      return i;
    }
  }

  return -1;
}

function splitSegmentOnSentenceBoundary(
  segment: MutableSubtitleSegment,
): MutableSubtitleSegment[] {
  const tokens = tokenizeText(segment.text);
  const splitAt = findInternalSentenceBoundary(tokens);
  if (splitAt === -1) {
    return [segment];
  }

  const leftTokens = tokens.slice(0, splitAt + 1);
  const rightTokens = tokens.slice(splitAt + 1);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return [segment];
  }

  const duration = Math.max(0, segment.end - segment.start);
  const ratio = leftTokens.length / tokens.length;
  const estimatedBoundary = segment.start + duration * ratio;
  const boundary = Math.min(
    segment.end - MIN_SEGMENT_DURATION_SEC,
    Math.max(segment.start + MIN_SEGMENT_DURATION_SEC, estimatedBoundary),
  );

  const left: MutableSubtitleSegment = {
    text: formatCueText(leftTokens),
    start: segment.start,
    end: boundary,
  };
  const right: MutableSubtitleSegment = {
    text: formatCueText(rightTokens),
    start: boundary,
    end: segment.end,
    forceCapitalizeStart: true,
  };

  return [
    ...splitSegmentOnSentenceBoundary(left),
    ...splitSegmentOnSentenceBoundary(right),
  ];
}

function capitalizeFirstAlpha(text: string): string {
  const idx = text.search(/[A-Za-z]/);
  if (idx === -1) return text;
  return (
    text.slice(0, idx) + text.charAt(idx).toUpperCase() + text.slice(idx + 1)
  );
}

function maybeFixBleedingBoundary(
  left: MutableSubtitleSegment,
  right: MutableSubtitleSegment,
): boolean {
  const leftTokens = tokenizeText(left.text);
  const rightTokens = tokenizeText(right.text);
  if (leftTokens.length < 3 || rightTokens.length === 0) return false;
  if (isSentenceEnd(leftTokens[leftTokens.length - 1])) return false;

  const rightStartNorm = normalizeToken(rightTokens[0]);
  if (!DEPENDENT_STARTER_WORDS.has(rightStartNorm)) return false;

  const movedToken = leftTokens.pop();
  if (!movedToken || leftTokens.length === 0) return false;

  rightTokens.unshift(movedToken);
  left.text = formatCueText(leftTokens);
  right.text = formatCueText(rightTokens);
  right.forceCapitalizeStart = true;

  const leftDuration = Math.max(0, left.end - left.start);
  const estimatedMovedDuration = leftDuration / (leftTokens.length + 1);
  const shift = Math.min(MAX_REFINEMENT_ADJUST_SEC, estimatedMovedDuration);

  const originalBoundary = left.end;
  const newBoundary = Math.max(
    left.start + MIN_SEGMENT_DURATION_SEC,
    originalBoundary - shift,
  );

  left.end = newBoundary;
  right.start = Math.max(
    left.end,
    right.start - (originalBoundary - newBoundary),
  );
  return true;
}

function enforceChronologicalTiming(segments: MutableSubtitleSegment[]): void {
  if (segments.length === 0) return;

  segments[0].start = Math.max(0, segments[0].start);
  segments[0].end = Math.max(segments[0].start, segments[0].end);

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const current = segments[i];
    current.start = Math.max(prev.end, current.start);
    if (current.end < current.start) {
      current.end = current.start;
    }

    const gap = current.start - prev.end;
    if (gap > 0 && gap < MICRO_GAP_SNAP_SEC) {
      current.start = prev.end;
      if (current.end < current.start) {
        current.end = current.start;
      }
    }
  }
}

/**
 * Refine already segmented subtitles while preserving exact word order and count.
 * This pass addresses subtle sentence-boundary issues and bleeding-word boundaries,
 * with minimal timing changes (max 0.2s per boundary adjustment).
 */
export function refineSubtitleSegments(opts: {
  segments: SubtitleSegment[];
}): SubtitleSegment[] {
  const original = normalizeSegments(opts.segments);
  if (original.length === 0) return [];

  let refined = original.flatMap((segment) =>
    splitSegmentOnSentenceBoundary({ ...segment }),
  );

  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let i = 0; i < refined.length - 1; i++) {
      changed = maybeFixBleedingBoundary(refined[i], refined[i + 1]) || changed;
    }
    if (!changed) break;
  }

  refined = refined.filter((segment) => tokenizeText(segment.text).length > 0);

  for (let i = 0; i < refined.length; i++) {
    const current = refined[i];
    if (!current.forceCapitalizeStart) continue;
    current.text = capitalizeFirstAlpha(current.text);
  }

  enforceChronologicalTiming(refined);

  const output: SubtitleSegment[] = refined.map((segment) => {
    const text = formatCueText(tokenizeText(segment.text));
    const start = Math.max(0, segment.start);
    const end = Math.max(start, segment.end);
    return { text, start, end };
  });

  const originalSequence = collectWordSequence(original);
  const refinedSequence = collectWordSequence(output);
  if (
    originalSequence.length !== refinedSequence.length ||
    originalSequence.some(
      (word, idx) =>
        canonicalWordIdentity(word) !==
        canonicalWordIdentity(refinedSequence[idx]),
    )
  ) {
    return original.map((segment) => ({
      text: segment.text,
      start: segment.start,
      end: segment.end,
    }));
  }

  return output;
}

/**
 * Convert raw word-level timestamps to subtitle segments.
 * The returned list is strict JSON-friendly and follows these priorities:
 * sentence boundary -> gap break -> max words -> duration constraints.
 */
export function segmentWordTimestamps(opts: {
  words: WordSpan[];
  transcriptText?: string;
}): SubtitleSegment[] {
  const words = normalizeWords(opts.words);
  if (words.length === 0) return [];

  const sentenceHints = deriveTranscriptSentenceHints(
    words,
    opts.transcriptText,
  );

  let ranges = buildInitialRanges(words, sentenceHints);
  ranges = splitOverlongRanges(ranges, words);

  // A couple passes improve readability while preserving higher-priority breaks.
  for (let pass = 0; pass < 2; pass++) {
    ranges = mergeShortRangesByWordCount(ranges);
    ranges = mergeShortRangesByDuration(ranges, words);
    ranges = splitOverlongRanges(ranges, words);
  }

  const segments: SubtitleSegment[] = [];
  let lastEnd = 0;

  for (const range of ranges) {
    const cueWords = words.slice(range.startIdx, range.endIdx + 1);
    if (cueWords.length === 0) continue;

    const start = Math.max(lastEnd, cueWords[0].start);
    let end = Math.max(start, cueWords[cueWords.length - 1].end);
    if (end < start) end = start;

    const text = formatCueText(cueWords.map((w) => w.word));
    segments.push({ text, start, end });
    lastEnd = end;
  }

  // Try to satisfy minimum on-screen time without overlapping the next cue.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = seg.end - seg.start;
    if (duration >= MIN_CUE_DURATION_SEC) continue;

    const targetEnd = seg.start + MIN_CUE_DURATION_SEC;
    const hardCap = seg.start + MAX_CUE_DURATION_SEC;

    if (i < segments.length - 1) {
      seg.end = Math.max(
        seg.end,
        Math.min(targetEnd, hardCap, segments[i + 1].start),
      );
    } else {
      seg.end = Math.max(seg.end, Math.min(targetEnd, hardCap));
    }
  }

  return refineSubtitleSegments({ segments });
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
 * Word-accurate SRT from Whisper output with sentence-aware segmentation.
 */
export async function generateSrtFromWords(opts: {
  words: WordSpan[];
  outputPath: string;
  transcriptText?: string;
}): Promise<void> {
  const segments = segmentWordTimestamps({
    words: opts.words,
    transcriptText: opts.transcriptText,
  });

  const lines: string[] = [];

  segments.forEach((segment, idx) => {
    lines.push(String(idx + 1));
    lines.push(
      `${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}`,
    );
    lines.push(segment.text);
    lines.push("");
  });

  await writeFile(opts.outputPath, lines.join("\n"), "utf-8");
}
