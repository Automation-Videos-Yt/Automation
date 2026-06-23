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
import type { PipelineStage, ScriptOutput, ScriptEvalOutput } from "./types";

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
    
    let currentFeedback: string[] = [];
    let script: ScriptOutput | null = null;
    let evalScore = 0;
    
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const scriptInput = {
        topic_title: topic.title,
        topic_angle: topic.angle,
        target_duration_sec: run.targetDurationSec,
        language_code: run.languageCode,
        past_topics: pastTopics,
        feedback: currentFeedback,
      };

      const agentName = attempt === 0 ? AGENT : `${AGENT}_retry_${attempt}`;
      script = await withAgentLog(
        context.prisma,
        context.runId,
        agentName,
        scriptInput,
        () =>
          runAgent<typeof scriptInput, ScriptOutput>(AGENT, scriptInput, {
            runId: context.runId,
          }),
      );

      // Evaluate Script
      const evalInput = {
        topic_title: topic.title,
        topic_angle: topic.angle,
        script_hook: script.hook,
        script_body: script.body,
        script_cta: script.cta,
      };
      
      const evalOutput = await withAgentLog(
        context.prisma,
        context.runId,
        `script_eval_attempt_${attempt}`,
        evalInput,
        () =>
          runAgent<typeof evalInput, ScriptEvalOutput>("script_eval", evalInput, {
            runId: context.runId,
          }),
      );
      
      evalScore = evalOutput.score;
      if (evalScore >= 80 || attempt === maxRetries) {
        break;
      }
      
      // If we scored < 80, but >= 70, we allow 1 retry. If < 70, 2 retries (meaning we keep looping).
      // Since maxRetries is 2, attempt=0 and attempt=1 will loop.
      if (evalScore >= 70 && attempt === 1) {
          // Break early if it's the second attempt and score is decent (70-79).
          break;
      }
      
      currentFeedback = evalOutput.feedback;
      context.logger.info({ runId: context.runId, attempt, evalScore, feedback: currentFeedback }, "Script evaluation failed, retrying...");
    }

    if (!script) {
        throw new Error("Script generation failed after retries.");
    }

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
      evalScore,
    });
    return { success: true, data: script };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
