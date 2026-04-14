import { prisma } from "../db/prisma";

// ── Rate card (USD, April 2026 pricing) ──────────────────────────────────────
// Update here when providers change their pricing; everything is estimated
// from char counts + durations we already persist.

// Per-char TTS rates
const TTS_PER_CHAR = {
  // voiceId === "alloy" → we used an OpenAI TTS model; which one we infer
  // from the audio bitrate-adjacent signal… in practice we pick by voice id
  // (OpenAI uses named voices, ElevenLabs uses hex/uuid voice ids).
  "openai-tts-1": 0.000015, // $15 / 1M chars
  "openai-tts-1-hd": 0.00003, // $30 / 1M chars
  elevenlabs: 0.00018, // ~$0.18 / 1k chars on the Creator tier
} as const;

// Per-image thumbnail rates (gpt-image-1)
const THUMBNAIL_PER_IMAGE = {
  low: 0.011,
  medium: 0.042,
  high: 0.167,
  auto: 0.042,
} as const;

// Whisper: $0.006 per minute of audio
const WHISPER_PER_SEC = 0.006 / 60;

// Chat LLM baseline: topic + script + hook + prediction + video_meta + video_selection
// query gen + thumbnail prompt craft. Exact token-based rates would require
// capturing usage per AgentLog row, which we don't do yet — ballpark estimate
// from typical runs (~1500 in + 800 out across all calls, mix of gpt-4o +
// gpt-4o-mini).
const LLM_FLAT_ESTIMATE = 0.015;

// Embedding costs (text-embedding-3-small @ $0.02/1M tokens): negligible (<$0.001)
// per run — roll into the flat LLM estimate.

const OPENAI_TTS_VOICE_IDS = new Set([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);

export type CostBreakdown = {
  voiceUsd: number;
  whisperUsd: number;
  thumbnailUsd: number;
  llmUsd: number;
  totalUsd: number;
  source: {
    voiceProvider: string | null;
    voiceChars: number | null;
    audioDurationSec: number | null;
    thumbnailQuality: string | null;
    thumbnailEnabled: boolean;
  };
};

/** Infer the TTS provider from the stored voice_id. */
function voiceProviderFromId(voiceId: string | null | undefined):
  | "openai-tts-1"
  | "openai-tts-1-hd"
  | "elevenlabs"
  | null {
  if (!voiceId) return null;
  if (!OPENAI_TTS_VOICE_IDS.has(voiceId)) return "elevenlabs";
  // Can't distinguish tts-1 vs tts-1-hd from the voice id alone; we record
  // only the named voice. Use tier signal: strong → hd, else → tts-1. We
  // conservatively assume tts-1 here — callers who want accuracy should also
  // pass in the tier (added below).
  return "openai-tts-1";
}

/**
 * Estimate the total USD cost of a single pipeline run.
 * Returns zeroes silently if the run hasn't produced any assets yet.
 */
export async function estimateRunCost(runId: string): Promise<CostBreakdown> {
  const [voice, thumbnailLog, voiceLog] = await Promise.all([
    prisma.voiceAsset.findUnique({ where: { runId } }),
    prisma.agentLog.findFirst({
      where: { runId, agent: "thumbnail", status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.agentLog.findFirst({
      where: { runId, agent: "voice", status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // --- Voice cost ---
  let voiceUsd = 0;
  let voiceChars: number | null = null;
  let voiceProvider: string | null = null;

  if (voice && voiceLog) {
    const input = voiceLog.inputJson as
      | { text?: string; tier?: string }
      | null;
    const tier = input?.tier;
    voiceChars = typeof input?.text === "string" ? input.text.length : null;

    // Provider: prefer the tier input (authoritative) over voice-id inference.
    if (tier === "elite") voiceProvider = "elevenlabs";
    else if (tier === "premium") voiceProvider = "openai-tts-1-hd";
    else if (tier === "economy") voiceProvider = "openai-tts-1";
    else voiceProvider = voiceProviderFromId(voice.voiceId);

    if (voiceChars != null && voiceProvider) {
      voiceUsd = voiceChars * TTS_PER_CHAR[voiceProvider as keyof typeof TTS_PER_CHAR];
    }
  }

  // --- Whisper cost ---
  const audioDurationSec = voice?.durationSec ?? null;
  const whisperUsd =
    audioDurationSec != null ? audioDurationSec * WHISPER_PER_SEC : 0;

  // --- Thumbnail cost ---
  let thumbnailUsd = 0;
  let thumbnailQuality: string | null = null;
  const thumbnailEnabled = !!thumbnailLog;
  if (thumbnailLog) {
    const out = thumbnailLog.outputJson as { quality?: string } | null;
    thumbnailQuality = out?.quality ?? null;
    if (thumbnailQuality && thumbnailQuality in THUMBNAIL_PER_IMAGE) {
      thumbnailUsd =
        THUMBNAIL_PER_IMAGE[thumbnailQuality as keyof typeof THUMBNAIL_PER_IMAGE];
    }
  }

  // --- LLM (flat estimate across all chat agents) ---
  // Only count when there was at least one successful LLM stage.
  const llmHit = await prisma.agentLog.findFirst({
    where: { runId, agent: "script", status: "SUCCESS" },
    select: { id: true },
  });
  const llmUsd = llmHit ? LLM_FLAT_ESTIMATE : 0;

  const totalUsd = voiceUsd + whisperUsd + thumbnailUsd + llmUsd;
  return {
    voiceUsd: round4(voiceUsd),
    whisperUsd: round4(whisperUsd),
    thumbnailUsd: round4(thumbnailUsd),
    llmUsd: round4(llmUsd),
    totalUsd: round4(totalUsd),
    source: {
      voiceProvider,
      voiceChars,
      audioDurationSec,
      thumbnailQuality,
      thumbnailEnabled,
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
