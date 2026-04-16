import { prisma } from "../db/prisma";
import { uploadQueue } from "../queues/uploadQueue";
import { scoped } from "../lib/logger";

const log = scoped("upload-svc");

export class UploadServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function normalizeScheduledAt(scheduledAt?: Date | null): Date | null {
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
    return null;
  }
  return scheduledAt.getTime() > Date.now() ? scheduledAt : null;
}

function queueDelayMs(scheduledAt: Date | null): number {
  if (!scheduledAt) return 0;
  return Math.max(0, scheduledAt.getTime() - Date.now());
}

export async function enqueueUpload(
  runId: string,
  privacy: "PRIVATE" | "UNLISTED" | "PUBLIC",
  scheduledAt?: Date,
) {
  const effectiveSchedule = normalizeScheduledAt(scheduledAt);
  const delayMs = queueDelayMs(effectiveSchedule);

  const run = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    include: { video: true, upload: true },
  });
  if (!run) throw new UploadServiceError("NOT_FOUND", "run not found");
  if (run.status !== "COMPLETED" || !run.video) {
    throw new UploadServiceError(
      "RUN_NOT_READY",
      `run is ${run.status} — upload requires COMPLETED run with a rendered video`,
    );
  }

  const account = await prisma.youTubeAccount.findUnique({
    where: { id: "default" },
  });
  if (!account) {
    throw new UploadServiceError(
      "NOT_CONNECTED",
      "connect a YouTube account first at /auth/youtube",
    );
  }

  // If an upload already exists and isn't terminal-failed, don't double-queue.
  if (run.upload) {
    if (run.upload.status === "COMPLETED") {
      return run.upload;
    }
    if (run.upload.status === "PENDING" || run.upload.status === "RUNNING") {
      return run.upload;
    }
    // FAILED → reset and retry.
    const reset = await prisma.youTubeUpload.update({
      where: { runId },
      data: {
        status: "PENDING",
        privacy,
        errorMessage: null,
        youtubeVideoId: null,
        videoUrl: null,
        startedAt: null,
        completedAt: null,
      },
    });
    await uploadQueue.add(
      "upload",
      { runId, uploadId: reset.id },
      {
        jobId: reset.id,
        delay: delayMs,
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    );
    log.info(
      {
        runId,
        uploadId: reset.id,
        scheduledAt: effectiveSchedule?.toISOString() ?? null,
      },
      "upload re-enqueued",
    );
    return reset;
  }

  const created = await prisma.youTubeUpload.create({
    data: {
      runId,
      status: "PENDING",
      privacy,
    },
  });
  await uploadQueue.add(
    "upload",
    { runId, uploadId: created.id },
    {
      jobId: created.id,
      delay: delayMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
  log.info(
    {
      runId,
      uploadId: created.id,
      scheduledAt: effectiveSchedule?.toISOString() ?? null,
    },
    "upload enqueued",
  );
  return created;
}

export async function getUpload(runId: string) {
  return prisma.youTubeUpload.findUnique({ where: { runId } });
}
