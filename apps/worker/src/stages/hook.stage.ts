import { env } from "../config/env";
import { runAgent } from "../clients/aiClient";
import { loadHook } from "../cache/cache-resume";
import { retrievePastHooks } from "../memory/vectorStore";
import {
  completeStage,
  createStageErrorHandler,
  getRun,
  getScript,
  getTopic,
  maybeSeedHookVariantRuns,
  startStage,
  withAgentLog,
} from "./helpers";
import type { HookOutput, PipelineStage } from "./types";

const STAGE = "HOOK" as const;
const AGENT = "hook";

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

      const childRunIds = await maybeSeedHookVariantRuns(context.prisma, {
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
