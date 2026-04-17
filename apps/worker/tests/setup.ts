process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/youtube_automation?schema=public";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.AI_SERVICE_URL =
  process.env.AI_SERVICE_URL ?? "http://localhost:8000";
process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY =
  process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY ??
  Buffer.alloc(32, 7).toString("base64");
