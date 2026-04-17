import { runAgent } from "../clients/aiClient";
import { loadPrediction } from "../cache/cache-resume";
import {
  completeStage,
  createStageErrorHandler,
  getPastTopics,
  getRun,
  getScript,
  getTopic,
  neutralPrediction,
  startStage,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, PredictionOutput } from "./types";

const STAGE = "PREDICTION" as const;
const AGENT = "prediction";

export const predictionStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const cached = await loadPrediction(context.runId);
    if (cached) {
      context.cache.prediction = cached;
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: cached };
    }

    const run = await getRun(context);
    const topic = await getTopic(context);
    const script = await getScript(context);
    const pastTopics = await getPastTopics(context);
    const predictionInput = {
      niche: run.niche,
      topic_title: topic.title,
      topic_angle: topic.angle,
      script_hook: script.hook,
      script_body: script.body,
      past_performance: pastTopics.map((past) => ({
        topic_title: past.topic_title,
        hook_text: null,
        ctr: past.ctr,
        avg_view_pct: past.avg_view_pct,
      })),
    };

    let prediction: PredictionOutput;
    let fallback = false;
    try {
      prediction = await withAgentLog(context.prisma, context.runId, AGENT, predictionInput, () =>
        runAgent<typeof predictionInput, PredictionOutput>(AGENT, predictionInput, {
          runId: context.runId,
        }),
      );

      await context.prisma.performancePrediction.upsert({
        where: { runId: context.runId },
        create: {
          runId: context.runId,
          predictedCtr: prediction.predicted_ctr,
          predictedRetention: prediction.predicted_retention,
          score: prediction.score,
          reasoning: prediction.reasoning,
        },
        update: {
          predictedCtr: prediction.predicted_ctr,
          predictedRetention: prediction.predicted_retention,
          score: prediction.score,
          reasoning: prediction.reasoning,
        },
      });
    } catch (error) {
      fallback = true;
      context.logger.error(
        { stage: STAGE, runId: context.runId, err: error },
        "Prediction failed, using neutral fallback",
      );
      prediction = neutralPrediction();
    }

    context.cache.prediction = prediction;
    await completeStage(context, STAGE, AGENT, {
      fallback,
      score: prediction.score,
    });
    return { success: true, data: prediction };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
