import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("scheduleQueue");

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => log.error({ err }, "redis error"));

export type ScheduleJobData = {
  scheduleId: string;
  niche: string;
  languageCode: string;
};

export const scheduleQueue = new Queue<ScheduleJobData>("scheduleQueue", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});
