import axios from "axios";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("memory");

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedViaPython(text: string): Promise<number[]> {
  const { data } = await axios.post<{
    model: string;
    dims: number;
    embedding: number[];
  }>(`${env.AI_SERVICE_URL}/embeddings`, { text }, { timeout: 30_000 });
  return data.embedding;
}

export async function computeEmbedding(text: string): Promise<number[]> {
  return embedViaPython(text);
}

function tagFromPerformance(p: number): string {
  return p >= 0.8 ? "strong" : p >= 0.45 ? "mid" : "weak";
}

// All CTR values flowing through this module are in percent form (0–100) —
// normalized at ingestion in youtubeAnalytics.ts. If you change the source
// units, update these constants too.
function normalizePerformance(
  ctr: number | null,
  avgViewPercentage: number | null,
): number {
  // 10% CTR ceilings out the ctr component; 100% avp ceilings out the avp one.
  const ctrScore = ctr == null ? 0 : Math.min(1, ctr / 10);
  const avpScore =
    avgViewPercentage == null ? 0 : Math.min(1, avgViewPercentage / 100);
  return 0.6 * ctrScore + 0.4 * avpScore;
}

// Low bar: keeps obvious failures out of memory but lets marginal runs through
// so the feedback signal survives sparse data.
const ADMISSION_VIEWS_MIN = 10;
const ADMISSION_CTR_MIN = 2.0; // 2% CTR (percent form — see note above)
const SIMILARITY_FLOOR = 0.15;

// =====================================================
// Duplicate-topic guard (separate from the memory store)
// =====================================================

// Cosine-similarity threshold for calling a newly generated topic a "duplicate".
// 0.85 is tight enough that near-identical titles trip but paraphrases of
// different ideas don't.
const DUPLICATE_SIM_THRESHOLD = 0.85;

export type DuplicateHit = {
  runId: string;
  title: string;
  angle: string;
  similarity: number;
};

/**
 * Check whether a freshly generated topic matches any past topic closely.
 * Returns the closest match above the threshold, or null.
 */
export async function findDuplicateTopic(
  title: string,
  angle: string,
  excludeRunId: string,
): Promise<DuplicateHit | null> {
  const past = await prisma.topic.findMany({
    where: {
      NOT: { runId: excludeRunId },
      // Only compare against topics that actually have embeddings persisted
      // (older runs from before the column existed will skip cleanly).
      titleEmbedding: { isEmpty: false },
    },
    select: {
      runId: true,
      title: true,
      angle: true,
      titleEmbedding: true,
    },
    take: 500,
    orderBy: { createdAt: "desc" },
  });
  if (past.length === 0) return null;

  let queryVec: number[];
  try {
    queryVec = await computeEmbedding(`${title}. ${angle}`);
  } catch (err) {
    log.warn({ err }, "embedding failed — skipping duplicate check");
    return null;
  }

  let best: DuplicateHit | null = null;
  for (const p of past) {
    const sim = cosine(queryVec, p.titleEmbedding);
    if (sim >= DUPLICATE_SIM_THRESHOLD && (!best || sim > best.similarity)) {
      best = {
        runId: p.runId,
        title: p.title,
        angle: p.angle,
        similarity: sim,
      };
    }
  }
  if (best) {
    log.info(
      { title, match: best.title, sim: best.similarity.toFixed(3) },
      "duplicate topic detected",
    );
  }
  return best;
}

/**
 * Computes + returns the embedding for a newly persisted Topic so the caller
 * can store it on the Topic row. Returns [] on failure so the pipeline isn't
 * blocked — dedup just won't trigger against runs missing embeddings.
 */
export async function embedTopicForDedup(
  title: string,
  angle: string,
): Promise<number[]> {
  try {
    return await computeEmbedding(`${title}. ${angle}`);
  } catch (err) {
    log.warn({ err }, "topic embedding failed — storing empty embedding");
    return [];
  }
}

// =====================================================
// Topic memory
// =====================================================

export type PastTopic = {
  topic_title: string;
  topic_angle: string;
  performance_tag: string | null;
  views: number | null;
  ctr: number | null;
  avg_view_pct: number | null;
};

export async function retrievePastTopics(
  niche: string,
  limit = 3,
): Promise<PastTopic[]> {
  const all = await prisma.topicMemory.findMany({
    take: 500,
    orderBy: { createdAt: "desc" },
  });
  if (all.length === 0) {
    log.debug("topic memory empty");
    return [];
  }

  let queryVec: number[];
  try {
    queryVec = await computeEmbedding(niche);
  } catch (err) {
    log.warn({ err }, "embedding failed — skipping topic retrieval");
    return [];
  }

  const scored = all
    .map((m) => ({ m, sim: cosine(queryVec, m.embedding) }))
    .filter((r) => r.sim > SIMILARITY_FLOOR)
    .sort((a, b) =>
      b.sim === a.sim ? b.m.performance - a.m.performance : b.sim - a.sim,
    )
    .slice(0, limit);

  log.info(
    { niche, candidates: all.length, returned: scored.length },
    "topic memory retrieval",
  );

  return scored.map(({ m }) => ({
    topic_title: m.topicTitle,
    topic_angle: m.topicAngle,
    performance_tag: tagFromPerformance(m.performance),
    views: m.views,
    ctr: m.ctr,
    avg_view_pct: m.avgViewPct,
  }));
}

export type MemoryAdmissionInput = {
  runId: string;
  niche: string;
  topicTitle: string;
  topicAngle: string;
  metrics: {
    views: number | null;
    ctr: number | null;
    avgViewPercentage: number | null;
  };
};

export async function maybeAdmitToMemory(
  input: MemoryAdmissionInput,
): Promise<boolean> {
  const { views, ctr, avgViewPercentage } = input.metrics;
  if (
    views == null ||
    views < ADMISSION_VIEWS_MIN ||
    ctr == null ||
    ctr < ADMISSION_CTR_MIN
  ) {
    log.info(
      { runId: input.runId, views, ctr },
      "topic memory admission rejected",
    );
    return false;
  }

  const performance = normalizePerformance(ctr, avgViewPercentage);
  const embedSource = `${input.topicTitle}. ${input.topicAngle}`;
  let embedding: number[];
  try {
    embedding = await computeEmbedding(embedSource);
  } catch (err) {
    log.error({ err, runId: input.runId }, "topic embedding failed");
    return false;
  }

  await prisma.topicMemory.upsert({
    where: { runId: input.runId },
    create: {
      runId: input.runId,
      niche: input.niche,
      topicTitle: input.topicTitle,
      topicAngle: input.topicAngle,
      ctr,
      views,
      avgViewPct: avgViewPercentage,
      performance,
      embedding,
    },
    update: {
      ctr,
      views,
      avgViewPct: avgViewPercentage,
      performance,
      embedding,
    },
  });

  log.info(
    { runId: input.runId, performance: performance.toFixed(3) },
    "admitted to TopicMemory",
  );
  return true;
}

// =====================================================
// Hook memory
// =====================================================

export type PastHook = {
  hook_text: string;
  topic_title: string;
  performance_tag: string | null;
  ctr: number | null;
  avg_view_pct: number | null;
};

/**
 * Retrieve top-K hooks from past runs whose topic is similar to the current topic.
 * Embedding key = topic title + angle (same as topic retrieval), because a hook
 * only makes sense in the context of its topic — we want "hooks that worked for
 * similar topics", not "hooks with similar words".
 */
export async function retrievePastHooks(
  topicTitle: string,
  topicAngle: string,
  limit = 3,
): Promise<PastHook[]> {
  const all = await prisma.hookMemory.findMany({
    take: 500,
    orderBy: { createdAt: "desc" },
  });
  if (all.length === 0) {
    log.debug("hook memory empty");
    return [];
  }

  let queryVec: number[];
  try {
    queryVec = await computeEmbedding(`${topicTitle}. ${topicAngle}`);
  } catch (err) {
    log.warn({ err }, "embedding failed — skipping hook retrieval");
    return [];
  }

  const scored = all
    .map((m) => ({ m, sim: cosine(queryVec, m.embedding) }))
    .filter((r) => r.sim > SIMILARITY_FLOOR)
    .sort((a, b) =>
      b.sim === a.sim ? b.m.performance - a.m.performance : b.sim - a.sim,
    )
    .slice(0, limit);

  log.info(
    { topicTitle, candidates: all.length, returned: scored.length },
    "hook memory retrieval",
  );

  return scored.map(({ m }) => ({
    hook_text: m.hookText,
    topic_title: m.topicTitle,
    performance_tag: tagFromPerformance(m.performance),
    ctr: m.ctr,
    avg_view_pct: m.avgViewPct,
  }));
}

export type HookAdmissionInput = {
  runId: string;
  niche: string;
  topicTitle: string;
  topicAngle: string;
  hookText: string;
  forceAdmission?: boolean;
  replayRate?: number | null;
  metrics: {
    views: number | null;
    ctr: number | null;
    avgViewPercentage: number | null;
  };
};

export async function maybeAdmitHookToMemory(
  input: HookAdmissionInput,
): Promise<boolean> {
  const { views, ctr, avgViewPercentage } = input.metrics;
  const forceAdmission = input.forceAdmission === true;
  if (
    !forceAdmission &&
    (views == null ||
      views < ADMISSION_VIEWS_MIN ||
      ctr == null ||
      ctr < ADMISSION_CTR_MIN)
  ) {
    log.info(
      { runId: input.runId, views, ctr },
      "hook memory admission rejected",
    );
    return false;
  }

  let performance = normalizePerformance(ctr, avgViewPercentage);
  if (input.replayRate != null && input.replayRate > 0) {
    performance += Math.min(1, input.replayRate) * 0.2;
  }
  performance = Math.min(1.5, performance);

  let embedding: number[];
  try {
    embedding = await computeEmbedding(
      `${input.topicTitle}. ${input.topicAngle}`,
    );
  } catch (err) {
    log.error({ err, runId: input.runId }, "hook embedding failed");
    return false;
  }

  await prisma.hookMemory.upsert({
    where: { runId: input.runId },
    create: {
      runId: input.runId,
      niche: input.niche,
      topicTitle: input.topicTitle,
      hookText: input.hookText,
      ctr,
      views,
      avgViewPct: avgViewPercentage,
      performance,
      embedding,
    },
    update: {
      hookText: input.hookText,
      ctr,
      views,
      avgViewPct: avgViewPercentage,
      performance,
      embedding,
    },
  });

  log.info(
    {
      runId: input.runId,
      performance: performance.toFixed(3),
      forceAdmission,
      replayRate: input.replayRate,
    },
    "admitted to HookMemory",
  );
  return true;
}
