import { UnrecoverableError } from "bullmq";

/**
 * Thrown when an error occurs that is permanent (e.g. missing API keys, invalid configuration).
 * BullMQ will immediately mark the job as failed and will NOT retry it.
 */
export class FatalError extends UnrecoverableError {
  constructor(message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = "FatalError";
  }
}

/**
 * Thrown when an error is temporary (e.g. rate limits, network timeouts).
 * BullMQ will automatically retry the job based on the queue's retry settings.
 */
export class TransientError extends Error {
  constructor(message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = "TransientError";
  }
}
