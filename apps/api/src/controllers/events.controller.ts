import type { Request, Response } from "express";
import { subscribeRun } from "../events/bus";
import { scoped } from "../lib/logger";

const log = scoped("sse");

const KEEPALIVE_MS = 25_000;

export function streamRunEvents(req: Request, res: Response) {
  const runId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // defeat nginx/proxy buffering
  res.flushHeaders?.();

  const write = (data: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      log.warn({ err, runId }, "sse write failed — client likely disconnected");
    }
  };

  // Immediate handshake so the client knows the channel is open.
  write({ runId, kind: "hello", at: Date.now() });

  const unsubscribe = subscribeRun(runId, (evt) => write(evt));

  // Keepalive comments prevent middleboxes from silently killing the socket.
  const keepalive = setInterval(() => {
    try {
      res.write(`: ka ${Date.now()}\n\n`);
    } catch {
      // client gone — cleaned up on close below
    }
  }, KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
    try {
      res.end();
    } catch {
      // already closed
    }
    log.info({ runId }, "sse client disconnected");
  };

  req.on("close", cleanup);
  req.on("error", cleanup);

  log.info({ runId }, "sse client connected");
}
