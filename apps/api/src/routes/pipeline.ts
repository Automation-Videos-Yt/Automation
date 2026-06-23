import { Router } from "express";
import {
  postCancel,
  getRunExperiment,
  getRun,
  getRunLogs,
  listRuns,
  postRetry,
  postRun,
} from "../controllers/pipeline.controller";
import { getUploadStatus, postUpload } from "../controllers/upload.controller";
import {
  getRunAnalyticsController,
  postSyncRun,
} from "../controllers/analytics.controller";
import { streamRunEvents } from "../controllers/events.controller";

export const pipelineRouter = Router();

pipelineRouter.post("/run", postRun);
pipelineRouter.get("/", listRuns);
pipelineRouter.get("/:id", getRun);
pipelineRouter.get("/:id/experiment", getRunExperiment);
pipelineRouter.get("/:id/logs", getRunLogs);
pipelineRouter.post("/:id/retry", postRetry);
pipelineRouter.post("/:id/cancel", postCancel);
pipelineRouter.get("/:id/stream", streamRunEvents);
pipelineRouter.post("/:id/upload", postUpload);
pipelineRouter.get("/:id/upload", getUploadStatus);
pipelineRouter.get("/:id/analytics", getRunAnalyticsController);
pipelineRouter.post("/:id/analytics/sync", postSyncRun);
