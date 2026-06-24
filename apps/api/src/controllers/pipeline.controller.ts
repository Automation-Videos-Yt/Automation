import type { Request, Response, NextFunction } from "express";
import {
  createRunSchema,
} from "../validators/pipeline.schema";
import {
  cancelPipelineRun,
  PipelineServiceError,
  createPipelineRun,
  getHookExperiment,
  getPipelineLogs,
  getPipelineRun,
  listPipelineRuns,
  listPipelineRunsPaginated,
  retryPipelineRun,
} from "../services/pipeline.service";

function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

export async function postRun(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createRunSchema.parse(req.body);
    const userId = req.user?.id; // from requireAuth middleware
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const run = await createPipelineRun(
      userId,
      input.niche,
      input.durationSec,
      input.languageCode,
      input.features,
    );
    res.status(201).json(run);
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

export async function getRunLogs(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const logs = await getPipelineLogs(req.params.id);
    res.json(logs);
  } catch (err) {
    next(err);
  }
}

export async function getRunExperiment(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const experiment = await getHookExperiment(req.params.id);
    if (!experiment) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(experiment);
  } catch (err) {
    next(err);
  }
}

export async function listRuns(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const pageRaw = queryString(req.query.page);
    const pageSizeRaw = queryString(req.query.pageSize);
    const hasPagingQuery = pageRaw != null || pageSizeRaw != null;

    if (hasPagingQuery) {
      const parsedPage = Number(pageRaw ?? "1");
      const parsedPageSize = Number(pageSizeRaw ?? "20");
      const page = Number.isFinite(parsedPage) ? parsedPage : 1;
      const pageSize = Number.isFinite(parsedPageSize) ? parsedPageSize : 20;
      const runs = await listPipelineRunsPaginated(page, pageSize);
      res.json(runs);
      return;
    }

    const runs = await listPipelineRuns();
    res.json(runs);
  } catch (err) {
    next(err);
  }
}

export async function postRetry(
  req: Request,
  res: Response,
  next: NextFunction,
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

export async function postCancel(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const run = await cancelPipelineRun(req.params.id);
    res.status(202).json(run);
  } catch (err) {
    if (err instanceof PipelineServiceError) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "ALREADY_DONE"
            ? 409
            : 400;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }
}
