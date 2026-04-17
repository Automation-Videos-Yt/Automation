import { Router } from "express";
import {
  getCostCacheStatsController,
  getRunCostController,
  getRunCostHistoryController,
  postRunCostActionController,
} from "../controllers/cost.controller";

export const costRouter = Router();

costRouter.get("/cache/stats", getCostCacheStatsController);
costRouter.get("/run/:id/history", getRunCostHistoryController);
costRouter.get("/run/:id", getRunCostController);
costRouter.post("/run/:id/execute", postRunCostActionController);
