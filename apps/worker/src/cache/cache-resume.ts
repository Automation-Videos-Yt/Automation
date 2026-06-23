import { stat } from "node:fs/promises";
import { prisma } from "../db/prisma";
import { scoped } from "../lib/logger";

const log = scoped("cache");

// Shapes matching the agent outputs so a cache hit is drop-in for the live path.

export type CachedTopic = {
  title: string;
  angle: string;
  rationale: string;
  trend_score: number;
};

export type CachedScript = {
  hook: string;
  body: string;
  cta: string;
  word_count: number;
  duration_estimate_sec: number;
};

export type CachedHook = {
  winning_hook: string;
  hook_score: number;
  generation_count: number;
};

export type CachedPrediction = {
  predicted_ctr: number;
  predicted_retention: number;
  score: number;
  reasoning: string;
};

export type CachedVoice = {
  audio_path: string;
  duration_sec: number;
  voice_id: string;
};

export type CachedTimestamp = {
  total_duration_sec: number;
  words: { word: string; start: number; end: number }[];
  scenes: { index: number; start: number; end: number; text: string }[];
};

export type CachedSelectedClip = {
  index: number;
  start: number;
  end: number;
  text: string;
  query: string;
  clip_url: string | null;
  clip_source: string | null;
  clip_duration_sec: number | null;
  provider_id: string | null;
};

export type CachedVideoSelection = { scenes: CachedSelectedClip[] };

export type CachedVideoMeta = {
  title: string;
  description: string;
  tags: string[];
};

// ---- File checks ----

export async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

// ---- DB-backed cache loaders ----

export async function loadTopic(runId: string): Promise<CachedTopic | null> {
  const t = await prisma.topic.findUnique({ where: { runId } });
  if (!t) return null;
  log.info({ runId, title: t.title }, "topic cache HIT");
  return {
    title: t.title,
    angle: t.angle,
    rationale: t.rationale,
    trend_score: t.trendScore,
  };
}

export async function loadScript(runId: string): Promise<CachedScript | null> {
  const s = await prisma.script.findUnique({ where: { runId } });
  if (!s) return null;
  log.info({ runId }, "script cache HIT");
  return {
    hook: s.hook,
    body: s.body,
    cta: s.cta,
    word_count: s.wordCount,
    duration_estimate_sec: s.durationEstimateSec,
  };
}

export async function loadHook(runId: string): Promise<CachedHook | null> {
  const log_row = await prisma.agentLog.findFirst({
    where: { runId, agent: "hook", status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
  });
  if (!log_row?.outputJson) return null;
  const json = log_row.outputJson as unknown as CachedHook;
  if (!json?.winning_hook) return null;
  log.info({ runId, score: json.hook_score }, "hook cache HIT");
  return json;
}

export async function loadPrediction(
  runId: string
): Promise<CachedPrediction | null> {
  const p = await prisma.performancePrediction.findUnique({ where: { runId } });
  if (!p) return null;
  log.info({ runId, score: p.score }, "prediction cache HIT");
  return {
    predicted_ctr: p.predictedCtr,
    predicted_retention: p.predictedRetention,
    score: p.score,
    reasoning: p.reasoning,
  };
}

export async function loadVoice(runId: string): Promise<CachedVoice | null> {
  const v = await prisma.voiceAsset.findUnique({ where: { runId } });
  if (!v) return null;
  if (!(await fileExists(v.audioPath))) {
    log.warn({ runId, path: v.audioPath }, "voice row exists but audio file missing — rerunning");
    return null;
  }
  log.info({ runId }, "voice cache HIT");
  return {
    audio_path: v.audioPath,
    duration_sec: v.durationSec,
    voice_id: v.voiceId,
  };
}

/**
 * Timestamp output isn't a first-class table — we read the last successful
 * AgentLog entry. This avoids a schema migration while still supporting resume.
 */
export async function loadTimestamp(
  runId: string
): Promise<CachedTimestamp | null> {
  const log_row = await prisma.agentLog.findFirst({
    where: { runId, agent: "timestamp", status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
  });
  if (!log_row?.outputJson) return null;
  const json = log_row.outputJson as unknown as CachedTimestamp;
  if (!json?.words || !Array.isArray(json.words)) return null;
  log.info(
    { runId, words: json.words.length, scenes: json.scenes?.length ?? 0 },
    "timestamp cache HIT"
  );
  return json;
}

export async function loadVideoSelection(
  runId: string
): Promise<CachedVideoSelection | null> {
  const rows = await prisma.scene.findMany({
    where: { runId },
    orderBy: { index: "asc" },
  });
  if (rows.length === 0) return null;
  log.info({ runId, scenes: rows.length }, "video_selection cache HIT");
  return {
    scenes: rows.map((r) => ({
      index: r.index,
      start: r.startSec,
      end: r.endSec,
      text: r.text,
      query: r.query ?? "",
      clip_url: r.clipUrl,
      clip_source: r.clipSource,
      clip_duration_sec: r.clipDurationSec,
      provider_id: null,
    })),
  };
}

export async function loadVideoMeta(
  runId: string
): Promise<CachedVideoMeta | null> {
  const v = await prisma.video.findUnique({ where: { runId } });
  if (!v || !v.title) return null;
  log.info({ runId }, "video_meta cache HIT");
  return {
    title: v.title,
    description: v.description ?? "",
    tags: v.tags,
  };
}

export async function loadFinalVideoPath(
  runId: string
): Promise<string | null> {
  const v = await prisma.video.findUnique({ where: { runId } });
  if (!v || !v.videoPath) return null;
  if (!(await fileExists(v.videoPath))) {
    log.warn({ runId, path: v.videoPath }, "video row exists but file missing — rerunning render");
    return null;
  }
  log.info({ runId }, "final video cache HIT");
  return v.videoPath;
}
