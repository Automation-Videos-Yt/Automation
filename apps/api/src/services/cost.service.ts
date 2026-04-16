import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { scoped } from "../lib/logger";

const log = scoped("cost-svc");

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

const COST_ANALYSIS_CACHE_TTL_MS = 5 * 60 * 1000;

const CostAnalysisSchema = z.object({
  summary: z
    .string()
    .min(10)
    .max(280)
    .describe(
      "One concise sentence summarizing where this run spends the most.",
    ),
  dominantDriver: z
    .enum(["voice", "thumbnail", "llm", "whisper", "mixed"])
    .describe("Largest cost bucket for this run."),
  optimizationActions: z
    .array(z.string().min(10).max(220))
    .min(2)
    .max(4)
    .describe("Actionable steps to reduce cost on future runs."),
  estimatedSavingsUsd: z
    .number()
    .min(0)
    .max(5)
    .describe("Conservative total savings estimate for the actions above."),
});

export type CostAnalysis = z.infer<typeof CostAnalysisSchema>;

const COST_ANALYSIS_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    [
      "You are a cost-optimization analyst for an automated YouTube Shorts pipeline.",
      "Given one run's cost breakdown, propose practical ways to reduce cost while keeping quality stable.",
      "Keep recommendations specific and implementation-friendly for engineers.",
      "Do not repeat the same idea in different wording.",
      "Be conservative with estimated savings.",
    ].join(" "),
  ],
  [
    "human",
    [
      "Run ID: {runId}",
      "voiceUsd: {voiceUsd}",
      "whisperUsd: {whisperUsd}",
      "thumbnailUsd: {thumbnailUsd}",
      "llmUsd: {llmUsd}",
      "totalUsd: {totalUsd}",
      "source: {sourceJson}",
      "",
      "Output structured JSON only.",
    ].join("\n"),
  ],
]);

type CostAnalysisMetrics = {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  generated: number;
  failed: number;
  inFlightWaits: number;
  skippedDisabled: number;
  skippedMissingApiKey: number;
  skippedZeroTotal: number;
};

const costAnalysisMetrics: CostAnalysisMetrics = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  generated: 0,
  failed: 0,
  inFlightWaits: 0,
  skippedDisabled: 0,
  skippedMissingApiKey: 0,
  skippedZeroTotal: 0,
};

const costAnalysisCache = new Map<
  string,
  { value: CostAnalysis; expiresAt: number }
>();
const inFlightCostAnalysis = new Map<string, Promise<CostAnalysis | null>>();

export type CostBreakdown = {
  voiceUsd: number;
  whisperUsd: number;
  thumbnailUsd: number;
  llmUsd: number;
  totalUsd: number;
  analysis: CostAnalysis | null;
  analysisModel: string | null;
  source: {
    voiceProvider: string | null;
    voiceChars: number | null;
    audioDurationSec: number | null;
    thumbnailQuality: string | null;
    thumbnailEnabled: boolean;
  };
};

export type EstimateRunCostOptions = {
  forceReanalyze?: boolean;
};

export type CostAnalysisCacheStats = {
  enabled: boolean;
  model: string;
  ttlMs: number;
  now: string;
  entries: number;
  inFlight: number;
  metrics: CostAnalysisMetrics;
};

export type CostHistoryEvent = {
  agent: "script" | "voice" | "thumbnail";
  at: string;
  deltaUsd: number;
  totalUsd: number;
  breakdown: {
    voiceUsd: number;
    whisperUsd: number;
    thumbnailUsd: number;
    llmUsd: number;
    totalUsd: number;
  };
  source: {
    voiceProvider: string | null;
    voiceChars: number | null;
    audioDurationSec: number | null;
    thumbnailQuality: string | null;
    thumbnailEnabled: boolean;
  };
};

export type RunCostHistory = {
  runId: string;
  latest: CostBreakdown;
  events: CostHistoryEvent[];
};

/** Infer the TTS provider from the stored voice_id. */
function voiceProviderFromId(
  voiceId: string | null | undefined,
): "openai-tts-1" | "openai-tts-1-hd" | "elevenlabs" | null {
  if (!voiceId) return null;
  if (!OPENAI_TTS_VOICE_IDS.has(voiceId)) return "elevenlabs";
  // Can't distinguish tts-1 vs tts-1-hd from the voice id alone; we record
  // only the named voice. Use tier signal: strong → hd, else → tts-1. We
  // conservatively assume tts-1 here — callers who want accuracy should also
  // pass in the tier (added below).
  return "openai-tts-1";
}

function providerFromTier(
  tier: string | null | undefined,
): "openai-tts-1" | "openai-tts-1-hd" | "elevenlabs" | null {
  if (tier === "elite") return "elevenlabs";
  if (tier === "premium") return "openai-tts-1-hd";
  if (tier === "economy") return "openai-tts-1";
  return null;
}

type CostSnapshot = Omit<CostBreakdown, "analysis" | "analysisModel">;

type VoiceCostFromLog = {
  voiceUsd: number;
  whisperUsd: number;
  voiceProvider: string | null;
  voiceChars: number | null;
  audioDurationSec: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function computeVoiceUsd(
  voiceProvider: string | null,
  voiceChars: number | null,
): number {
  if (voiceProvider == null || voiceChars == null) return 0;
  if (!(voiceProvider in TTS_PER_CHAR)) return 0;
  return voiceChars * TTS_PER_CHAR[voiceProvider as keyof typeof TTS_PER_CHAR];
}

function computeWhisperUsd(audioDurationSec: number | null): number {
  if (audioDurationSec == null) return 0;
  return audioDurationSec * WHISPER_PER_SEC;
}

function deriveVoiceCostFromAgentLog(logRow: {
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

function deriveThumbnailUsdFromLog(logRow: { outputJson: unknown }): {
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

function pruneExpiredAnalysisCache(now = Date.now()): number {
  let removed = 0;
  for (const [key, value] of costAnalysisCache) {
    if (value.expiresAt <= now) {
      costAnalysisCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

async function runExists(runId: string): Promise<boolean> {
  const run = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  return !!run;
}

function buildAnalysisCacheKey(runId: string, cost: CostSnapshot): string {
  return [
    runId,
    cost.voiceUsd,
    cost.whisperUsd,
    cost.thumbnailUsd,
    cost.llmUsd,
    cost.totalUsd,
    cost.source.voiceProvider ?? "",
    cost.source.voiceChars ?? "",
    cost.source.audioDurationSec ?? "",
    cost.source.thumbnailQuality ?? "",
    String(cost.source.thumbnailEnabled),
  ].join("|");
}

function getCachedAnalysis(key: string): CostAnalysis | null {
  const item = costAnalysisCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    costAnalysisCache.delete(key);
    return null;
  }
  return item.value;
}

async function analyzeCostWithLangChain(
  runId: string,
  cost: CostSnapshot,
  options?: EstimateRunCostOptions,
): Promise<CostAnalysis | null> {
  costAnalysisMetrics.requests += 1;

  if (!env.ENABLE_LANGCHAIN_COST_ANALYSIS) {
    costAnalysisMetrics.skippedDisabled += 1;
    return null;
  }
  if (!env.OPENAI_API_KEY) {
    costAnalysisMetrics.skippedMissingApiKey += 1;
    return null;
  }
  if (cost.totalUsd <= 0) {
    costAnalysisMetrics.skippedZeroTotal += 1;
    return null;
  }

  const cacheKey = buildAnalysisCacheKey(runId, cost);
  pruneExpiredAnalysisCache();

  if (!options?.forceReanalyze) {
    const cached = getCachedAnalysis(cacheKey);
    if (cached) {
      costAnalysisMetrics.cacheHits += 1;
      return cached;
    }
  }
  costAnalysisMetrics.cacheMisses += 1;

  const inFlight = inFlightCostAnalysis.get(cacheKey);
  if (inFlight) {
    costAnalysisMetrics.inFlightWaits += 1;
    return inFlight;
  }

  const task = (async (): Promise<CostAnalysis | null> => {
    try {
      const model = new ChatOpenAI({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL_COST_ANALYSIS,
        temperature: 0.2,
        maxRetries: 1,
        timeout: 15_000,
      });

      const chain = COST_ANALYSIS_PROMPT.pipe(
        model.withStructuredOutput(CostAnalysisSchema),
      );

      const analysis = await chain.invoke({
        runId,
        voiceUsd: cost.voiceUsd.toFixed(4),
        whisperUsd: cost.whisperUsd.toFixed(4),
        thumbnailUsd: cost.thumbnailUsd.toFixed(4),
        llmUsd: cost.llmUsd.toFixed(4),
        totalUsd: cost.totalUsd.toFixed(4),
        sourceJson: JSON.stringify(cost.source),
      });

      costAnalysisCache.set(cacheKey, {
        value: analysis,
        expiresAt: Date.now() + COST_ANALYSIS_CACHE_TTL_MS,
      });
      costAnalysisMetrics.generated += 1;
      return analysis;
    } catch (err) {
      costAnalysisMetrics.failed += 1;
      log.warn(
        { err, runId },
        "langchain cost analysis failed; returning raw breakdown",
      );
      return null;
    } finally {
      inFlightCostAnalysis.delete(cacheKey);
    }
  })();

  inFlightCostAnalysis.set(cacheKey, task);
  return task;
}

/**
 * Estimate the total USD cost of a single pipeline run.
 * Returns zeroes silently if the run hasn't produced any assets yet.
 */
export async function estimateRunCost(
  runId: string,
  options?: EstimateRunCostOptions,
): Promise<CostBreakdown> {
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
    const input = voiceLog.inputJson as { text?: string; tier?: string } | null;
    const tier = input?.tier;
    voiceChars = typeof input?.text === "string" ? input.text.length : null;

    // Provider: prefer the tier input (authoritative) over voice-id inference.
    if (tier === "elite") voiceProvider = "elevenlabs";
    else if (tier === "premium") voiceProvider = "openai-tts-1-hd";
    else if (tier === "economy") voiceProvider = "openai-tts-1";
    else voiceProvider = voiceProviderFromId(voice.voiceId);

    if (voiceChars != null && voiceProvider) {
      voiceUsd = computeVoiceUsd(voiceProvider, voiceChars);
    }
  }

  // --- Whisper cost ---
  const audioDurationSec = voice?.durationSec ?? null;
  const whisperUsd = computeWhisperUsd(audioDurationSec);

  // --- Thumbnail cost ---
  let thumbnailUsd = 0;
  let thumbnailQuality: string | null = null;
  const thumbnailEnabled = !!thumbnailLog;
  if (thumbnailLog) {
    const out = thumbnailLog.outputJson as { quality?: string } | null;
    thumbnailQuality = out?.quality ?? null;
    if (thumbnailQuality && thumbnailQuality in THUMBNAIL_PER_IMAGE) {
      thumbnailUsd =
        THUMBNAIL_PER_IMAGE[
          thumbnailQuality as keyof typeof THUMBNAIL_PER_IMAGE
        ];
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
  const base: CostSnapshot = {
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

  const analysis = await analyzeCostWithLangChain(runId, base, options);

  return {
    ...base,
    analysis,
    analysisModel: analysis ? env.OPENAI_MODEL_COST_ANALYSIS : null,
  };
}

export async function getRunCost(
  runId: string,
  options?: EstimateRunCostOptions,
): Promise<{ runId: string; cost: CostBreakdown } | null> {
  const exists = await runExists(runId);
  if (!exists) return null;
  const cost = await estimateRunCost(runId, options);
  return { runId, cost };
}

export async function getRunCostHistory(
  runId: string,
  limit = 30,
  options?: EstimateRunCostOptions,
): Promise<RunCostHistory | null> {
  const exists = await runExists(runId);
  if (!exists) return null;

  const logs = await prisma.agentLog.findMany({
    where: {
      runId,
      status: "SUCCESS",
      agent: { in: ["script", "voice", "thumbnail"] },
    },
    orderBy: { createdAt: "asc" },
    take: 300,
  });

  const sourceState: CostHistoryEvent["source"] = {
    voiceProvider: null,
    voiceChars: null,
    audioDurationSec: null,
    thumbnailQuality: null,
    thumbnailEnabled: false,
  };
  let voiceUsd = 0;
  let whisperUsd = 0;
  let thumbnailUsd = 0;
  let llmUsd = 0;

  const events: CostHistoryEvent[] = [];
  for (const row of logs) {
    const agent = row.agent as "script" | "voice" | "thumbnail";
    const previousTotal = voiceUsd + whisperUsd + thumbnailUsd + llmUsd;

    if (agent === "script") {
      llmUsd = LLM_FLAT_ESTIMATE;
    } else if (agent === "voice") {
      const voiceCost = deriveVoiceCostFromAgentLog(row);
      voiceUsd = voiceCost.voiceUsd;
      whisperUsd = voiceCost.whisperUsd;
      sourceState.voiceProvider = voiceCost.voiceProvider;
      sourceState.voiceChars = voiceCost.voiceChars;
      sourceState.audioDurationSec = voiceCost.audioDurationSec;
    } else {
      const thumb = deriveThumbnailUsdFromLog(row);
      thumbnailUsd = thumb.thumbnailUsd;
      sourceState.thumbnailQuality = thumb.thumbnailQuality;
      sourceState.thumbnailEnabled = thumb.thumbnailEnabled;
    }

    const totalUsd = voiceUsd + whisperUsd + thumbnailUsd + llmUsd;
    const deltaUsd = totalUsd - previousTotal;

    if (Math.abs(deltaUsd) < 0.0001) {
      continue;
    }

    events.push({
      agent,
      at: row.createdAt.toISOString(),
      deltaUsd: round4(deltaUsd),
      totalUsd: round4(totalUsd),
      breakdown: {
        voiceUsd: round4(voiceUsd),
        whisperUsd: round4(whisperUsd),
        thumbnailUsd: round4(thumbnailUsd),
        llmUsd: round4(llmUsd),
        totalUsd: round4(totalUsd),
      },
      source: { ...sourceState },
    });
  }

  const latest = await estimateRunCost(runId, options);
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const limitedEvents = events.slice(-boundedLimit);

  return {
    runId,
    latest,
    events: limitedEvents,
  };
}

export function getCostAnalysisCacheStats(): CostAnalysisCacheStats {
  pruneExpiredAnalysisCache();
  return {
    enabled: env.ENABLE_LANGCHAIN_COST_ANALYSIS,
    model: env.OPENAI_MODEL_COST_ANALYSIS,
    ttlMs: COST_ANALYSIS_CACHE_TTL_MS,
    now: new Date().toISOString(),
    entries: costAnalysisCache.size,
    inFlight: inFlightCostAnalysis.size,
    metrics: { ...costAnalysisMetrics },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
