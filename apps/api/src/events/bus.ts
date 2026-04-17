import IORedis from "ioredis";
import { EventEmitter } from "node:events";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("events-bus");

export type PipelineEvent = {
  runId: string;
  kind: "stage" | "upload" | "analytics" | "feedback" | "memory";
  at: number;
  meta?: Record<string, unknown>;
};

const CHANNEL = "pipeline:events";

// In-process bus — SSE handlers subscribe to this, not to Redis directly.
// That way we keep exactly one Redis subscriber for the whole API process.
const bus = new EventEmitter();
bus.setMaxListeners(0); // plenty of simultaneous browser tabs

let started = false;

export function startEventBus() {
  if (started) return;
  started = true;

  const sub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  sub.on("error", (err) => log.error({ err }, "redis sub error"));
  sub.on("connect", () => log.info("redis sub connected"));
  sub.subscribe(CHANNEL, (err, count) => {
    if (err) log.error({ err }, "subscribe failed");
    else log.info({ count }, "subscribed to pipeline:events");
  });
  sub.on("message", (_ch, raw) => {
    try {
      const evt = JSON.parse(raw) as PipelineEvent;
      bus.emit("event", evt);
      bus.emit(`run:${evt.runId}`, evt);
    } catch (err) {
      log.warn({ err, raw: raw.slice(0, 200) }, "malformed event dropped");
    }
  });
}

export function subscribeRun(
  runId: string,
  handler: (evt: PipelineEvent) => void,
): () => void {
  const key = `run:${runId}`;
  bus.on(key, handler);
  return () => bus.off(key, handler);
}

export function subscribeAll(
  handler: (evt: PipelineEvent) => void,
): () => void {
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
