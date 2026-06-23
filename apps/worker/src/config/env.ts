import { z } from "zod";
import "dotenv/config";

function isValidEncryptionKey(value: string): boolean {
  try {
    const buf = /^[0-9a-fA-F]{64}$/.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
    return buf.length === 32;
  } catch {
    return false;
  }
}

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    AI_SERVICE_URL: z.string().url(),
    API_URL: z.string().url().default("http://api:4000"),
    STORAGE_PATH: z.string().default("/storage"),
    APP_S3_BUCKET: z.string().optional(),
    AWS_REGION: z.string().default("us-east-1"),
    WORKER_ROLE: z
      .enum(["all", "video", "upload", "enrichment"])
      .default("all"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    UPLOAD_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    ENRICHMENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    VIDEO_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(6),
    CLIP_PREP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    MAX_RETRIES_PER_STAGE: z.coerce.number().int().min(0).max(5).default(2),
    YOUTUBE_CLIENT_ID: z.string().optional(),
    YOUTUBE_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_REDIRECT_URI: z
      .string()
      .url()
      .default("http://localhost:4000/auth/youtube/callback"),
    YOUTUBE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
    ENABLE_THUMBNAIL_AGENT: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    ENABLE_HOOK_AB_TESTING: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    HOOK_AB_VARIANTS: z.coerce.number().int().min(3).max(5).default(3),
    HOOK_AB_AUTO_UPLOAD: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    HOOK_AB_UPLOAD_PRIVACY: z
      .enum(["PRIVATE", "UNLISTED", "PUBLIC"])
      .default("PUBLIC"),
    AUTO_UPLOAD_ON_PIPELINE_DONE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    AUTO_UPLOAD_PRIVACY: z
      .enum(["PRIVATE", "UNLISTED", "PUBLIC"])
      .default("PUBLIC"),
    AUTO_UPLOAD_DELAY_MINUTES: z.coerce.number().int().min(0).default(0),
    ANALYTICS_SYNC_CRON: z.string().default("0 */6 * * *"),
    ENABLE_ANALYTICS_CRON: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    ELEVENLABS_THRESHOLD: z.coerce.number().min(0).max(10).default(9.0),
    PREMIUM_THRESHOLD: z.coerce.number().min(0).max(10).default(8.0),
    ENABLE_GEMINI: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    ENABLE_CACHE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    ENABLE_OPENAI_FALLBACK: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    ENABLE_SCRIPT_RETRIES: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
  })
  .superRefine((value, ctx) => {
    if (value.HOOK_AB_AUTO_UPLOAD && !value.ENABLE_HOOK_AB_TESTING) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HOOK_AB_AUTO_UPLOAD"],
        message: "requires ENABLE_HOOK_AB_TESTING=true",
      });
    }

    const youtubeConfigured =
      !!value.YOUTUBE_CLIENT_ID || !!value.YOUTUBE_CLIENT_SECRET;
    if (youtubeConfigured && !value.YOUTUBE_TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["YOUTUBE_TOKEN_ENCRYPTION_KEY"],
        message: "required when YouTube OAuth is configured",
      });
      return;
    }

    if (
      value.YOUTUBE_TOKEN_ENCRYPTION_KEY &&
      !isValidEncryptionKey(value.YOUTUBE_TOKEN_ENCRYPTION_KEY)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["YOUTUBE_TOKEN_ENCRYPTION_KEY"],
        message:
          "must be a 32-byte key encoded as base64 or 64-char hex",
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[worker] invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export type WorkerConfig = typeof env;
