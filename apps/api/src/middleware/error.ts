import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { scoped } from "../lib/logger";
import { AppError } from "../lib/errors";

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

  if (err instanceof AppError) {
    log.warn({ status: err.statusCode, message: err.message, details: err.details }, "app error");
    res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
      details: err.details,
    });
    return;
  }

  // Completely obscure internal errors to avoid leaking schemas or keys
  log.error({ err }, "unhandled api error");
  res.status(500).json({ 
    error: "InternalServerError", 
    message: "An unexpected internal server error occurred" 
  });
}
