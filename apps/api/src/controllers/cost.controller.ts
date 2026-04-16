import type { Request, Response, NextFunction } from "express";
import {
  getCostAnalysisCacheStats,
  getRunCost,
  getRunCostHistory,
} from "../services/cost.service";
import {
  runCostHistoryQuerySchema,
  runCostQuerySchema,
} from "../validators/cost.schema";

export async function getRunCostController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const query = runCostQuerySchema.parse(req.query ?? {});
    const payload = await getRunCost(req.params.id, {
      forceReanalyze: query.refreshAnalysis,
    });
    if (!payload) {
      res.status(404).json({ error: "NOT_FOUND", message: "run not found" });
      return;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

export async function getRunCostHistoryController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const query = runCostHistoryQuerySchema.parse(req.query ?? {});
    const payload = await getRunCostHistory(req.params.id, query.limit, {
      forceReanalyze: query.refreshAnalysis,
    });
    if (!payload) {
      res.status(404).json({ error: "NOT_FOUND", message: "run not found" });
      return;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

export function getCostCacheStatsController(
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  res.json(getCostAnalysisCacheStats());
}
