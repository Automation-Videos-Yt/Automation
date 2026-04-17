import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "../clients/aiClient";
import { env } from "../config/env";
import { loadVoice } from "../cache/cache-resume";
import {
  completeStage,
  createStageErrorHandler,
  getNarration,
  getPrediction,
  getRun,
  startStage,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, VoiceOutput } from "./types";

const STAGE = "VOICE" as const;
const AGENT = "voice";

function voiceTierFromScore(score: number): "elite" | "premium" | "economy" {
  return score >= 7.5 ? "premium" : "economy";
}

export const voiceStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const cached = await loadVoice(context.runId);
    if (cached) {
      context.cache.voice = cached;
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: cached };
    }

    const run = await getRun(context);
    const prediction = await getPrediction(context);
    const narration = await getNarration(context);

    const audioDir = path.join(env.STORAGE_PATH, "audio");
    await mkdir(audioDir, { recursive: true });
    const audioPath = path.join(audioDir, `${context.runId}.mp3`);
    const forcedTier = context.cache.control?.forceVoiceTier;
    const tier = forcedTier ?? voiceTierFromScore(prediction.score);
    const voiceInput = {
      text: narration,
      output_path: audioPath,
      tier,
      language_code: run.languageCode,
    };

    const voice = await withAgentLog(
      context.prisma,
      context.runId,
      AGENT,
      voiceInput,
      () =>
        runAgent<typeof voiceInput, VoiceOutput>(AGENT, voiceInput, {
          runId: context.runId,
        }),
    );

    await context.prisma.voiceAsset.create({
      data: {
        runId: context.runId,
        audioPath: voice.audio_path,
        durationSec: voice.duration_sec,
        voiceId: voice.voice_id,
      },
    });

    context.cache.voice = voice;
    context.cache.narration = narration;
    await completeStage(context, STAGE, AGENT, {
      durationSec: voice.duration_sec,
      tier,
      forced: Boolean(forcedTier),
    });
    return { success: true, data: voice };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
