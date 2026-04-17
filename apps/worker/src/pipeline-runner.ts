import { prisma } from "./db/prisma";
import { env } from "./config/env";
import { publishRunEvent } from "./events/publisher";
import { scoped } from "./lib/logger";
import { enqueueAutoUploadForRun } from "./upload/auto-upload";
import { PIPELINE_STAGES, type RunFeatures, type StageContext, type StageEvent } from "./stages";
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

async function markRunFailed(context: StageContext, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await context.prisma.pipelineRun.update({
    where: { id: context.runId },
    data: {
      stage: "FAILED",
      status: "FAILED",
      currentAgent: null,
      errorMessage: message,
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
  await context.prisma.pipelineRun.update({
    where: { id: context.runId },
    data: {
      stage: "DONE",
      status: "COMPLETED",
      currentAgent: null,
    },
  });

  if (context.cache.run) {
    context.cache.run.stage = "DONE";
    context.cache.run.status = "COMPLETED";
    context.cache.run.currentAgent = null;
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

  logger.info(
    { runId, niche: run.niche, languageCode: run.languageCode, features },
    "pipeline start",
  );

  await ensureRunNotCancelled(runId, prisma);
  await prisma.pipelineRun.update({
    where: { id: runId },
    data: { status: "RUNNING", errorMessage: null, experimentId },
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
      },
      experimentId,
      features,
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

      try {
        const result = await stage.execute(context);
        if (!result.success) {
          throw new Error(result.error ?? `${stage.name} failed`);
        }
      } catch (error) {
        if (!(error instanceof PipelineCancelledError)) {
          await stage.onError?.(error, context);
        }
        throw error;
      }
    }

    await markRunCompleted(context);

    try {
      await maybeAutoUpload(runId);
    } catch (error) {
      logger.error({ err: error }, "auto-upload enqueue failed");
    }

    logger.info({ totalMs: Date.now() - pipelineStart }, "pipeline complete");
  } catch (error) {
    if (error instanceof PipelineCancelledError) {
      logger.info({ totalMs: Date.now() - pipelineStart }, "pipeline cancelled by user");
      await markRunCancelled(context);
      return;
    }

    await markRunFailed(context, error);
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
