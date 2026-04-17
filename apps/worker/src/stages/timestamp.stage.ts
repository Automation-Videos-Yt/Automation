import { runAgent } from "../clients/aiClient";
import { loadTimestamp } from "../cache/cache-resume";
import {
  buildFallbackScenesFromNarration,
  completeStage,
  createStageErrorHandler,
  getNarration,
  getRun,
  getVoice,
  isEnglishLanguage,
  startStage,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, TimestampOutput } from "./types";

const STAGE = "TIMESTAMP" as const;
const AGENT = "timestamp";

export const timestampStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const run = await getRun(context);
    const voice = await getVoice(context);
    const narration = await getNarration(context);

    if (!context.cache.features.enableTimestamp || !isEnglishLanguage(run.languageCode)) {
      const targetSceneSec = run.targetDurationSec < 30 ? 4 : 7.5;
      const fallback: TimestampOutput = {
        total_duration_sec: voice.duration_sec,
        words: [],
        scenes: buildFallbackScenesFromNarration({
          narration,
          totalDurationSec: voice.duration_sec,
          targetSceneSec,
        }),
      };

      context.cache.timestamp = fallback;
      await completeStage(context, STAGE, AGENT, {
        fallback: true,
        reason: !context.cache.features.enableTimestamp ? "feature-disabled" : "non-english",
      });
      return { success: true, data: fallback };
    }

    const cached = await loadTimestamp(context.runId);
    if (cached) {
      context.cache.timestamp = cached;
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: cached };
    }

    const targetSceneSec = run.targetDurationSec < 30 ? 4 : 7.5;
    const timestampInput = {
      audio_path: voice.audio_path,
      script_text: narration,
      target_scene_sec: targetSceneSec,
      language_code: run.languageCode,
    };

    const timestamp = await withAgentLog(context.prisma, context.runId, AGENT, timestampInput, () =>
      runAgent<typeof timestampInput, TimestampOutput>(AGENT, timestampInput, {
        runId: context.runId,
      }),
    );

    context.cache.timestamp = timestamp;
    await completeStage(context, STAGE, AGENT, {
      words: timestamp.words.length,
      scenes: timestamp.scenes.length,
    });
    return { success: true, data: timestamp };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
