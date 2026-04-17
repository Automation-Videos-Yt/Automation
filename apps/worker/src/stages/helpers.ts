import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { loadHook, loadPrediction, loadScript, loadTimestamp, loadTopic, loadVideoMeta, loadVideoSelection, loadVoice } from "../cache/cache-resume";
import { retrievePastTopics } from "../memory/vectorStore";
import { videoQueue } from "../queues/videoQueue";
import type {
  HookOutput,
  HookVariantOut,
  PipelineStage,
  PredictionOutput,
  RunFeatures,
  SceneSpanOut,
  ScriptOutput,
  StageContext,
  StageName,
  TimestampOutput,
  TopicOutput,
  VideoMetaOutput,
  VideoSelectionOutput,
  VoiceOutput,
} from "./types";

export const TARGET_WIDTH = 1080;
export const TARGET_HEIGHT = 1920;
export const TARGET_ORIENTATION = "portrait";
export const USER_CANCELLED_MESSAGE = "cancelled by user";

export const DEFAULT_RUN_FEATURES: RunFeatures = {
  enableTimestamp: true,
  enableSubtitles: true,
  enableThumbnail: true,
  enableHookVariants: true,
};

export class PipelineCancelledError extends Error {
  constructor() {
    super(USER_CANCELLED_MESSAGE);
    this.name = "PipelineCancelledError";
  }
}

export function normalizeRunFeatures(features?: Partial<RunFeatures>): RunFeatures {
  const next: RunFeatures = {
    ...DEFAULT_RUN_FEATURES,
    ...(features ?? {}),
  };
  if (!next.enableTimestamp) {
    next.enableSubtitles = false;
  }
  return next;
}

export function voiceTierFromScore(score: number): "elite" | "premium" | "economy" {
  return score >= 7.5 ? "premium" : "economy";
}

export function thumbnailTierFromScore(score: number): {
  size: string;
  quality: "low" | "medium" | "high";
} {
  if (score >= 7.5) return { size: "1536x1024", quality: "medium" };
  if (score >= 5) return { size: "1024x1024", quality: "medium" };
  return { size: "1024x1024", quality: "low" };
}

export function toPrimaryLanguageCode(code: string | null | undefined): string {
  const normalized = (code ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "en";
  return normalized.split("-")[0] || "en";
}

export function isEnglishLanguage(code: string | null | undefined): boolean {
  return toPrimaryLanguageCode(code) === "en";
}

export function isUserCancelledRun(status: string, errorMessage?: string | null): boolean {
  return (
    status === "FAILED" &&
    (errorMessage ?? "").toLowerCase().includes(USER_CANCELLED_MESSAGE)
  );
}

export async function ensureRunNotCancelled(
  runId: string,
  prisma: PrismaClient,
): Promise<void> {
  const latest = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    select: { status: true, errorMessage: true },
  });

  if (latest && isUserCancelledRun(latest.status, latest.errorMessage)) {
    throw new PipelineCancelledError();
  }
}

export async function withAgentLog<T>(
  prisma: PrismaClient,
  runId: string,
  agent: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();

  try {
    const output = await fn();
    await prisma.agentLog.create({
      data: {
        runId,
        agent,
        inputJson: input as object,
        outputJson: output as object,
        durationMs: Date.now() - started,
        status: "SUCCESS",
      },
    });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.agentLog.create({
      data: {
        runId,
        agent,
        inputJson: input as object,
        outputJson: undefined,
        durationMs: Date.now() - started,
        status: "FAILED",
        errorMessage: message,
      },
    });
    throw error;
  }
}

export async function getRun(context: StageContext) {
  if (context.cache.run) {
    return context.cache.run;
  }

  const run = await context.prisma.pipelineRun.findUnique({
    where: { id: context.runId },
  });
  if (!run) {
    throw new Error(`run ${context.runId} not found`);
  }

  context.cache.run = run;
  context.cache.experimentId = run.experimentId ?? run.id;
  return run;
}

export async function getPastTopics(context: StageContext) {
  if (context.cache.pastTopics) {
    return context.cache.pastTopics;
  }

  const run = await getRun(context);
  const pastTopics = await retrievePastTopics(run.niche, 3);
  context.cache.pastTopics = pastTopics;
  return pastTopics;
}

export async function getTopic(context: StageContext): Promise<TopicOutput> {
  if (context.cache.topic) {
    return context.cache.topic;
  }

  const cached = await loadTopic(context.runId);
  if (!cached) {
    throw new Error("TOPIC output missing");
  }

  context.cache.topic = cached;
  return cached;
}

export async function getScript(context: StageContext): Promise<ScriptOutput> {
  if (context.cache.script) {
    return context.cache.script;
  }

  const cached = await loadScript(context.runId);
  if (!cached) {
    throw new Error("SCRIPT output missing");
  }

  context.cache.script = cached;
  return cached;
}

export async function getHook(context: StageContext): Promise<HookOutput> {
  if (context.cache.hook) {
    return context.cache.hook;
  }

  const cached = await loadHook(context.runId);
  if (!cached) {
    throw new Error("HOOK output missing");
  }

  context.cache.hook = cached;
  const script = await getScript(context);
  context.cache.script = { ...script, hook: cached.chosen_text };
  return cached;
}

export async function getPrediction(
  context: StageContext,
): Promise<PredictionOutput> {
  if (context.cache.prediction) {
    return context.cache.prediction;
  }

  const cached = await loadPrediction(context.runId);
  if (!cached) {
    throw new Error("PREDICTION output missing");
  }

  context.cache.prediction = cached;
  return cached;
}

export async function getVoice(context: StageContext): Promise<VoiceOutput> {
  if (context.cache.voice) {
    return context.cache.voice;
  }

  const cached = await loadVoice(context.runId);
  if (!cached) {
    throw new Error("VOICE output missing");
  }

  context.cache.voice = cached;
  return cached;
}

export async function getTimestamp(
  context: StageContext,
): Promise<TimestampOutput> {
  if (context.cache.timestamp) {
    return context.cache.timestamp;
  }

  const cached = await loadTimestamp(context.runId);
  if (!cached) {
    throw new Error("TIMESTAMP output missing");
  }

  context.cache.timestamp = cached;
  return cached;
}

export async function getVideoSelection(
  context: StageContext,
): Promise<VideoSelectionOutput> {
  if (context.cache.videoSelection) {
    return context.cache.videoSelection;
  }

  const cached = await loadVideoSelection(context.runId);
  if (!cached) {
    throw new Error("VIDEO_SELECTION output missing");
  }

  context.cache.videoSelection = cached;
  return cached;
}

export async function getVideoMeta(context: StageContext): Promise<VideoMetaOutput> {
  if (context.cache.videoMeta) {
    return context.cache.videoMeta;
  }

  const cached = await loadVideoMeta(context.runId);
  if (!cached) {
    throw new Error("VIDEO meta missing");
  }

  context.cache.videoMeta = cached;
  return cached;
}

export async function getNarration(context: StageContext): Promise<string> {
  if (context.cache.narration) {
    return context.cache.narration;
  }

  const script = await getScript(context);
  const narration = [script.hook, script.body, script.cta]
    .filter(Boolean)
    .join(" ");
  context.cache.narration = narration;
  return narration;
}

export async function setCurrentAgent(
  context: StageContext,
  agent: string | null,
): Promise<void> {
  await context.prisma.pipelineRun.update({
    where: { id: context.runId },
    data: { currentAgent: agent },
  });

  if (context.cache.run) {
    context.cache.run.currentAgent = agent;
  }
}

export async function startStage(
  context: StageContext,
  stage: StageName,
  agent: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await ensureRunNotCancelled(context.runId, context.prisma);
  await context.prisma.pipelineRun.update({
    where: { id: context.runId },
    data: { stage: stage as never, currentAgent: agent },
  });

  if (context.cache.run) {
    context.cache.run.stage = stage as never;
    context.cache.run.currentAgent = agent;
  }

  context.logger.info({ stage, runId: context.runId }, "Stage started");
  await context.emit({
    runId: context.runId,
    stage,
    status: "STARTED",
    agent,
    meta,
  });
}

export async function completeStage(
  context: StageContext,
  stage: StageName,
  agent: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  context.logger.info({ stage, runId: context.runId }, "Stage completed");
  await context.emit({
    runId: context.runId,
    stage,
    status: "COMPLETED",
    agent,
    meta,
  });
}

export async function failStage(
  context: StageContext,
  stage: StageName,
  agent: string | null,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  context.logger.error({ stage, runId: context.runId, err: message }, "Stage failed");
  await context.emit({
    runId: context.runId,
    stage,
    status: "FAILED",
    agent,
    error: message,
  });
}

export function createStageErrorHandler(
  stage: StageName,
  agent: string | null,
): PipelineStage["onError"] {
  return async (error, context) => {
    await failStage(context, stage, agent, error);
  };
}

export function neutralPrediction(): PredictionOutput {
  return {
    predicted_ctr: 3,
    predicted_retention: 40,
    score: 5,
    reasoning: "prediction unavailable - neutral default",
  };
}

export function buildFallbackScenesFromNarration(opts: {
  narration: string;
  totalDurationSec: number;
  targetSceneSec: number;
}): SceneSpanOut[] {
  const cleaned = opts.narration.replace(/\s+/g, " ").trim();
  const totalDurationSec = Math.max(
    0.5,
    opts.totalDurationSec || opts.targetSceneSec || 6,
  );

  if (!cleaned) {
    return [{ index: 0, start: 0, end: totalDurationSec, text: "" }];
  }

  const sentenceParts = cleaned
    .split(/(?<=[.!?।])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = sentenceParts.length > 0 ? sentenceParts : [cleaned];

  const desiredScenes = Math.max(
    1,
    Math.ceil(totalDurationSec / Math.max(1, opts.targetSceneSec)),
  );
  const chunkSize = Math.max(1, Math.ceil(parts.length / desiredScenes));

  const sceneTexts: string[] = [];
  for (let i = 0; i < parts.length; i += chunkSize) {
    sceneTexts.push(parts.slice(i, i + chunkSize).join(" "));
  }

  const perSceneSec = totalDurationSec / sceneTexts.length;
  return sceneTexts.map((text, index) => {
    const start = index * perSceneSec;
    const end =
      index === sceneTexts.length - 1
        ? totalDurationSec
        : (index + 1) * perSceneSec;
    return { index, start, end, text };
  });
}

type SeedHookVariantRunsInput = {
  parentRunId: string;
  experimentId: string;
  niche: string;
  languageCode: string;
  features: RunFeatures;
  targetDurationSec: number;
  topic: TopicOutput;
  topicEmbedding: number[];
  scriptBody: string;
  scriptCta: string;
  scriptWordCount: number;
  scriptDurationEstimateSec: number;
  variants: HookVariantOut[];
  chosenIndex: number;
};

export async function maybeSeedHookVariantRuns(
  prisma: PrismaClient,
  input: SeedHookVariantRunsInput,
): Promise<string[]> {
  if (!env.ENABLE_HOOK_AB_TESTING) return [];

  const targetVariants = Math.min(env.HOOK_AB_VARIANTS, input.variants.length);
  if (targetVariants < 2) return [];

  const existingSeedLog = await prisma.agentLog.findFirst({
    where: {
      runId: input.parentRunId,
      agent: "hook_ab_seed",
      status: "SUCCESS",
    },
    orderBy: { createdAt: "desc" },
  });
  if (existingSeedLog?.outputJson) {
    const parsed = existingSeedLog.outputJson as { childRunIds?: string[] };
    if (Array.isArray(parsed.childRunIds) && parsed.childRunIds.length > 0) {
      return parsed.childRunIds;
    }
  }

  const seedInput = {
    targetVariants,
    chosenIndex: input.chosenIndex,
    variants: input.variants.map((variant, index) => ({
      index,
      text: variant.text,
      score: variant.score,
    })),
  };

  const started = Date.now();
  try {
    const indicesToSpawn = input.variants
      .map((_, index) => index)
      .filter((index) => index !== input.chosenIndex)
      .slice(0, targetVariants - 1);

    const childRunIds: string[] = [];
    for (const variantIndex of indicesToSpawn) {
      const variant = input.variants[variantIndex];

      const childRun = await prisma.$transaction(async (tx) => {
        const child = await tx.pipelineRun.create({
          data: {
            experimentId: input.experimentId,
            niche: input.niche,
            languageCode: input.languageCode,
            targetDurationSec: input.targetDurationSec,
            stage: "QUEUED",
            status: "QUEUED",
            currentAgent: null,
          },
        });

        await tx.topic.create({
          data: {
            runId: child.id,
            title: input.topic.title,
            angle: input.topic.angle,
            rationale: input.topic.rationale,
            trendScore: input.topic.trend_score,
            titleEmbedding: input.topicEmbedding,
          },
        });

        await tx.script.create({
          data: {
            runId: child.id,
            hook: variant.text,
            body: input.scriptBody,
            cta: input.scriptCta,
            wordCount: input.scriptWordCount,
            durationEstimateSec: input.scriptDurationEstimateSec,
          },
        });

        await tx.hookVariant.create({
          data: {
            runId: child.id,
            index: 0,
            text: variant.text,
            score: variant.score,
            reasoning: variant.reasoning,
            chosen: true,
          },
        });

        return child;
      });

      await videoQueue.add(
        "run-pipeline",
        { runId: childRun.id, features: input.features },
        {
          jobId: childRun.id,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 200 },
        },
      );

      childRunIds.push(childRun.id);
    }

    await prisma.agentLog.create({
      data: {
        runId: input.parentRunId,
        agent: "hook_ab_seed",
        inputJson: seedInput,
        outputJson: { childRunIds },
        durationMs: Date.now() - started,
        status: "SUCCESS",
      },
    });

    return childRunIds;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.agentLog.create({
      data: {
        runId: input.parentRunId,
        agent: "hook_ab_seed",
        inputJson: seedInput,
        outputJson: undefined,
        durationMs: Date.now() - started,
        status: "FAILED",
        errorMessage: message,
      },
    });
    throw error;
  }
}

export function scheduleFromDelayMinutes(delayMinutes: number): Date | null {
  const minutes = Math.max(0, Math.floor(delayMinutes));
  if (minutes === 0) return null;
  return new Date(Date.now() + minutes * 60_000);
}
