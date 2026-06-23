import type { Request, Response, NextFunction } from "express";
import { createScheduleSchema } from "../validators/schedule.schema";
import {
  createSchedule,
  listSchedules,
  deleteSchedule,
  ScheduleServiceError,
} from "../services/schedule.service";

export async function postSchedule(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createScheduleSchema.parse(req.body);
    const schedule = await createSchedule(
      input.niche,
      input.cronExpression,
      input.languageCode
    );
    res.status(201).json(schedule);
  } catch (err) {
    next(err);
  }
}

export async function getSchedules(req: Request, res: Response, next: NextFunction) {
  try {
    const schedules = await listSchedules();
    res.json(schedules);
  } catch (err) {
    next(err);
  }
}

export async function removeSchedule(req: Request, res: Response, next: NextFunction) {
  try {
    await deleteSchedule(req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err instanceof ScheduleServiceError && err.code === "NOT_FOUND") {
      res.status(404).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }
}
