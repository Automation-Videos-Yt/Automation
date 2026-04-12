import { z } from "zod";

export const createRunSchema = z.object({
  niche: z.string().trim().min(3).max(120),
  // 10-180s. Defaults to 75 to preserve prior behaviour for callers that omit it.
  durationSec: z.coerce.number().int().min(10).max(180).default(75),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;
