import { runAgent } from "../clients/aiClient";
import { loadTimestamp } from "../cache/cache-resume";
import {
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

function buildFallbackScenesFromNarration(opts: {
  narration: string;
  totalDurationSec: number;
  targetSceneSec: number;
}) {
  const cleaned = opts.narration.replace(/\s+/g, " ").trim();
  const totalDurationSec = Math.max(
    0.5,
    opts.totalDurationSec || opts.targetSceneSec || 6,
  );

  if (!cleaned) {
    return [{ index: 0, start: 0, end: totalDurationSec, text: "" }];
  }

  const sentenceParts = cleaned
    .split(/(?<=[.!?।])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = sentenceParts.length > 0 ? sentenceParts : [cleaned];

  const desiredScenes = Math.max(
    1,
    Math.ceil(totalDurationSec / Math.max(1, opts.targetSceneSec)),
  );
  const chunkSize = Math.max(1, Math.ceil(parts.length / desiredScenes));

  const sceneTexts: string[] = [];
  for (let i = 0; i < parts.length; i += chunkSize) {
    sceneTexts.push(parts.slice(i, i + chunkSize).join(" "));
  }

  const perSceneSec = totalDurationSec / sceneTexts.length;
  return sceneTexts.map((text, index) => {
    const start = index * perSceneSec;
    const end =
      index === sceneTexts.length - 1
        ? totalDurationSec
        : (index + 1) * perSceneSec;
    return { index, start, end, text };
  });
}

function buildScenesFromWords(
  words: { word: string; start: number; end: number }[],
  targetSceneSec: number,
) {
  const scenes = [];
  let currentSceneWords: string[] = [];
  let currentSceneStart = words[0]?.start ?? 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (currentSceneWords.length === 0) {
      currentSceneStart = w.start;
    }
    currentSceneWords.push(w.word);
    const duration = w.end - currentSceneStart;
    
    if (duration >= targetSceneSec || i === words.length - 1) {
      scenes.push({
        index: scenes.length,
        start: currentSceneStart,
        end: w.end,
        text: currentSceneWords.join(" "),
      });
      currentSceneWords = [];
    }
  }
  return scenes;
}

export const timestampStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const run = await getRun(context);
    const voice = await getVoice(context);
    const narration = await getNarration(context);

    if (
      !context.cache.features.enableTimestamp ||
      !isEnglishLanguage(run.languageCode)
    ) {
      const targetSceneSec = 3;
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
        reason: !context.cache.features.enableTimestamp
          ? "feature-disabled"
          : "non-english",
      });
      return { success: true, data: fallback };
    }

    const cached = await loadTimestamp(context.runId);
    if (cached) {
      context.cache.timestamp = cached;
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: cached };
    }

    const targetSceneSec = 3;

    // Check for native timestamps from Voice Stage
    if (voice.word_timestamps && voice.word_timestamps.length > 0) {
      const nativeTimestamp: TimestampOutput = {
        total_duration_sec: voice.duration_sec,
        words: voice.word_timestamps,
        scenes: buildScenesFromWords(voice.word_timestamps, targetSceneSec),
      };

      context.cache.timestamp = nativeTimestamp;
      await completeStage(context, STAGE, AGENT, {
        native: true,
        words: nativeTimestamp.words.length,
        scenes: nativeTimestamp.scenes.length,
      });
      return { success: true, data: nativeTimestamp };
    }
    const timestampInput = {
      audio_path: voice.audio_path,
      script_text: narration,
      target_scene_sec: targetSceneSec,
      language_code: run.languageCode,
    };

    const timestamp = await withAgentLog(
      context.prisma,
      context.runId,
      AGENT,
      timestampInput,
      () =>
        runAgent<typeof timestampInput, TimestampOutput>(
          AGENT,
          timestampInput,
          {
            runId: context.runId,
          },
        ),
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
