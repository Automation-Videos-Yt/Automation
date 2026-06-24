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
        variants: env.HOOK_AB_VARIANTS ?? 20,
        past_hooks: pastHooks,
        use_cache: false,
      };

      const generatedHook = await withAgentLog(context.prisma, context.runId, AGENT, hookInput, () =>
        runAgent<typeof hookInput, HookOutput>(AGENT, hookInput, {
          runId: context.runId,
        }),
      );
      hook = generatedHook;

      // Note: We no longer store the array of variants in DB, as requested.
      // We only update the script to use the winning hook.
      await context.prisma.script.update({
        where: { runId: context.runId },
        data: { hook: hook.winning_hook },
      });
    }

    if (!hook) {
      throw new Error("hook generation returned no output");
    }

    context.cache.hook = hook;
    context.cache.script = { ...script, hook: hook.winning_hook };

    await completeStage(context, STAGE, AGENT, {
      cached: Boolean(cachedHook),
      chosenHook: hook.winning_hook,
      hookScore: hook.hook_score,
      generationCount: hook.generation_count,
    });
    return { success: true, data: hook };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
