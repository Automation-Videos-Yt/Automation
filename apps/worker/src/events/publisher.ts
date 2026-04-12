import IORedis from "ioredis";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("events");

// Dedicated publisher connection — separate from the BullMQ one so pub/sub
// traffic never interferes with queue operations.
let _pub: IORedis | null = null;
function pub(): IORedis {
  if (!_pub) {
    _pub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    _pub.on("error", (err) => log.error({ err }, "redis pub error"));
  }
  return _pub;
}

export const PIPELINE_EVENTS_CHANNEL = "pipeline:events";

export type PipelineEventKind =
  | "stage" // pipeline stage transition
  | "upload" // YouTubeUpload status change
  | "analytics" // new VideoAnalytics snapshot
  | "feedback" // new FeedbackInsight
  | "memory"; // TopicMemory / HookMemory admission

export type PipelineEvent = {
  runId: string;
  kind: PipelineEventKind;
  at: number;
  meta?: Record<string, unknown>;
};

/**
 * Fire-and-forget — event publishing must never block pipeline work.
 */
export function publishRunEvent(
  runId: string,
  kind: PipelineEventKind,
  meta?: Record<string, unknown>
): void {
  const evt: PipelineEvent = { runId, kind, at: Date.now(), meta };
  pub()
    .publish(PIPELINE_EVENTS_CHANNEL, JSON.stringify(evt))
    .catch((err) => log.warn({ err, runId, kind }, "publish failed"));
}
