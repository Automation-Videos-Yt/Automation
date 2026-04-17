import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { runAgent } from "../clients/aiClient";
import { fileExists } from "../cache/cache-resume";
import {
  completeStage,
  createStageErrorHandler,
  getPrediction,
  getScript,
  getTopic,
  startStage,
  thumbnailTierFromScore,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, ThumbnailOutput } from "./types";

const STAGE = "THUMBNAIL" as const;
const AGENT = "thumbnail";

export const thumbnailStage: PipelineStage = {
  name: STAGE,
  async shouldSkip(context) {
    if (!context.cache.features.enableThumbnail || !context.config.ENABLE_THUMBNAIL_AGENT) {
      context.logger.info({ stage: STAGE, runId: context.runId }, "Stage skipped");
      return true;
    }
    return false;
  },
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const thumbDir = path.join(env.STORAGE_PATH, "thumbnails");
    await mkdir(thumbDir, { recursive: true });
    const thumbPath = path.join(thumbDir, `${context.runId}.png`);

    if (await fileExists(thumbPath)) {
      await context.prisma.video.update({
        where: { runId: context.runId },
        data: { thumbnailPath: thumbPath },
      });
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: { image_path: thumbPath } };
    }

    const topic = await getTopic(context);
    const script = await getScript(context);
    const prediction = await getPrediction(context);
    const tier = thumbnailTierFromScore(prediction.score);
    const thumbnailInput = {
      topic_title: topic.title,
      topic_angle: topic.angle,
      script_hook: script.hook,
      output_path: thumbPath,
      size: tier.size,
      quality: tier.quality,
    };

    try {
      const thumbnail = await withAgentLog(context.prisma, context.runId, AGENT, thumbnailInput, () =>
        runAgent<typeof thumbnailInput, ThumbnailOutput>(AGENT, thumbnailInput, {
          runId: context.runId,
        }),
      );

      await context.prisma.video.update({
        where: { runId: context.runId },
        data: { thumbnailPath: thumbnail.image_path },
      });

      context.cache.thumbnail = thumbnail;
      await completeStage(context, STAGE, AGENT, {
        quality: tier.quality,
        size: tier.size,
      });
      return { success: true, data: thumbnail };
    } catch (error) {
      context.logger.error(
        { stage: STAGE, runId: context.runId, err: error },
        "Thumbnail generation failed, continuing",
      );
      await completeStage(context, STAGE, AGENT, { degraded: true });
      return { success: true, data: null };
    }
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
