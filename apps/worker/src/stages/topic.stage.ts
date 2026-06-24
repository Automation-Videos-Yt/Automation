import { runAgent } from "../clients/aiClient";
import { embedTopicForDedup, findDuplicateTopic } from "../memory/vectorStore";
import { loadTopic } from "../cache/cache-resume";
import {
  completeStage,
  createStageErrorHandler,
  getPastTopics,
  getRun,
  startStage,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, TopicOutput } from "./types";

const STAGE = "TOPIC" as const;
const AGENT = "topic";
const MAX_TOPIC_ATTEMPTS = 3;

export const topicStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const cached = await loadTopic(context.runId);
    if (cached) {
      context.cache.topic = cached;
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: cached };
    }

    const run = await getRun(context);
    const pastTopics = await getPastTopics(context);

    const excludeTitles: string[] = [];
    let topicEmbedding: number[] = [];
    let topic: TopicOutput | null = null;

    for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
      const topicInput = {
        niche: run.niche,
        language_code: run.languageCode,
        past_topics: pastTopics,
        exclude_titles: excludeTitles,
        use_cache: false,
      };

      topic = await withAgentLog(context.prisma, context.runId, excludeTitles.length > 0 ? `topic.retry${attempt - 1}` : AGENT, topicInput, () =>
        runAgent<typeof topicInput, TopicOutput>(AGENT, topicInput, {
          runId: context.runId,
        }),
      );

      topicEmbedding = await embedTopicForDedup(topic.title, topic.angle);
      const duplicate = await findDuplicateTopic(topic.title, topic.angle, context.runId);
      if (!duplicate) {
        break;
      }

      context.logger.warn(
        {
          stage: STAGE,
          runId: context.runId,
          attempt,
          duplicateOf: duplicate.title,
          similarity: duplicate.similarity.toFixed(3),
        },
        "Duplicate topic detected",
      );
      excludeTitles.push(topic.title, duplicate.title);
    }

    if (!topic) {
      throw new Error("topic generation returned no output");
    }

    await context.prisma.topic.create({
      data: {
        runId: context.runId,
        title: topic.title,
        angle: topic.angle,
        rationale: topic.rationale,
        trendScore: topic.trend_score,
        titleEmbedding: topicEmbedding,
      },
    });

    context.cache.topic = topic;
    context.cache.topicEmbedding = topicEmbedding;
    await completeStage(context, STAGE, AGENT, {
      title: topic.title,
      retries: excludeTitles.length / 2,
    });
    return { success: true, data: topic };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
