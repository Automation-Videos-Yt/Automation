import { z } from "zod";

export const createUploadSchema = z.object({
  privacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).default("PRIVATE"),
});

export type CreateUploadInput = z.infer<typeof createUploadSchema>;
