import { prisma } from "../db/prisma";
import { scoped } from "../lib/logger";
import { publishRunEvent } from "../events/publisher";
import { uploadToYouTube } from "./youtubeClient";

const USER_CANCELLED_MESSAGE = "cancelled by user";

function isUserCancelledRun(errorMessage?: string | null): boolean {
  return (errorMessage ?? "").toLowerCase().includes(USER_CANCELLED_MESSAGE);
}

export async function runUpload(uploadId: string): Promise<void> {
  const log = scoped("upload", uploadId);
  const upload = await prisma.youTubeUpload.findUnique({
    where: { id: uploadId },
    include: { run: { include: { video: true } } },
  });
  if (!upload) {
    log.error("upload not found");
    throw new Error(`upload ${uploadId} not found`);
  }

  if (upload.status !== "PENDING") {
    log.info(
      { status: upload.status },
      "upload skipped: stale non-pending job",
    );
    return;
  }

  if (
    upload.run.status === "FAILED" &&
    isUserCancelledRun(upload.run.errorMessage)
  ) {
    await prisma.youTubeUpload.update({
      where: { id: uploadId },
      data: {
        status: "FAILED",
        errorMessage: USER_CANCELLED_MESSAGE,
        completedAt: new Date(),
      },
    });
    publishRunEvent(upload.runId, "upload", {
      status: "FAILED",
      reason: "run_cancelled",
    });
    log.info("upload skipped: run cancelled");
    return;
  }

  if (!upload.run.video) {
    const msg = "run has no rendered video";
    log.error(msg);
    await prisma.youTubeUpload.update({
      where: { id: uploadId },
      data: { status: "FAILED", errorMessage: msg, completedAt: new Date() },
    });
    throw new Error(msg);
  }

  await prisma.youTubeUpload.update({
    where: { id: uploadId },
    data: { status: "RUNNING", startedAt: new Date(), errorMessage: null },
  });
  publishRunEvent(upload.runId, "upload", { status: "RUNNING" });
  log.info(
    {
      runId: upload.runId,
      privacy: upload.privacy,
      videoPath: upload.run.video.videoPath,
    },
    "upload start",
  );

  try {
    const v = upload.run.video;
    const { videoId, videoUrl } = await uploadToYouTube({
      videoPath: v.videoPath,
      thumbnailPath: v.thumbnailPath,
      title: v.title ?? upload.run.niche,
      description: v.description ?? "",
      tags: v.tags,
      defaultLanguage: upload.run.languageCode,
      defaultAudioLanguage: upload.run.languageCode,
      privacyStatus: upload.privacy.toLowerCase() as
        | "private"
        | "unlisted"
        | "public",
    });

    await prisma.youTubeUpload.update({
      where: { id: uploadId },
      data: {
        status: "COMPLETED",
        youtubeVideoId: videoId,
        videoUrl,
        completedAt: new Date(),
      },
    });
    publishRunEvent(upload.runId, "upload", { status: "COMPLETED", videoId });
    log.info({ videoId, videoUrl }, "upload complete");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, "upload failed");
    await prisma.youTubeUpload.update({
      where: { id: uploadId },
      data: {
        status: "FAILED",
        errorMessage: message,
        completedAt: new Date(),
      },
    });
    publishRunEvent(upload.runId, "upload", { status: "FAILED" });
    throw err;
  }
}
