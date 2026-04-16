import type { Request, Response, NextFunction } from "express";
import { createUploadSchema } from "../validators/upload.schema";
import {
  UploadServiceError,
  enqueueUpload,
  getUpload,
} from "../services/upload.service";

export async function postUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = createUploadSchema.parse(req.body ?? {});
    const upload = await enqueueUpload(
      req.params.id,
      input.privacy,
      input.scheduledAt,
    );
    res.status(202).json(upload);
  } catch (err) {
    if (err instanceof UploadServiceError) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "NOT_CONNECTED"
            ? 409
            : err.code === "RUN_NOT_READY"
              ? 409
              : 400;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }
}

export async function getUploadStatus(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const upload = await getUpload(req.params.id);
    if (!upload) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.json(upload);
  } catch (err) {
    next(err);
  }
}
