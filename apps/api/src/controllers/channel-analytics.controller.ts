import type { Request, Response, NextFunction } from "express";
import {
  getChannelAnalytics,
  DateRangePreset,
} from "../services/channel-analytics.service";
import { scoped } from "../lib/logger";

const log = scoped("channel-analytics-ctrl");

const VALID_RANGES = new Set(["7", "28", "90", "365"]);

export async function getChannelAnalyticsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const daysParam =
      typeof req.query.days === "string" ? req.query.days : "28";
    const days: DateRangePreset = VALID_RANGES.has(daysParam)
      ? (daysParam as DateRangePreset)
      : "28";

    const data = await getChannelAnalytics(days);
    res.json(data);
  } catch (err: any) {
    if (err.message === "no connected YouTube account") {
      res.status(409).json({
        error: "NOT_CONNECTED",
        message: "Connect a YouTube account first",
      });
      return;
    }
    log.error({ err }, "channel analytics failed");
    next(err);
  }
}
