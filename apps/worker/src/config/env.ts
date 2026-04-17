import { z } from "zod";
import "dotenv/config";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AI_SERVICE_URL: z.string().url(),
  STORAGE_PATH: z.string().default("/storage"),
  // all: start all queue consumers in one process (legacy/default)
  // video/upload/enrichment: dedicated role-specific process.
  WORKER_ROLE: z.enum(["all", "video", "upload", "enrichment"]).default("all"),
  WORKER_CONCURRENCY: z.coerce.number().default(1),
  UPLOAD_WORKER_CONCURRENCY: z.coerce.number().default(1),
  ENRICHMENT_WORKER_CONCURRENCY: z.coerce.number().default(2),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:4000/auth/youtube/callback"),
  // Toggle the THUMBNAIL stage. Set to "true" to re-enable gpt-image-1 generation.
  // Off by default: YouTube rejects custom thumbnails from unverified channels anyway.
  ENABLE_THUMBNAIL_AGENT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Hook A/B testing:
  // - true: one topic spawns multiple hook-variant runs (3-5 videos)
  // - false: legacy single-hook path
  ENABLE_HOOK_AB_TESTING: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Number of hook variants/videos to test per topic.
  HOOK_AB_VARIANTS: z.coerce.number().int().min(3).max(5).default(3),
  // Automatically enqueue upload for each completed A/B run variant.
  HOOK_AB_AUTO_UPLOAD: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Privacy used by auto-uploaded A/B variants.
  HOOK_AB_UPLOAD_PRIVACY: z
    .enum(["PRIVATE", "UNLISTED", "PUBLIC"])
    .default("PUBLIC"),
  // Automatically upload any run when pipeline reaches DONE.
  AUTO_UPLOAD_ON_PIPELINE_DONE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Privacy used by pipeline-completion auto-upload.
  AUTO_UPLOAD_PRIVACY: z
    .enum(["PRIVATE", "UNLISTED", "PUBLIC"])
    .default("PUBLIC"),
  // Delay upload by N minutes after pipeline completion.
  // 0 means enqueue upload immediately.
  AUTO_UPLOAD_DELAY_MINUTES: z.coerce.number().int().min(0).default(0),
  // Cron schedule for auto-sync of YouTube analytics. Default: every 6 hours.
  // Set to "" to disable the scheduler entirely.
  ANALYTICS_SYNC_CRON: z.string().default("0 */6 * * *"),
  // When false, this process never starts the analytics scheduler.
  ENABLE_ANALYTICS_CRON: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[worker] invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export type WorkerConfig = typeof env;
