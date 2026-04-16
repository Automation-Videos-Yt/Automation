import { z } from "zod";
import "dotenv/config";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AI_SERVICE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_COST_ANALYSIS: z.string().default("gpt-4o-mini"),
  ENABLE_LANGCHAIN_COST_ANALYSIS: z.coerce.boolean().default(true),
  STORAGE_PATH: z.string().default("/storage"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:4000/auth/youtube/callback"),
  WEB_BASE_URL: z.string().url().default("http://localhost:3000"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
