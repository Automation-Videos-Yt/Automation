import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { pipelineRouter } from "./routes/pipeline";
import { youtubeRouter } from "./routes/youtube";
import { analyticsRouter } from "./routes/analytics";
import { costRouter } from "./routes/cost";
import { authRouter } from "./routes/auth";
import { stripeRouter } from "./routes/stripe";
import { razorpayRouter } from "./routes/razorpay";
import { errorHandler } from "./middleware/error";
import { logger } from "./lib/logger";
import { getPresignedS3Url } from "./lib/s3";

export function createApp() {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          query: req.query,
          params: req.params,
          remoteAddress: req.remoteAddress,
          remotePort: req.remotePort,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
      },
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
    }),
  );

  // Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow serving images/videos to frontend
  }));

  // Restrict CORS to frontend origin
  app.use(cors({
    origin: env.WEB_BASE_URL,
    credentials: true,
  }));

  // Rate Limiting: 100 requests per minute
  const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: 100, // Limit each IP to 100 requests per `window` (here, per 1 minute).
    standardHeaders: 'draft-8', 
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
  });
  
  // Apply rate limiter to all requests
  app.use(limiter);

  // Mount webhook routes BEFORE express.json() so they get raw buffer
  app.use("/stripe/webhook", express.raw({ type: "application/json" }));
  app.use("/razorpay/webhook", express.raw({ type: "application/json" }));
  
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/media/s3/:key(*)", async (req, res, next) => {
    if (!env.APP_S3_BUCKET) {
      return next(); // Fallback to local static handler if S3 isn't active
    }
    
    try {
      const key = req.params.key;
      if (!key || key.trim() === "") {
        res.status(400).json({ error: "Missing S3 object key" });
        return;
      }
      
      const presignedUrl = await getPresignedS3Url(key);
      res.redirect(302, presignedUrl);
    } catch (err: any) {
      logger.error({ err, key: req.params.key }, "Failed to generate S3 pre-signed URL");
      res.status(500).json({ error: "Failed to access S3 media", details: err.message });
    }
  });

  app.use("/pipeline", pipelineRouter);
  app.use("/auth/youtube", youtubeRouter);
  app.use("/auth", authRouter);
  app.use("/stripe", stripeRouter);
  app.use("/razorpay", razorpayRouter);
  app.use("/analytics", analyticsRouter);
  app.use("/cost", costRouter);
  app.use("/schedules", scheduleRouter);

  app.use("/media", express.static(env.STORAGE_PATH, { fallthrough: true }));

  app.use(errorHandler);

  return app;
}
