import { prisma } from "../db/prisma";
import { videoQueue } from "../queues/videoQueue";
import { estimateRunCost } from "./cost.service";
import { scoped } from "../lib/logger";

const log = scoped("pipeline-svc");

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
) {
  const normalizedLanguageCodes = normalizeLanguageCodes(languageCodes);
  const runs = [];
  for (let i = 0; i < count; i++) {
    for (const languageCode of normalizedLanguageCodes) {
      runs.push(await createPipelineRun(niche, durationSec, languageCode));
    }
  }
  log.info(
    {
      niche,
      count,
      languageCodes: normalizedLanguageCodes,
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
) {
  const normalizedLanguageCode =
    normalizeLanguageCodes([languageCode])[0] ?? "en";
  const run = await prisma.pipelineRun.create({
    data: {
      niche,
      languageCode: normalizedLanguageCode,
      targetDurationSec: durationSec,
      stage: "QUEUED",
      status: "QUEUED",
    },
  });
  log.info(
    {
      runId: run.id,
      niche,
      durationSec,
      languageCode: normalizedLanguageCode,
    },
    "run created",
  );

  await videoQueue.add(
    "run-pipeline",
    { runId: run.id },
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
