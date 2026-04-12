import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "worker" },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service",
          messageFormat: "[{scope}{runTag}] {msg}",
        },
      }
    : undefined,
});

export function scoped(scope: string, runId?: string) {
  return logger.child({
    scope,
    runTag: runId ? ` run=${runId.slice(0, 8)}` : "",
    ...(runId ? { runId } : {}),
  });
}
