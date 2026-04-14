import { z } from "zod";
import "dotenv/config";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AI_SERVICE_URL: z.string().url(),
  STORAGE_PATH: z.string().default("/storage"),
  WORKER_CONCURRENCY: z.coerce.number().default(1),
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
  // Cron schedule for auto-sync of YouTube analytics. Default: every 6 hours.
  // Set to "" to disable the scheduler entirely.
  ANALYTICS_SYNC_CRON: z.string().default("0 */6 * * *"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[worker] invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
