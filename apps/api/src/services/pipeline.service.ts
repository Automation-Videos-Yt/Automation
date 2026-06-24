import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { videoQueue } from "../queues/videoQueue";
import { uploadQueue } from "../queues/uploadQueue";
import { estimateRunCost } from "./cost.service";
import { scoped } from "../lib/logger";
import { calculateRunCost } from "@youtube-automation/pricing";

const log = scoped("pipeline-svc");
const USER_CANCELLED_MESSAGE = "cancelled by user";

function isUserCancelledMessage(message?: string | null): boolean {
  return (message ?? "").toLowerCase().includes(USER_CANCELLED_MESSAGE);
}

async function removeQueuedJobsForRun(
  queue: typeof videoQueue | typeof uploadQueue,
  runId: string,
): Promise<number> {
  const jobs = await queue.getJobs(
    ["waiting", "delayed", "prioritized", "paused", "active"],
    0,
    -1,
    true,
  );
  let removed = 0;
  for (const job of jobs) {
    if (job.data?.runId !== runId) continue;
    try {
      await job.remove();
      removed += 1;
    } catch {
      // Active jobs cannot always be removed. The worker cooperatively exits
      // when it detects the cancellation flag in DB.
    }
  }
  return removed;
}

export type RunFeatures = {
  enableTimestamp: boolean;
  enableSubtitles: boolean;
  enableThumbnail: boolean;
  enableHookVariants: boolean;
};

export type VoiceTierOverride = "economy" | "premium" | "elite";

export type RunControlOverrides = {
  forceVoiceTier?: VoiceTierOverride;
  forceSkipThumbnail?: boolean;
  sourceAction?: string;
  iteration?: number;
};

export type StageResetPoint =
  | "TOPIC"
  | "SCRIPT"
  | "HOOK"
  | "PREDICTION"
  | "VOICE"
  | "TIMESTAMP"
  | "VIDEO_SELECTION"
  | "VIDEO"
  | "THUMBNAIL";

const STAGE_ORDER: StageResetPoint[] = [
  "TOPIC",
  "SCRIPT",
  "HOOK",
  "PREDICTION",
  "VOICE",
  "TIMESTAMP",
  "VIDEO_SELECTION",
  "VIDEO",
  "THUMBNAIL",
];

const STAGE_AGENT_FILTERS: Record<
  StageResetPoint,
  Prisma.AgentLogWhereInput[]
> = {
  TOPIC: [{ agent: { startsWith: "topic" } }],
  SCRIPT: [{ agent: "script" }],
  HOOK: [{ agent: "hook" }, { agent: "hook_ab_seed" }],
  PREDICTION: [{ agent: "prediction" }],
  VOICE: [{ agent: "voice" }],
  TIMESTAMP: [{ agent: "timestamp" }],
  VIDEO_SELECTION: [{ agent: "video_selection" }],
  VIDEO: [{ agent: "video_meta" }],
  THUMBNAIL: [{ agent: "thumbnail" }],
};

function downstreamStagesFrom(stage: StageResetPoint): StageResetPoint[] {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) return [stage];
  return STAGE_ORDER.slice(idx);
}

function agentFiltersForStages(
  stages: StageResetPoint[],
): Prisma.AgentLogWhereInput[] {
  return stages.flatMap((stage) => STAGE_AGENT_FILTERS[stage] ?? []);
}

async function resetRunArtifactsFromStage(
  tx: Prisma.TransactionClient,
  runId: string,
  stage: StageResetPoint,
): Promise<void> {
  const affected = downstreamStagesFrom(stage);

  if (affected.includes("TOPIC")) {
    await tx.topic.deleteMany({ where: { runId } });
  }
  if (affected.includes("SCRIPT")) {
    await tx.script.deleteMany({ where: { runId } });
  }
  if (affected.includes("HOOK")) {
    await tx.hookVariant.deleteMany({ where: { runId } });
  }
  if (affected.includes("PREDICTION")) {
    await tx.performancePrediction.deleteMany({ where: { runId } });
  }
  if (affected.includes("VOICE")) {
    await tx.voiceAsset.deleteMany({ where: { runId } });
  }
  if (affected.includes("VIDEO_SELECTION")) {
    await tx.scene.deleteMany({ where: { runId } });
  }

  if (affected.includes("VIDEO")) {
    await tx.video.deleteMany({ where: { runId } });
  } else if (affected.includes("THUMBNAIL")) {
    await tx.video.updateMany({
      where: { runId },
      data: { thumbnailPath: null },
    });
  }

  const agentFilters = agentFiltersForStages(affected);
  if (agentFilters.length > 0) {
    await tx.agentLog.deleteMany({
      where: {
        runId,
        OR: agentFilters,
      },
    });
  }
}

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

function validateRunFeatures(features: RunFeatures): void {
  if (features.enableSubtitles && !features.enableTimestamp) {
    throw new PipelineServiceError(
      "INVALID_FEATURES",
      "enableSubtitles=true requires enableTimestamp=true",
    );
  }
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

export async function createPipelineRun(
  userId: string,
  niche: string,
  durationSec = 75,
  languageCode = "en",
  features?: Partial<RunFeatures>,
) {
  const normalizedLanguageCode =
    normalizeLanguageCodes([languageCode])[0] ?? "en";
  const normalizedFeatures = normalizeRunFeatures(features);
  validateRunFeatures(normalizedFeatures);

  const costSnapshot = calculateRunCost({
    durationSec,
    languageCode: normalizedLanguageCode,
    generateThumbnail: normalizedFeatures.enableThumbnail,
    generateSubtitles: normalizedFeatures.enableSubtitles,
  });

  const run = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.credits < costSnapshot.total) {
      throw new PipelineServiceError("INSUFFICIENT_CREDITS", "Not enough credits");
    }

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: {
        credits: { decrement: costSnapshot.total }
      }
    });

    await tx.creditTransaction.create({
      data: {
        userId,
        amount: -costSnapshot.total,
        balanceAfter: updatedUser.credits,
        type: "VIDEO_GENERATION",
      }
    });

    const created = await tx.pipelineRun.create({
      data: {
        userId,
        niche,
        languageCode: normalizedLanguageCode,
        targetDurationSec: durationSec,
        stage: "QUEUED",
        status: "QUEUED",
        creditsCharged: costSnapshot.total,
        pricingSnapshot: costSnapshot as any,
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
    data: {
      status: "QUEUED",
      errorMessage: null,
      currentAgent: null,
      completedAt: null,
      failedStage: null,
      stageFailureReason: null,
      stageFailureMeta: Prisma.JsonNull,
    },
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

export async function requeuePipelineRunFromStage(
  id: string,
  fromStage: StageResetPoint,
  control?: RunControlOverrides,
) {
  const run = await prisma.pipelineRun.findUnique({
    where: { id },
    include: { upload: true },
  });
  if (!run) throw new PipelineServiceError("NOT_FOUND", "run not found");

  if (run.status === "RUNNING" || run.status === "QUEUED") {
    throw new PipelineServiceError(
      "ALREADY_RUNNING",
      `run is ${run.status} — cannot optimize right now`,
    );
  }

  if (run.upload?.status === "RUNNING" || run.upload?.status === "PENDING") {
    throw new PipelineServiceError(
      "UPLOAD_IN_PROGRESS",
      "run upload is in progress — wait before applying optimization actions",
    );
  }

  if (run.upload?.status === "COMPLETED") {
    throw new PipelineServiceError(
      "UPLOADED_LOCKED",
      "run already uploaded — create a new run to apply optimization actions",
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await resetRunArtifactsFromStage(tx, id, fromStage);

    return tx.pipelineRun.update({
      where: { id },
      data: {
        stage: "QUEUED",
        status: "QUEUED",
        currentAgent: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        failedStage: null,
        stageFailureReason: null,
        stageFailureMeta: Prisma.JsonNull,
        stageRetryCounts: Prisma.JsonNull,
      },
    });
  });

  await videoQueue.add(
    "run-pipeline",
    { runId: id, control },
    {
      jobId: `${id}-agentic-${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  );

  log.info({ runId: id, fromStage, control }, "agentic optimization requeued");
  return updated;
}

export async function cancelPipelineRun(id: string) {
  const run = await prisma.pipelineRun.findUnique({
    where: { id },
    include: { upload: true },
  });
  if (!run) throw new PipelineServiceError("NOT_FOUND", "run not found");

  if (run.status === "COMPLETED") {
    throw new PipelineServiceError(
      "ALREADY_DONE",
      "run already completed — cannot cancel",
    );
  }

  if (run.status === "FAILED") {
    if (isUserCancelledMessage(run.errorMessage)) {
      return run;
    }
    throw new PipelineServiceError(
      "ALREADY_DONE",
      "run already failed — cannot cancel",
    );
  }

  const [videoJobsRemoved, uploadJobsRemoved] = await Promise.all([
    removeQueuedJobsForRun(videoQueue, id),
    removeQueuedJobsForRun(uploadQueue, id),
  ]);

  if (
    run.upload &&
    (run.upload.status === "PENDING" || run.upload.status === "RUNNING")
  ) {
    await prisma.youTubeUpload.update({
      where: { runId: id },
      data: {
        status: "FAILED",
        errorMessage: USER_CANCELLED_MESSAGE,
        completedAt: new Date(),
      },
    });
  }

  const updated = await prisma.pipelineRun.update({
    where: { id },
    data: {
      stage: "FAILED",
      status: "FAILED",
      currentAgent: null,
      errorMessage: USER_CANCELLED_MESSAGE,
      completedAt: null,
      failedStage: run.stage === "FAILED" ? null : run.stage,
      stageFailureReason: USER_CANCELLED_MESSAGE,
      stageFailureMeta: {
        cancelled: true,
        videoJobsRemoved,
        uploadJobsRemoved,
      } as Prisma.InputJsonValue,
    },
  });

  log.info(
    { runId: id, videoJobsRemoved, uploadJobsRemoved },
    "run cancelled by user",
  );

  return updated;
}

export async function listPipelineRuns(limit = 50) {
  return prisma.pipelineRun.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { video: true },
  });
}

export type PipelineRunsPage = {
  items: Awaited<ReturnType<typeof listPipelineRuns>>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export async function listPipelineRunsPaginated(
  page = 1,
  pageSize = 20,
): Promise<PipelineRunsPage> {
  const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
  const requestedPage = Math.max(1, Math.floor(page));

  const total = await prisma.pipelineRun.count();
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const normalizedPage = Math.min(requestedPage, totalPages);
  const skip = (normalizedPage - 1) * safePageSize;

  const items = await prisma.pipelineRun.findMany({
    orderBy: { createdAt: "desc" },
    skip,
    take: safePageSize,
    include: { video: true },
  });

  return {
    items,
    page: normalizedPage,
    pageSize: safePageSize,
    total,
    totalPages,
  };
}

export async function getPipelineLogs(runId: string) {
  return prisma.agentLog.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
  });
}
