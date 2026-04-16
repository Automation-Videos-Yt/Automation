import { z } from "zod";

const languageCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .regex(
    /^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/,
    "language code must look like en, es, hi, or pt-BR",
  )
  .transform((v) => v.toLowerCase());

const runFeaturesSchema = z.object({
  enableTimestamp: z.boolean().default(true),
  enableSubtitles: z.boolean().default(true),
  enableThumbnail: z.boolean().default(true),
  enableHookVariants: z.boolean().default(true),
});

export const createRunSchema = z.object({
  niche: z.string().trim().min(3).max(120),
  // 10-180s. Defaults to 75 to preserve prior behaviour for callers that omit it.
  durationSec: z.coerce.number().int().min(10).max(180).default(75),
  languageCode: languageCodeSchema.default("en"),
  features: runFeaturesSchema.partial().optional(),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;

export const createBatchSchema = z.object({
  niche: z.string().trim().min(3).max(120),
  count: z.coerce.number().int().min(1).max(10),
  durationSec: z.coerce.number().int().min(10).max(180).default(75),
  languageCodes: z.array(languageCodeSchema).min(1).max(8).default(["en"]),
  features: runFeaturesSchema.partial().optional(),
});

export type CreateBatchInput = z.infer<typeof createBatchSchema>;
