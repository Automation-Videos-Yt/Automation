import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { scoped } from "../lib/logger";

const log = scoped("error");

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    log.warn({ details: err.flatten().fieldErrors }, "validation error");
    res.status(400).json({
      error: "ValidationError",
      details: err.flatten().fieldErrors,
    });
    return;
  }

  log.error({ err }, "unhandled api error");
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: "InternalServerError", message });
}
