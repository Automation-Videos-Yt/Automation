import cron from "node-cron";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("cron.analytics");

// Use the same channel BullMQ uses on the API side. Reusing the queue name
// means whichever worker is available picks up the job.
const ENRICHMENT_QUEUE = "enrichmentQueue";

export function startAnalyticsSyncCron() {
  const expr = env.ANALYTICS_SYNC_CRON.trim();
  if (!expr) {
    log.info("ANALYTICS_SYNC_CRON is empty — scheduler disabled");
    return;
  }
  if (!cron.validate(expr)) {
    log.warn({ expr }, "invalid cron expression — scheduler not started");
    return;
  }

  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(ENRICHMENT_QUEUE, { connection });

  log.info({ expr }, "analytics sync cron scheduled");

  cron.schedule(expr, async () => {
    try {
      const uploads = await prisma.youTubeUpload.findMany({
        where: { status: "COMPLETED", youtubeVideoId: { not: null } },
        select: { runId: true },
        orderBy: { createdAt: "desc" },
        take: 500, // sanity cap — nobody uploads > 500/day to one channel
      });

      if (uploads.length === 0) {
        log.info("tick — no uploaded runs to enrich");
        return;
      }

      const now = Date.now();
      for (const u of uploads) {
        await queue.add(
          "enrich",
          { runId: u.runId },
          {
            jobId: `enrich-${u.runId}-cron-${now}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: { count: 200 },
            removeOnFail: { count: 200 },
          }
        );
      }
      log.info({ queued: uploads.length }, "tick — enrichment jobs enqueued");
    } catch (err) {
      log.error({ err }, "cron tick failed");
    }
  });
}
