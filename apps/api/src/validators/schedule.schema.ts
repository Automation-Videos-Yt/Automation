import { z } from "zod";
import cron from "node-cron";

export const createScheduleSchema = z.object({
  niche: z.string().min(1, "Niche must not be empty"),
  languageCode: z.string().default("en"),
  cronExpression: z.string().refine((val) => cron.validate(val), {
    message: "Invalid cron expression",
  }),
});

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
