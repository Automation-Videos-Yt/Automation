import { env } from "../config/env";
import { runAgent } from "../clients/aiClient";
import { loadHook } from "../cache/cache-resume";
import { retrievePastHooks } from "../memory/vectorStore";
import { videoQueue } from "../queues/videoQueue";
import {
  completeStage,
  createStageErrorHandler,
  getRun,
  getScript,
  getTopic,
  startStage,
  withAgentLog,
} from "./helpers";
import type { HookOutput, HookVariantOut, PipelineStage, RunFeatures, TopicOutput } from "./types";

const STAGE = "HOOK" as const;
const AGENT = "hook";

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

async function maybeSeedHookVariantRuns(
  context: Parameters<PipelineStage["execute"]>[0],
  input: SeedHookVariantRunsInput,
): Promise<string[]> {
  if (!env.ENABLE_HOOK_AB_TESTING) return [];

  const targetVariants = Math.min(env.HOOK_AB_VARIANTS, input.variants.length);
  if (targetVariants < 2) return [];

  const existingSeedLog = await context.prisma.agentLog.findFirst({
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

      const childRun = await context.prisma.$transaction(async (tx) => {
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

    await context.prisma.agentLog.create({
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
    await context.prisma.agentLog.create({
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

export const hookStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const run = await getRun(context);
    const topic = await getTopic(context);
    const script = await getScript(context);
    const cachedHook = await loadHook(context.runId);

    let hook = cachedHook;
    if (!hook) {
      const pastHooks = await retrievePastHooks(topic.title, topic.angle, 3);
      context.cache.pastHooks = pastHooks;

      const hookInput = {
        topic_title: topic.title,
        topic_angle: topic.angle,
        script_body: script.body,
        original_hook: script.hook,
        language_code: run.languageCode,
        variants: env.ENABLE_HOOK_AB_TESTING ? env.HOOK_AB_VARIANTS : 3,
        past_hooks: pastHooks,
      };

      const generatedHook = await withAgentLog(context.prisma, context.runId, AGENT, hookInput, () =>
        runAgent<typeof hookInput, HookOutput>(AGENT, hookInput, {
          runId: context.runId,
        }),
      );
      hook = generatedHook;

      await context.prisma.hookVariant.createMany({
        data: generatedHook.variants.map((variant, index) => ({
          runId: context.runId,
          index,
          text: variant.text,
          score: variant.score,
          reasoning: variant.reasoning,
          chosen: index === generatedHook.chosen_index,
        })),
      });

      await context.prisma.script.update({
        where: { runId: context.runId },
        data: { hook: generatedHook.chosen_text },
      });
    }

    if (!hook) {
      throw new Error("hook generation returned no output");
    }

    context.cache.hook = hook;
    context.cache.script = { ...script, hook: hook.chosen_text };

    if (
      env.ENABLE_HOOK_AB_TESTING &&
      context.cache.features.enableHookVariants &&
      hook.variants.length > 1
    ) {
      const persistedTopic = await context.prisma.topic.findUnique({
        where: { runId: context.runId },
        select: { titleEmbedding: true },
      });

      const experimentId = context.cache.experimentId ?? run.experimentId ?? run.id;
      context.cache.experimentId = experimentId;

      const childRunIds = await maybeSeedHookVariantRuns(context, {
        parentRunId: context.runId,
        experimentId,
        niche: run.niche,
        languageCode: run.languageCode,
        features: context.cache.features,
        targetDurationSec: run.targetDurationSec,
        topic,
        topicEmbedding: persistedTopic?.titleEmbedding ?? [],
        scriptBody: script.body,
        scriptCta: script.cta,
        scriptWordCount: script.word_count,
        scriptDurationEstimateSec: script.duration_estimate_sec,
        variants: hook.variants,
        chosenIndex: hook.chosen_index,
      });

      if (childRunIds.length > 0) {
        context.logger.info(
          { stage: STAGE, runId: context.runId, childRunIds },
          "Hook A/B variants seeded",
        );
      }
    }

    await completeStage(context, STAGE, AGENT, {
      cached: Boolean(cachedHook),
      chosenIndex: hook.chosen_index,
      chosenHook: hook.chosen_text,
    });
    return { success: true, data: hook };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
