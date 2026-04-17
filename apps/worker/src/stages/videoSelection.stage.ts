import { runAgent } from "../clients/aiClient";
import { loadVideoSelection } from "../cache/cache-resume";
import {
  completeStage,
  createStageErrorHandler,
  getTimestamp,
  getTopic,
  startStage,
  TARGET_ORIENTATION,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, VideoSelectionOutput } from "./types";

const STAGE = "VIDEO_SELECTION" as const;
const AGENT = "video_selection";

export const videoSelectionStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const cached = await loadVideoSelection(context.runId);
    if (cached) {
      context.cache.videoSelection = cached;
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: cached };
    }

    const topic = await getTopic(context);
    const timestamp = await getTimestamp(context);
    const selectionInput = {
      topic_title: topic.title,
      topic_angle: topic.angle,
      scenes: timestamp.scenes,
      orientation: TARGET_ORIENTATION,
    };

    const selection = await withAgentLog(context.prisma, context.runId, AGENT, selectionInput, () =>
      runAgent<typeof selectionInput, VideoSelectionOutput>(AGENT, selectionInput, {
        runId: context.runId,
      }),
    );

    await context.prisma.scene.createMany({
      data: selection.scenes.map((scene) => ({
        runId: context.runId,
        index: scene.index,
        startSec: scene.start,
        endSec: scene.end,
        text: scene.text,
        query: scene.query,
        clipUrl: scene.clip_url ?? undefined,
        clipSource: scene.clip_source ?? undefined,
        clipDurationSec: scene.clip_duration_sec ?? undefined,
      })),
    });

    context.cache.videoSelection = selection;
    await completeStage(context, STAGE, AGENT, {
      scenes: selection.scenes.length,
      hits: selection.scenes.filter((scene) => scene.clip_url).length,
    });
    return { success: true, data: selection };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
