import { z } from "zod";

const booleanQuerySchema = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expected boolean query value",
    });
    return z.NEVER;
  });

export const runCostQuerySchema = z.object({
  refreshAnalysis: booleanQuerySchema.optional().default(false),
});

export const runCostHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
  refreshAnalysis: booleanQuerySchema.optional().default(false),
});

export const executeCostActionBodySchema = z.object({
  action: z
    .enum([
      "APPROVE_PIPELINE",
      "REGENERATE_HOOK",
      "MODIFY_SCRIPT",
      "CHANGE_VOICE_TIER",
      "SKIP_THUMBNAIL",
      "CHANGE_TOPIC",
    ])
    .optional(),
  forceReanalyze: z.boolean().optional().default(true),
});

export type RunCostQuery = z.infer<typeof runCostQuerySchema>;
export type RunCostHistoryQuery = z.infer<typeof runCostHistoryQuerySchema>;
export type ExecuteCostActionBody = z.infer<typeof executeCostActionBodySchema>;
