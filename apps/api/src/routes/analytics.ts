import { Router } from "express";
import { postSyncAll } from "../controllers/analytics.controller";

export const analyticsRouter = Router();

analyticsRouter.post("/sync", postSyncAll);
