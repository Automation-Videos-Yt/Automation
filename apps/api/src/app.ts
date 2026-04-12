import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { pipelineRouter } from "./routes/pipeline";
import { youtubeRouter } from "./routes/youtube";
import { analyticsRouter } from "./routes/analytics";
import { errorHandler } from "./middleware/error";
import { logger } from "./lib/logger";

export function createApp() {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      customSuccessMessage: (req, res) =>
        `${req.method} ${req.url} ${res.statusCode}`,
      customErrorMessage: (req, res, err) =>
        `${req.method} ${req.url} ${res.statusCode} ${err.message}`,
      customProps: () => ({ scope: "http" }),
    })
  );

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/pipeline", pipelineRouter);
  app.use("/auth", youtubeRouter);
  app.use("/analytics", analyticsRouter);

  app.use("/media", express.static(env.STORAGE_PATH, { fallthrough: true }));

  app.use(errorHandler);

  return app;
}
