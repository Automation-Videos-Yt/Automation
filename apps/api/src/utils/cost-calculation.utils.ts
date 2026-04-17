const TTS_PER_CHAR = {
  "openai-tts-1": 0.000015,
  "openai-tts-1-hd": 0.00003,
  elevenlabs: 0.00018,
} as const;

export const THUMBNAIL_PER_IMAGE = {
  low: 0.011,
  medium: 0.042,
  high: 0.167,
  auto: 0.042,
} as const;

const WHISPER_PER_SEC = 0.006 / 60;

const OPENAI_TTS_VOICE_IDS = new Set([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);

export function voiceProviderFromId(
  voiceId: string | null | undefined,
): "openai-tts-1" | "openai-tts-1-hd" | "elevenlabs" | null {
  if (!voiceId) return null;
  if (!OPENAI_TTS_VOICE_IDS.has(voiceId)) return "elevenlabs";
  return "openai-tts-1";
}

export function providerFromTier(
  tier: string | null | undefined,
): "openai-tts-1" | "openai-tts-1-hd" | "elevenlabs" | null {
  if (tier === "elite") return "elevenlabs";
  if (tier === "premium") return "openai-tts-1-hd";
  if (tier === "economy") return "openai-tts-1";
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function computeVoiceUsd(
  voiceProvider: string | null,
  voiceChars: number | null,
): number {
  if (voiceProvider == null || voiceChars == null) return 0;
  if (!(voiceProvider in TTS_PER_CHAR)) return 0;
  return voiceChars * TTS_PER_CHAR[voiceProvider as keyof typeof TTS_PER_CHAR];
}

export function computeWhisperUsd(audioDurationSec: number | null): number {
  if (audioDurationSec == null) return 0;
  return audioDurationSec * WHISPER_PER_SEC;
}

export type VoiceCostFromLog = {
  voiceUsd: number;
  whisperUsd: number;
  voiceProvider: string | null;
  voiceChars: number | null;
  audioDurationSec: number | null;
};

export function deriveVoiceCostFromAgentLog(logRow: {
  inputJson: unknown;
  outputJson: unknown;
}): VoiceCostFromLog {
  const input = asRecord(logRow.inputJson);
  const output = asRecord(logRow.outputJson);

  const tier = asString(input?.tier);
  const inputText = asString(input?.text);
  const outputProvider = asString(output?.provider);
  const outputVoiceId =
    asString(output?.voice_id) ?? asString(output?.voiceId) ?? null;
  const outputDurationSec =
    asNumber(output?.duration_sec) ?? asNumber(output?.durationSec) ?? null;

  let voiceProvider = providerFromTier(tier);
  if (!voiceProvider && outputProvider && outputProvider in TTS_PER_CHAR) {
    voiceProvider = outputProvider as
      | "openai-tts-1"
      | "openai-tts-1-hd"
      | "elevenlabs";
  }
  if (!voiceProvider && outputVoiceId) {
    voiceProvider = voiceProviderFromId(outputVoiceId);
  }

  const voiceChars = inputText ? inputText.length : null;
  const voiceUsd = computeVoiceUsd(voiceProvider, voiceChars);
  const whisperUsd = computeWhisperUsd(outputDurationSec);

  return {
    voiceUsd,
    whisperUsd,
    voiceProvider,
    voiceChars,
    audioDurationSec: outputDurationSec,
  };
}

export function deriveThumbnailUsdFromLog(logRow: { outputJson: unknown }): {
  thumbnailUsd: number;
  thumbnailQuality: string | null;
  thumbnailEnabled: boolean;
} {
  const output = asRecord(logRow.outputJson);
  const quality = asString(output?.quality);
  if (!quality) {
    return {
      thumbnailUsd: 0,
      thumbnailQuality: null,
      thumbnailEnabled: false,
    };
  }
  if (!(quality in THUMBNAIL_PER_IMAGE)) {
    return {
      thumbnailUsd: 0,
      thumbnailQuality: quality,
      thumbnailEnabled: true,
    };
  }
  return {
    thumbnailUsd:
      THUMBNAIL_PER_IMAGE[quality as keyof typeof THUMBNAIL_PER_IMAGE],
    thumbnailQuality: quality,
    thumbnailEnabled: true,
  };
}
