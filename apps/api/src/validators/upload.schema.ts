import { z } from "zod";

export const createUploadSchema = z.object({
  privacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).default("PUBLIC"),
  scheduledAt: z.coerce.date().optional(),
});

export type CreateUploadInput = z.infer<typeof createUploadSchema>;
