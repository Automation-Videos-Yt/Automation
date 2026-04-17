import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const VIDEO_QUEUE = "videoQueue";

export const videoQueue = new Queue(VIDEO_QUEUE, { connection });

export type RunFeatures = {
  enableTimestamp: boolean;
  enableSubtitles: boolean;
  enableThumbnail: boolean;
  enableHookVariants: boolean;
};

export type VoiceTierOverride = "economy" | "premium" | "elite";

export type RunControlOverrides = {
  forceVoiceTier?: VoiceTierOverride;
  forceSkipThumbnail?: boolean;
  sourceAction?: string;
  iteration?: number;
};

export type VideoJobData = {
  runId: string;
  features?: RunFeatures;
  control?: RunControlOverrides;
};
