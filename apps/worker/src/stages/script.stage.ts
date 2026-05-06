import { runAgent } from "../clients/aiClient";
import { loadScript } from "../cache/cache-resume";
import {
  completeStage,
  createStageErrorHandler,
  getPastTopics,
  getRun,
  getTopic,
  startStage,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, ScriptOutput } from "./types";

const STAGE = "SCRIPT" as const;
const AGENT = "script";

export const scriptStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const cached = await loadScript(context.runId);
    if (cached) {
      context.cache.script = cached;
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: cached };
    }

    const run = await getRun(context);
    const topic = await getTopic(context);
    const pastTopics = await getPastTopics(context);
    const scriptInput = {
      topic_title: topic.title,
      topic_angle: topic.angle,
      target_duration_sec: run.targetDurationSec,
      language_code: run.languageCode,
      past_topics: pastTopics,
    };

    const script = await withAgentLog(
      context.prisma,
      context.runId,
      AGENT,
      scriptInput,
      () =>
        runAgent<typeof scriptInput, ScriptOutput>(AGENT, scriptInput, {
          runId: context.runId,
        }),
    );

    await context.prisma.script.create({
      data: {
        runId: context.runId,
        hook: script.hook,
        body: script.body,
        cta: script.cta,
        wordCount: script.word_count,
        durationEstimateSec: script.duration_estimate_sec,
      },
    });

    context.cache.script = script;
    await completeStage(context, STAGE, AGENT, {
      wordCount: script.word_count,
      durationEstimateSec: script.duration_estimate_sec,
    });
    return { success: true, data: script };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
