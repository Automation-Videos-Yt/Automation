import type { Request, Response, NextFunction } from "express";
import {
  executeCostAgentAction,
  PipelineServiceError,
} from "../services/cost-agent.service";
import {
  getCostAnalysisCacheStats,
  getRunCost,
  getRunCostHistory,
} from "../services/cost.service";
import {
  executeCostActionBodySchema,
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

export async function postRunCostActionController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const body = executeCostActionBodySchema.parse(req.body ?? {});
    const payload = await executeCostAgentAction(req.params.id, {
      requestedAction: body.action,
      forceReanalyze: body.forceReanalyze,
      source: "manual",
    });

    if (!payload) {
      res.status(404).json({ error: "NOT_FOUND", message: "run not found" });
      return;
    }

    res.status(payload.executed ? 202 : 200).json(payload);
  } catch (err) {
    if (err instanceof PipelineServiceError) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "ALREADY_RUNNING"
            ? 409
            : err.code === "UPLOADED_LOCKED" ||
                err.code === "UPLOAD_IN_PROGRESS"
              ? 422
              : 400;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }
}
