import type { Request, Response, NextFunction } from "express";
import { createBatchSchema, createRunSchema } from "../validators/pipeline.schema";
import {
  PipelineServiceError,
  createPipelineBatch,
  createPipelineRun,
  getPipelineLogs,
  getPipelineRun,
  listPipelineRuns,
  retryPipelineRun,
} from "../services/pipeline.service";

export async function postRun(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createRunSchema.parse(req.body);
    const run = await createPipelineRun(input.niche, input.durationSec);
    res.status(201).json(run);
  } catch (err) {
    next(err);
  }
}

export async function postBatch(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const input = createBatchSchema.parse(req.body);
    const runs = await createPipelineBatch(
      input.niche,
      input.count,
      input.durationSec
    );
    res.status(201).json({ count: runs.length, runs });
  } catch (err) {
    next(err);
  }
}

export async function getRun(req: Request, res: Response, next: NextFunction) {
  try {
    const run = await getPipelineRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  } catch (err) {
    next(err);
  }
}

export async function getRunLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const logs = await getPipelineLogs(req.params.id);
    res.json(logs);
  } catch (err) {
    next(err);
  }
}

export async function listRuns(_req: Request, res: Response, next: NextFunction) {
  try {
    const runs = await listPipelineRuns();
    res.json(runs);
  } catch (err) {
    next(err);
  }
}

export async function postRetry(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const run = await retryPipelineRun(req.params.id);
    res.status(202).json(run);
  } catch (err) {
    if (err instanceof PipelineServiceError) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "ALREADY_RUNNING" || err.code === "ALREADY_DONE"
          ? 409
          : 400;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }
}
