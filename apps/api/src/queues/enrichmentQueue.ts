import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const ENRICHMENT_QUEUE = "enrichmentQueue";

export const enrichmentQueue = new Queue(ENRICHMENT_QUEUE, { connection });

export type EnrichmentJobData = {
  runId: string;
};
