import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config/env";
import { runPipeline } from "./pipeline-runner";
import { runUpload } from "./upload/upload-runner";
import { runEnrichment } from "./enrichment/enrichment-runner";
import { startAnalyticsSyncCron } from "./cron/analytics-sync";
import { logger, scoped } from "./lib/logger";
import axios from "axios";
import type { RunControlOverrides, RunFeatures } from "./queues/videoQueue";

const log = scoped("worker");

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => log.error({ err }, "redis error"));
connection.on("connect", () => log.info("redis connected"));

const role = env.WORKER_ROLE;
const workers: Worker[] = [];

const shouldRunVideo = role === "all" || role === "video";
const shouldRunUpload = role === "all" || role === "upload";
const shouldRunEnrichment = role === "all" || role === "enrichment";

// ------------------------------------------------------------
// Video-generation pipeline worker
// ------------------------------------------------------------
if (shouldRunVideo) {
  const videoWorker = new Worker<{
    runId: string;
    features?: RunFeatures;
    control?: RunControlOverrides;
  }>(
    "videoQueue",
    async (job) => {
      const jobLog = scoped("worker", job.data.runId);
      jobLog.info({ jobId: job.id }, "video job picked up");
      const started = Date.now();
      try {
        await runPipeline(job.data.runId, job.data.features, job.data.control);
        jobLog.info(
          { jobId: job.id, durationMs: Date.now() - started },
          "video job completed",
        );
      } catch (err) {
        jobLog.error(
          { err, jobId: job.id, durationMs: Date.now() - started },
          "video job threw",
        );
        throw err;
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );

  videoWorker.on("ready", () =>
    log.info({ role, concurrency: env.WORKER_CONCURRENCY }, "videoQueue ready"),
  );
  videoWorker.on("failed", (job, err) =>
    log.error(
      { jobId: job?.id, runId: job?.data?.runId, err: err.message },
      "video job failed event",
    ),
  );
  videoWorker.on("error", (err) => log.error({ err }, "video worker error"));
  workers.push(videoWorker);
}

// ------------------------------------------------------------
// YouTube upload worker
// ------------------------------------------------------------
if (shouldRunUpload) {
  const uploadWorker = new Worker<{ runId: string; uploadId: string }>(
    "uploadQueue",
    async (job) => {
      const jobLog = scoped("upload-worker", job.data.runId);
      jobLog.info(
        { jobId: job.id, uploadId: job.data.uploadId },
        "upload job picked up",
      );
      const started = Date.now();
      try {
        await runUpload(job.data.uploadId);
        jobLog.info(
          { jobId: job.id, durationMs: Date.now() - started },
          "upload job completed",
        );
      } catch (err) {
        jobLog.error(
          { err, jobId: job.id, durationMs: Date.now() - started },
          "upload job threw",
        );
        throw err;
      }
    },
    { connection, concurrency: env.UPLOAD_WORKER_CONCURRENCY },
  );

  uploadWorker.on("ready", () =>
    log.info(
      { role, concurrency: env.UPLOAD_WORKER_CONCURRENCY },
      "uploadQueue ready",
    ),
  );
  uploadWorker.on("failed", (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, "upload job failed event"),
  );
  uploadWorker.on("error", (err) => log.error({ err }, "upload worker error"));
  workers.push(uploadWorker);
}

// ------------------------------------------------------------
// Enrichment worker (analytics → feedback → memory)
// ------------------------------------------------------------
if (shouldRunEnrichment) {
  const enrichmentWorker = new Worker<{ runId: string }>(
    "enrichmentQueue",
    async (job) => {
      const jobLog = scoped("enrich-worker", job.data.runId);
      jobLog.info({ jobId: job.id }, "enrichment job picked up");
      const started = Date.now();
      try {
        await runEnrichment(job.data.runId);
        jobLog.info(
          { jobId: job.id, durationMs: Date.now() - started },
          "enrichment job completed",
        );
      } catch (err) {
        jobLog.error(
          { err, jobId: job.id, durationMs: Date.now() - started },
          "enrichment job threw",
        );
        throw err;
      }
    },
    { connection, concurrency: env.ENRICHMENT_WORKER_CONCURRENCY },
  );

  enrichmentWorker.on("ready", () =>
    log.info(
      { role, concurrency: env.ENRICHMENT_WORKER_CONCURRENCY },
      "enrichmentQueue ready",
    ),
  );
  enrichmentWorker.on("failed", (job, err) =>
    log.error(
      { jobId: job?.id, err: err.message },
      "enrichment job failed event",
    ),
  );
  enrichmentWorker.on("error", (err) =>
    log.error({ err }, "enrichment worker error"),
  );
  workers.push(enrichmentWorker);
}

// ------------------------------------------------------------
// Scheduled jobs (Cron runners via BullMQ)
// ------------------------------------------------------------
if (shouldRunVideo) {
  const scheduleWorker = new Worker<{ scheduleId: string; niche: string; languageCode: string }>(
    "scheduleQueue",
    async (job) => {
      const jobLog = scoped("schedule-worker", job.data.scheduleId);
      jobLog.info({ jobId: job.id, niche: job.data.niche }, "schedule job picked up");
      const started = Date.now();
      try {
        await axios.post(`${env.API_URL}/pipeline/run`, {
          niche: job.data.niche,
          languageCode: job.data.languageCode,
        });
        jobLog.info(
          { jobId: job.id, durationMs: Date.now() - started },
          "schedule job triggered pipeline successfully"
        );
      } catch (err: any) {
        jobLog.error(
          { err: err.response?.data || err.message, jobId: job.id, durationMs: Date.now() - started },
          "schedule job failed to trigger pipeline"
        );
        throw err;
      }
    },
    { connection, concurrency: 1 }
  );

  scheduleWorker.on("ready", () => log.info({ role }, "scheduleQueue ready"));
  scheduleWorker.on("failed", (job, err) => log.error({ jobId: job?.id, err: err.message }, "schedule job failed"));
  scheduleWorker.on("error", (err) => log.error({ err }, "schedule worker error"));
  workers.push(scheduleWorker);
}

if ((role === "all" || role === "enrichment") && env.ENABLE_ANALYTICS_CRON) {
  startAnalyticsSyncCron();
  log.info({ role }, "analytics scheduler started");
} else {
  log.info({ role }, "analytics scheduler disabled for this worker role");
}

if (workers.length === 0) {
  log.fatal({ role }, "no worker consumers started for configured role");
  process.exit(1);
}

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------
const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await Promise.all(workers.map((worker) => worker.close()));
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
