import { prisma } from "../db/prisma";
import { uploadQueue } from "../queues/uploadQueue";
import { scoped } from "../lib/logger";

const log = scoped("auto-upload");

type UploadPrivacy = "PRIVATE" | "UNLISTED" | "PUBLIC";

export async function enqueueAutoUploadForRun(
  runId: string,
  privacy: UploadPrivacy,
): Promise<void> {
  const run = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    include: { video: true, upload: true },
  });

  if (!run) {
    log.warn({ runId }, "auto-upload skipped: run not found");
    return;
  }

  if (run.status !== "COMPLETED" || !run.video) {
    log.info(
      { runId, status: run.status, hasVideo: !!run.video },
      "auto-upload skipped: run not ready",
    );
    return;
  }

  const account = await prisma.youTubeAccount.findUnique({
    where: { id: "default" },
  });
  if (!account) {
    log.info({ runId }, "auto-upload skipped: youtube not connected");
    return;
  }

  if (run.upload) {
    if (run.upload.status === "COMPLETED") {
      log.info(
        { runId, uploadId: run.upload.id },
        "auto-upload skipped: already completed",
      );
      return;
    }

    if (run.upload.status === "PENDING" || run.upload.status === "RUNNING") {
      log.info(
        { runId, uploadId: run.upload.id },
        "auto-upload skipped: already queued/running",
      );
      return;
    }

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
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    );

    log.info({ runId, uploadId: reset.id, privacy }, "auto-upload re-enqueued");
    return;
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
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );

  log.info({ runId, uploadId: created.id, privacy }, "auto-upload enqueued");
}
