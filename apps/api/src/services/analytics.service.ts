import { prisma } from "../db/prisma";
import { enrichmentQueue } from "../queues/enrichmentQueue";
import { scoped } from "../lib/logger";
export { getOperationsMetrics } from "./operations-metrics.service";

const log = scoped("analytics-svc");

export class AnalyticsServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Enqueue enrichment jobs for every run that has a COMPLETED upload.
 * Idempotent — rerunning just refreshes the data.
 */
export async function syncAllAnalytics(): Promise<{ queued: number }> {
  const account = await prisma.youTubeAccount.findUnique({
    where: { id: "default" },
  });
  if (!account) {
    throw new AnalyticsServiceError(
      "NOT_CONNECTED",
      "connect a YouTube account first at /auth/youtube"
    );
  }

  const uploads = await prisma.youTubeUpload.findMany({
    where: { status: "COMPLETED", youtubeVideoId: { not: null } },
    select: { runId: true },
    orderBy: { createdAt: "desc" },
  });

  for (const u of uploads) {
    await enrichmentQueue.add(
      "enrich",
      { runId: u.runId },
      {
        jobId: `enrich-${u.runId}-${Date.now()}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      }
    );
  }

  log.info({ queued: uploads.length }, "analytics sync enqueued");
  return { queued: uploads.length };
}

/**
 * Enqueue enrichment for a single run.
 */
export async function syncRunAnalytics(runId: string): Promise<void> {
  const upload = await prisma.youTubeUpload.findUnique({ where: { runId } });
  if (!upload || upload.status !== "COMPLETED" || !upload.youtubeVideoId) {
    throw new AnalyticsServiceError(
      "UPLOAD_NOT_READY",
      "run must have a completed YouTube upload before analytics can be fetched"
    );
  }
  await enrichmentQueue.add(
    "enrich",
    { runId },
    {
      jobId: `enrich-${runId}-${Date.now()}`,
      attempts: 1,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    }
  );
  log.info({ runId }, "single-run enrichment enqueued");
}

export async function getRunAnalytics(runId: string) {
  const [latest, history, feedback] = await Promise.all([
    prisma.videoAnalytics.findFirst({
      where: { runId },
      orderBy: { snapshotAt: "desc" },
    }),
    prisma.videoAnalytics.findMany({
      where: { runId },
      orderBy: { snapshotAt: "asc" },
      take: 30,
    }),
    prisma.feedbackInsight.findUnique({ where: { runId } }),
  ]);
  return { latest, history, feedback };
}
