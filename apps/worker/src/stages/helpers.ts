import type { PrismaClient } from "@prisma/client";
import { loadHook, loadPrediction, loadScript, loadTimestamp, loadTopic, loadVideoMeta, loadVideoSelection, loadVoice } from "../cache/cache-resume";
import { retrievePastTopics } from "../memory/vectorStore";
import type {
  HookOutput,
  PipelineStage,
  PredictionOutput,
  RunFeatures,
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

const GPT_4O_INPUT_COST = 2.5;
const GPT_4O_OUTPUT_COST = 10.0;
const GPT_4O_MINI_INPUT_COST = 0.15;
const GPT_4O_MINI_OUTPUT_COST = 0.6;
const GEMINI_FLASH_INPUT_COST = 0.075;
const GEMINI_FLASH_OUTPUT_COST = 0.3;

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
  if (features?.enableSubtitles && features.enableTimestamp === false) {
    throw new Error("enableSubtitles=true requires enableTimestamp=true");
  }
  const next: RunFeatures = {
    ...DEFAULT_RUN_FEATURES,
    ...(features ?? {}),
  };
  if (!next.enableTimestamp) {
    next.enableSubtitles = false;
  }
  return next;
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
  fn: (onMeta: (meta: any) => void) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let meta: any | undefined;

  try {
    const output = await fn((m) => { meta = m; });
    const durationMs = Date.now() - started;

    await prisma.agentLog.create({
      data: {
        runId,
        agent,
        inputJson: input as object,
        outputJson: output as object,
        durationMs,
        status: "SUCCESS",
      },
    });
    
    if (meta) {
      let inputPrice = 0;
      let outputPrice = 0;

      if (meta.model.includes("gpt-4o-mini")) {
        inputPrice = GPT_4O_MINI_INPUT_COST;
        outputPrice = GPT_4O_MINI_OUTPUT_COST;
      } else if (meta.model.includes("gpt-4o")) {
        inputPrice = GPT_4O_INPUT_COST;
        outputPrice = GPT_4O_OUTPUT_COST;
      } else if (meta.model.includes("gemini")) {
        inputPrice = GEMINI_FLASH_INPUT_COST;
        outputPrice = GEMINI_FLASH_OUTPUT_COST;
      }

      const costUsd =
        (meta.promptTokens / 1000000) * inputPrice +
        (meta.completionTokens / 1000000) * outputPrice;
      
      let provider = "openai";
      if (meta.model.includes("gemini")) provider = "gemini";

      await prisma.aiCostRecord.create({
        data: {
          runId,
          provider,
          model: meta.model,
          promptVersion: meta.promptVersion,
          operation: agent,
          tokensInput: meta.promptTokens,
          tokensOutput: meta.completionTokens,
          costUsd,
          latencyMs: durationMs,
        }
      });
    }
    
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

export function scheduleFromDelayMinutes(delayMinutes: number): Date | null {
  const minutes = Math.max(0, Math.floor(delayMinutes));
  if (minutes === 0) return null;
  return new Date(Date.now() + minutes * 60_000);
}
