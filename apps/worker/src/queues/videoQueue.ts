import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const VIDEO_QUEUE = "videoQueue";

export const videoQueue = new Queue(VIDEO_QUEUE, { connection });

export type VideoJobData = {
  runId: string;
};
