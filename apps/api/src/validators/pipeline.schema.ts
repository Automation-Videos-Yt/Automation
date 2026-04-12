import { z } from "zod";

export const createRunSchema = z.object({
  niche: z.string().trim().min(3).max(120),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;
