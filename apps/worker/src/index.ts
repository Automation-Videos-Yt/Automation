import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config/env";
import { runPipeline } from "./pipeline-runner";
import { runUpload } from "./upload/upload-runner";
import { runEnrichment } from "./enrichment/enrichment-runner";
import { startAnalyticsSyncCron } from "./cron/analytics-sync";
import { logger, scoped } from "./lib/logger";

const log = scoped("worker");

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => log.error({ err }, "redis error"));
connection.on("connect", () => log.info("redis connected"));

// ------------------------------------------------------------
// Video-generation pipeline worker
// ------------------------------------------------------------
const videoWorker = new Worker<{ runId: string }>(
  "videoQueue",
  async (job) => {
    const jobLog = scoped("worker", job.data.runId);
    jobLog.info({ jobId: job.id }, "video job picked up");
    const started = Date.now();
    try {
      await runPipeline(job.data.runId);
      jobLog.info({ jobId: job.id, durationMs: Date.now() - started }, "video job completed");
    } catch (err) {
      jobLog.error({ err, jobId: job.id, durationMs: Date.now() - started }, "video job threw");
      throw err;
    }
  },
  { connection, concurrency: env.WORKER_CONCURRENCY }
);

videoWorker.on("ready", () => log.info({ concurrency: env.WORKER_CONCURRENCY }, "videoQueue ready"));
videoWorker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, runId: job?.data?.runId, err: err.message }, "video job failed event")
);
videoWorker.on("error", (err) => log.error({ err }, "video worker error"));

// ------------------------------------------------------------
// YouTube upload worker
// ------------------------------------------------------------
const uploadWorker = new Worker<{ runId: string; uploadId: string }>(
  "uploadQueue",
  async (job) => {
    const jobLog = scoped("upload-worker", job.data.runId);
    jobLog.info({ jobId: job.id, uploadId: job.data.uploadId }, "upload job picked up");
    const started = Date.now();
    try {
      await runUpload(job.data.uploadId);
      jobLog.info({ jobId: job.id, durationMs: Date.now() - started }, "upload job completed");
    } catch (err) {
      jobLog.error({ err, jobId: job.id, durationMs: Date.now() - started }, "upload job threw");
      throw err;
    }
  },
  { connection, concurrency: 1 }
);

uploadWorker.on("ready", () => log.info("uploadQueue ready"));
uploadWorker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err: err.message }, "upload job failed event")
);
uploadWorker.on("error", (err) => log.error({ err }, "upload worker error"));

// ------------------------------------------------------------
// Enrichment worker (analytics → feedback → memory)
// ------------------------------------------------------------
const enrichmentWorker = new Worker<{ runId: string }>(
  "enrichmentQueue",
  async (job) => {
    const jobLog = scoped("enrich-worker", job.data.runId);
    jobLog.info({ jobId: job.id }, "enrichment job picked up");
    const started = Date.now();
    try {
      await runEnrichment(job.data.runId);
      jobLog.info({ jobId: job.id, durationMs: Date.now() - started }, "enrichment job completed");
    } catch (err) {
      jobLog.error({ err, jobId: job.id, durationMs: Date.now() - started }, "enrichment job threw");
      throw err;
    }
  },
  { connection, concurrency: 2 }
);

enrichmentWorker.on("ready", () => log.info("enrichmentQueue ready"));

// ------------------------------------------------------------
// Scheduled jobs
// ------------------------------------------------------------
startAnalyticsSyncCron();
enrichmentWorker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err: err.message }, "enrichment job failed event")
);
enrichmentWorker.on("error", (err) => log.error({ err }, "enrichment worker error"));

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------
const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await Promise.all([
    videoWorker.close(),
    uploadWorker.close(),
    enrichmentWorker.close(),
  ]);
  await connection.quit();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandledRejection");
});
