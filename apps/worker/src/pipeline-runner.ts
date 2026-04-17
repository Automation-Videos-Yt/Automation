import { Prisma } from "@prisma/client";
import { prisma } from "./db/prisma";
import { env } from "./config/env";
import { publishRunEvent } from "./events/publisher";
import { scoped } from "./lib/logger";
import {
  PIPELINE_STAGES,
  type RunControlOverrides,
  type RunFeatures,
  type StageContext,
  type StageEvent,
  type StageName,
} from "./stages";
import {
  observeRunCompleted,
  observeRunFailed,
  observeStageCompleted,
  observeStageFailed,
  observeStageRetry,
} from "./observability/metrics";
import { enqueueAutoUploadForRun } from "./upload/auto-upload";
import {
  PipelineCancelledError,
  ensureRunNotCancelled,
  isUserCancelledRun,
  normalizeRunFeatures,
  scheduleFromDelayMinutes,
  USER_CANCELLED_MESSAGE,
} from "./stages/helpers";

async function emitStageEvent(event: StageEvent): Promise<void> {
  publishRunEvent(event.runId, "stage", {
    stage: event.stage,
    status: event.status,
    agent: event.agent,
    error: event.error,
    ...(event.meta ?? {}),
  });
}

function errorTypeOf(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  if (error && typeof error === "object" && "constructor" in error) {
    const ctor = (error as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) return ctor.name;
  }
  return "UnknownError";
}

function normalizeStageRetryCounts(
  value: unknown,
): Partial<Record<StageName, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Partial<Record<StageName, number>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      result[key as StageName] = Math.floor(raw);
    }
  }
  return result;
}

async function markRunFailed(
  context: StageContext,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await context.prisma.pipelineRun.update({
    where: { id: context.runId },
    data: {
      stage: "FAILED",
      status: "FAILED",
      currentAgent: null,
      errorMessage: message,
      completedAt: null,
    },
  });

  if (context.cache.run) {
    context.cache.run.stage = "FAILED";
    context.cache.run.status = "FAILED";
    context.cache.run.currentAgent = null;
    context.cache.run.errorMessage = message;
  }

  await context.emit({
    runId: context.runId,
    stage: "FAILED",
    status: "FAILED",
    error: message,
  });
}

async function markRunCancelled(context: StageContext): Promise<void> {
  const latest = await context.prisma.pipelineRun.findUnique({
    where: { id: context.runId },
    select: { status: true, errorMessage: true },
  });

  if (!latest || !isUserCancelledRun(latest.status, latest.errorMessage)) {
    await context.prisma.pipelineRun.update({
      where: { id: context.runId },
      data: {
        stage: "FAILED",
        status: "FAILED",
        currentAgent: null,
        errorMessage: USER_CANCELLED_MESSAGE,
        completedAt: null,
        failedStage: latest?.status === "FAILED" ? null : "FAILED",
        stageFailureReason: USER_CANCELLED_MESSAGE,
        stageFailureMeta: { cancelled: true } as Prisma.InputJsonValue,
      },
    });
  }

  await context.emit({
    runId: context.runId,
    stage: "FAILED",
    status: "FAILED",
    error: USER_CANCELLED_MESSAGE,
    meta: { reason: "cancelled" },
  });
}

async function markRunCompleted(context: StageContext): Promise<void> {
  await ensureRunNotCancelled(context.runId, context.prisma);
  const completedAt = new Date();
  await context.prisma.pipelineRun.update({
    where: { id: context.runId },
    data: {
      stage: "DONE",
      status: "COMPLETED",
      currentAgent: null,
      completedAt,
      failedStage: null,
      stageFailureReason: null,
      stageFailureMeta: Prisma.JsonNull,
    },
  });

  if (context.cache.run) {
    context.cache.run.stage = "DONE";
    context.cache.run.status = "COMPLETED";
    context.cache.run.currentAgent = null;
    context.cache.run.completedAt = completedAt;
    context.cache.run.failedStage = null;
    context.cache.run.stageFailureReason = null;
    context.cache.run.stageFailureMeta = null;
  }

  await context.emit({
    runId: context.runId,
    stage: "DONE",
    status: "COMPLETED",
  });
}

async function maybeAutoUpload(runId: string): Promise<void> {
  const shouldAutoUploadAtDone =
    env.AUTO_UPLOAD_ON_PIPELINE_DONE ||
    (env.ENABLE_HOOK_AB_TESTING && env.HOOK_AB_AUTO_UPLOAD);

  if (!shouldAutoUploadAtDone) {
    return;
  }

  const uploadPrivacy = env.AUTO_UPLOAD_ON_PIPELINE_DONE
    ? env.AUTO_UPLOAD_PRIVACY
    : env.HOOK_AB_UPLOAD_PRIVACY;
  const scheduledAt = scheduleFromDelayMinutes(env.AUTO_UPLOAD_DELAY_MINUTES);
  await enqueueAutoUploadForRun(runId, uploadPrivacy, scheduledAt ?? undefined);
}

export async function runPipeline(
  runId: string,
  requestedFeatures?: Partial<RunFeatures>,
  controlOverrides?: RunControlOverrides,
): Promise<void> {
  const logger = scoped("pipeline", runId);
  const run = await prisma.pipelineRun.findUnique({ where: { id: runId } });
  if (!run) {
    logger.error("run not found in db");
    throw new Error(`run ${runId} not found`);
  }
  if (run.status === "COMPLETED") {
    logger.info("pipeline skipped: run already completed");
    return;
  }
  if (isUserCancelledRun(run.status, run.errorMessage)) {
    logger.info("pipeline skipped: run already cancelled");
    return;
  }

  const features = normalizeRunFeatures(requestedFeatures);
  const experimentId = run.experimentId ?? run.id;
  const pipelineStart = Date.now();
  const startedAt = new Date();
  const stageRetryCounts = normalizeStageRetryCounts(run.stageRetryCounts);
  const control =
    controlOverrides && Object.keys(controlOverrides).length > 0
      ? controlOverrides
      : undefined;

  logger.info(
    {
      runId,
      niche: run.niche,
      languageCode: run.languageCode,
      features,
      control,
    },
    "pipeline start",
  );

  await ensureRunNotCancelled(runId, prisma);
  await prisma.pipelineRun.update({
    where: { id: runId },
    data: {
      status: "RUNNING",
      errorMessage: null,
      experimentId,
      startedAt,
      completedAt: null,
      failedStage: null,
      stageFailureReason: null,
      stageFailureMeta: Prisma.JsonNull,
      stageRetryCounts,
    },
  });

  const context: StageContext = {
    runId,
    prisma,
    logger,
    emit: emitStageEvent,
    cache: {
      run: {
        ...run,
        status: "RUNNING",
        errorMessage: null,
        experimentId,
        startedAt,
        completedAt: null,
        failedStage: null,
        stageFailureReason: null,
        stageFailureMeta: null,
        stageRetryCounts,
      },
      experimentId,
      features,
      control,
      stageRetryCounts,
    },
    config: env,
  };

  await context.emit({
    runId,
    stage: "QUEUED",
    status: "STARTED",
  });

  try {
    for (const stage of PIPELINE_STAGES) {
      if (await stage.shouldSkip?.(context)) {
        continue;
      }

      let completed = false;
      while (!completed) {
        const stageStartedAtMs = Date.now();
        try {
          const result = await stage.execute(context);
          if (!result.success) {
            throw new Error(result.error ?? `${stage.name} failed`);
          }

          const stageDurationMs = Date.now() - stageStartedAtMs;
          observeStageCompleted(stage.name, stageDurationMs);
          logger.info(
            {
              runId,
              stage: stage.name,
              stageDurationMs,
              retryCount: context.cache.stageRetryCounts?.[stage.name] ?? 0,
              control,
            },
            "stage execution completed",
          );
          completed = true;
        } catch (error) {
          if (error instanceof PipelineCancelledError) {
            throw error;
          }

          const stageDurationMs = Date.now() - stageStartedAtMs;
          const errorType = errorTypeOf(error);
          const nextRetryCount =
            (context.cache.stageRetryCounts?.[stage.name] ?? 0) + 1;
          context.cache.stageRetryCounts = {
            ...(context.cache.stageRetryCounts ?? {}),
            [stage.name]: nextRetryCount,
          };

          await context.prisma.pipelineRun.update({
            where: { id: runId },
            data: {
              failedStage: stage.name as never,
              stageFailureReason:
                error instanceof Error ? error.message : String(error),
              stageFailureMeta: {
                errorType,
                attempt: nextRetryCount,
                maxRetriesPerStage: env.MAX_RETRIES_PER_STAGE,
                stageDurationMs,
              } as Prisma.InputJsonValue,
              stageRetryCounts: context.cache.stageRetryCounts,
            },
          });

          if (context.cache.run) {
            context.cache.run.failedStage = stage.name as never;
            context.cache.run.stageFailureReason =
              error instanceof Error ? error.message : String(error);
            context.cache.run.stageFailureMeta = {
              errorType,
              attempt: nextRetryCount,
              maxRetriesPerStage: env.MAX_RETRIES_PER_STAGE,
              stageDurationMs,
            };
            context.cache.run.stageRetryCounts = context.cache.stageRetryCounts;
          }

          observeStageFailed(stage.name, stageDurationMs, errorType);
          await stage.onError?.(error, context);

          if (nextRetryCount <= env.MAX_RETRIES_PER_STAGE) {
            observeStageRetry(stage.name);
            logger.warn(
              {
                runId,
                stage: stage.name,
                retryCount: nextRetryCount,
                maxRetriesPerStage: env.MAX_RETRIES_PER_STAGE,
                errorType,
                stageDurationMs,
              },
              "stage execution failed, retrying",
            );
            continue;
          }

          logger.error(
            {
              runId,
              stage: stage.name,
              retryCount: nextRetryCount,
              maxRetriesPerStage: env.MAX_RETRIES_PER_STAGE,
              errorType,
              stageDurationMs,
            },
            "stage execution exhausted retries",
          );
          throw error;
        }
      }
    }

    await markRunCompleted(context);
    observeRunCompleted(Date.now() - pipelineStart);

    try {
      await maybeAutoUpload(runId);
    } catch (error) {
      logger.error({ err: error }, "auto-upload enqueue failed");
    }

    logger.info({ totalMs: Date.now() - pipelineStart }, "pipeline complete");
  } catch (error) {
    if (error instanceof PipelineCancelledError) {
      logger.info(
        { totalMs: Date.now() - pipelineStart },
        "pipeline cancelled by user",
      );
      observeRunFailed(Date.now() - pipelineStart);
      await markRunCancelled(context);
      return;
    }

    await markRunFailed(context, error);
    observeRunFailed(Date.now() - pipelineStart);
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        totalMs: Date.now() - pipelineStart,
      },
      "pipeline failed",
    );
    throw error;
  }
}
