import { Router } from "express";
import {
  getOperationsMetricsController,
  postSyncAll,
} from "../controllers/analytics.controller";
import { getChannelAnalyticsController } from "../controllers/channel-analytics.controller";

export const analyticsRouter = Router();

analyticsRouter.post("/sync", postSyncAll);
analyticsRouter.get("/channel", getChannelAnalyticsController);
analyticsRouter.get("/operations", getOperationsMetricsController);
