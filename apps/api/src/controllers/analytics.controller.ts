import type { Request, Response, NextFunction } from "express";
import {
  AnalyticsServiceError,
  getOperationsMetrics,
  getRunAnalytics,
  syncAllAnalytics,
  syncRunAnalytics,
} from "../services/analytics.service";

export async function postSyncAll(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await syncAllAnalytics();
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof AnalyticsServiceError) {
      res.status(err.code === "NOT_CONNECTED" ? 409 : 400).json({
        error: err.code,
        message: err.message,
      });
      return;
    }
    next(err);
  }
}

export async function postSyncRun(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    await syncRunAnalytics(req.params.id);
    res.status(202).json({ enqueued: true });
  } catch (err) {
    if (err instanceof AnalyticsServiceError) {
      res.status(err.code === "UPLOAD_NOT_READY" ? 409 : 400).json({
        error: err.code,
        message: err.message,
      });
      return;
    }
    next(err);
  }
}

export async function getRunAnalyticsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await getRunAnalytics(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function getOperationsMetricsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const rawDays =
      typeof req.query.days === "string" ? Number(req.query.days) : 28;
    const days = Number.isFinite(rawDays) ? rawDays : 28;
    const data = await getOperationsMetrics(days);
    res.json(data);
  } catch (err) {
    next(err);
  }
}
