import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const UPLOAD_QUEUE = "uploadQueue";

export const uploadQueue = new Queue(UPLOAD_QUEUE, { connection });

export type UploadJobData = {
  runId: string;
  uploadId: string;
};
