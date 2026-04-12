import { prisma } from "../db/prisma";
import { videoQueue } from "../queues/videoQueue";
import { scoped } from "../lib/logger";

const log = scoped("pipeline-svc");

export async function createPipelineRun(niche: string) {
  const run = await prisma.pipelineRun.create({
    data: { niche, stage: "QUEUED", status: "QUEUED" },
  });
  log.info({ runId: run.id, niche }, "run created");

  await videoQueue.add(
    "run-pipeline",
    { runId: run.id },
    {
      jobId: run.id,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    }
  );
  log.info({ runId: run.id }, "job enqueued");

  return run;
}

export async function getPipelineRun(id: string) {
  return prisma.pipelineRun.findUnique({
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
}

export class PipelineServiceError extends Error {
  constructor(public code: string, message: string) {
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
      `run is ${run.status} — nothing to retry`
    );
  }
  if (run.status === "COMPLETED") {
    throw new PipelineServiceError(
      "ALREADY_DONE",
      "run already completed — nothing to retry"
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
    }
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
