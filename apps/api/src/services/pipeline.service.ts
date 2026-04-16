import { prisma } from "../db/prisma";
import { videoQueue } from "../queues/videoQueue";
import { estimateRunCost } from "./cost.service";
import { scoped } from "../lib/logger";

const log = scoped("pipeline-svc");

export type RunFeatures = {
  enableTimestamp: boolean;
  enableSubtitles: boolean;
  enableThumbnail: boolean;
  enableHookVariants: boolean;
};

const DEFAULT_RUN_FEATURES: RunFeatures = {
  enableTimestamp: true,
  enableSubtitles: true,
  enableThumbnail: true,
  enableHookVariants: true,
};

function normalizeRunFeatures(features?: Partial<RunFeatures>): RunFeatures {
  const next: RunFeatures = {
    ...DEFAULT_RUN_FEATURES,
    ...(features ?? {}),
  };
  if (!next.enableTimestamp) {
    next.enableSubtitles = false;
  }
  return next;
}

export type HookExperimentRun = {
  runId: string;
  hookText: string | null;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  stage:
    | "QUEUED"
    | "TOPIC"
    | "SCRIPT"
    | "HOOK"
    | "PREDICTION"
    | "VOICE"
    | "TIMESTAMP"
    | "VIDEO_SELECTION"
    | "VIDEO"
    | "THUMBNAIL"
    | "DONE"
    | "FAILED";
  uploadStatus: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | null;
  videoUrl: string | null;
  views: number | null;
  avgViewPercentage: number | null;
  watchTimeMinutes: number | null;
  replayRate: number | null;
  score: number | null;
  isWinner: boolean;
};

export type HookExperimentResponse = {
  experimentId: string;
  canPickWinner: boolean;
  winnerRunId: string | null;
  runs: HookExperimentRun[];
};

function replayRateFromAvgViewPct(avgViewPercentage: number | null): number {
  if (avgViewPercentage == null) return 0;
  return Math.max(0, avgViewPercentage - 100) / 100;
}

function hookExperimentScore(
  avgViewPercentage: number | null,
  watchTimeMinutes: number | null,
  maxWatchTimeMinutes: number,
): number {
  const retentionNorm = Math.max(0, (avgViewPercentage ?? 0) / 100);
  const watchNorm =
    maxWatchTimeMinutes > 0
      ? Math.max(0, (watchTimeMinutes ?? 0) / maxWatchTimeMinutes)
      : 0;
  const replayNorm = Math.min(1, replayRateFromAvgViewPct(avgViewPercentage));
  return retentionNorm * 0.45 + watchNorm * 0.35 + replayNorm * 0.2;
}

function normalizeLanguageCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of codes) {
    const code = raw.trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized.length > 0 ? normalized : ["en"];
}

/**
 * Queue N pipeline runs per selected language in one call. Each run is
 * independent — the duplicate-topic guard in the worker helps prevent
 * two same-language batch members from landing on the same topic.
 */
export async function createPipelineBatch(
  niche: string,
  count: number,
  durationSec = 75,
  languageCodes: string[] = ["en"],
  features?: Partial<RunFeatures>,
) {
  const normalizedLanguageCodes = normalizeLanguageCodes(languageCodes);
  const normalizedFeatures = normalizeRunFeatures(features);
  const runs = [];
  for (let i = 0; i < count; i++) {
    for (const languageCode of normalizedLanguageCodes) {
      runs.push(
        await createPipelineRun(
          niche,
          durationSec,
          languageCode,
          normalizedFeatures,
        ),
      );
    }
  }
  log.info(
    {
      niche,
      count,
      languageCodes: normalizedLanguageCodes,
      features: normalizedFeatures,
      totalRuns: runs.length,
      runIds: runs.map((r) => r.id),
    },
    "batch created",
  );
  return runs;
}

export async function createPipelineRun(
  niche: string,
  durationSec = 75,
  languageCode = "en",
  features?: Partial<RunFeatures>,
) {
  const normalizedLanguageCode =
    normalizeLanguageCodes([languageCode])[0] ?? "en";
  const normalizedFeatures = normalizeRunFeatures(features);
  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.pipelineRun.create({
      data: {
        niche,
        languageCode: normalizedLanguageCode,
        targetDurationSec: durationSec,
        stage: "QUEUED",
        status: "QUEUED",
      },
    });

    return tx.pipelineRun.update({
      where: { id: created.id },
      data: { experimentId: created.id },
    });
  });
  log.info(
    {
      runId: run.id,
      niche,
      durationSec,
      languageCode: normalizedLanguageCode,
      features: normalizedFeatures,
    },
    "run created",
  );

  await videoQueue.add(
    "run-pipeline",
    { runId: run.id, features: normalizedFeatures },
    {
      jobId: run.id,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  );
  log.info({ runId: run.id }, "job enqueued");

  return run;
}

export async function getHookExperiment(
  runId: string,
): Promise<HookExperimentResponse | null> {
  const base = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    select: { id: true, experimentId: true },
  });
  if (!base) return null;

  const experimentId = base.experimentId ?? base.id;

  const runs = await prisma.pipelineRun.findMany({
    where: { experimentId },
    orderBy: { createdAt: "asc" },
    include: {
      script: { select: { hook: true } },
      upload: { select: { status: true, videoUrl: true } },
    },
  });

  const analytics = await Promise.all(
    runs.map((r) =>
      prisma.videoAnalytics.findFirst({
        where: { runId: r.id },
        orderBy: { snapshotAt: "desc" },
        select: {
          views: true,
          avgViewPercentage: true,
          watchTimeMinutes: true,
        },
      }),
    ),
  );

  const maxWatchTimeMinutes = analytics.reduce(
    (max, a) => Math.max(max, a?.watchTimeMinutes ?? 0),
    0,
  );

  const items = runs.map((r, i) => {
    const a = analytics[i];
    const score = a
      ? hookExperimentScore(
          a.avgViewPercentage,
          a.watchTimeMinutes,
          maxWatchTimeMinutes,
        )
      : null;
    const replayRate = a ? replayRateFromAvgViewPct(a.avgViewPercentage) : null;
    return {
      runId: r.id,
      hookText: r.script?.hook ?? null,
      status: r.status,
      stage: r.stage,
      uploadStatus: r.upload?.status ?? null,
      videoUrl: r.upload?.videoUrl ?? null,
      views: a?.views ?? null,
      avgViewPercentage: a?.avgViewPercentage ?? null,
      watchTimeMinutes: a?.watchTimeMinutes ?? null,
      replayRate,
      score,
      hasAnalytics: !!a,
    };
  });

  const canPickWinner = items.length > 1 && items.every((i) => i.hasAnalytics);

  let winnerRunId: string | null = null;
  if (canPickWinner) {
    const ranked = [...items].sort((a, b) => {
      const scoreA = a.score ?? -1;
      const scoreB = b.score ?? -1;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return (b.avgViewPercentage ?? 0) - (a.avgViewPercentage ?? 0);
    });
    winnerRunId = ranked[0]?.runId ?? null;
  }

  return {
    experimentId,
    canPickWinner,
    winnerRunId,
    runs: items.map((i) => ({
      runId: i.runId,
      hookText: i.hookText,
      status: i.status,
      stage: i.stage,
      uploadStatus: i.uploadStatus,
      videoUrl: i.videoUrl,
      views: i.views,
      avgViewPercentage: i.avgViewPercentage,
      watchTimeMinutes: i.watchTimeMinutes,
      replayRate: i.replayRate,
      score: i.score == null ? null : Number(i.score.toFixed(4)),
      isWinner: winnerRunId != null && i.runId === winnerRunId,
    })),
  };
}

export async function getPipelineRun(id: string) {
  const run = await prisma.pipelineRun.findUnique({
    where: { id },
    include: {
      topic: true,
      script: true,
      voiceAsset: true,
      video: true,
      hookVariants: { orderBy: { index: "asc" } },
      scenes: { orderBy: { index: "asc" } },
      upload: true,
      prediction: true,
    },
  });
  if (!run) return null;
  const cost = await estimateRunCost(id);
  return { ...run, cost };
}

export class PipelineServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resume a FAILED run from its last successful stage. Reuses every persisted
 * artifact (Topic, Script, HookVariants, Voice file, scene clips, etc.) and
 * re-enqueues the video job — the worker's cache-resume logic picks up where
 * it left off.
 */
export async function retryPipelineRun(id: string) {
  const run = await prisma.pipelineRun.findUnique({ where: { id } });
  if (!run) throw new PipelineServiceError("NOT_FOUND", "run not found");
  if (run.status === "RUNNING" || run.status === "QUEUED") {
    throw new PipelineServiceError(
      "ALREADY_RUNNING",
      `run is ${run.status} — nothing to retry`,
    );
  }
  if (run.status === "COMPLETED") {
    throw new PipelineServiceError(
      "ALREADY_DONE",
      "run already completed — nothing to retry",
    );
  }

  const updated = await prisma.pipelineRun.update({
    where: { id },
    data: { status: "QUEUED", errorMessage: null, currentAgent: null },
  });

  await videoQueue.add(
    "run-pipeline",
    { runId: id },
    {
      jobId: `${id}-retry-${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  );
  log.info({ runId: id, stage: run.stage }, "retry enqueued");
  return updated;
}

export async function listPipelineRuns(limit = 50) {
  return prisma.pipelineRun.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { video: true },
  });
}

export async function getPipelineLogs(runId: string) {
  return prisma.agentLog.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
  });
}
