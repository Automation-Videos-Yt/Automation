import type { Request, Response, NextFunction } from "express";
import {
  getChannelAnalytics,
  DateRangePreset,
} from "../services/channel-analytics.service";
import { NotConnectedError } from "../integrations/youtube/oauth";
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
  } catch (err) {
    if (err instanceof NotConnectedError) {
      res.status(409).json({
        error: err.code,
        message: "Connect a YouTube account first",
      });
      return;
    }
    log.error({ err }, "channel analytics failed");
    next(err);
  }
}
