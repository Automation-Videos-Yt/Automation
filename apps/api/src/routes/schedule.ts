import { Router } from "express";
import {
  postSchedule,
  getSchedules,
  removeSchedule,
} from "../controllers/schedule.controller";

export const scheduleRouter = Router();

scheduleRouter.post("/", postSchedule);
scheduleRouter.get("/", getSchedules);
scheduleRouter.delete("/:id", removeSchedule);
