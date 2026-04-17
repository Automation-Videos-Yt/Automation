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

const COST_DECISIONS = [
  "APPROVE_PIPELINE",
  "REGENERATE_HOOK",
  "MODIFY_SCRIPT",
  "CHANGE_VOICE_TIER",
  "SKIP_THUMBNAIL",
  "CHANGE_TOPIC",
] as const;

const COST_DRIVERS = ["voice", "llm", "thumbnail", "video"] as const;
const PERFORMANCE_DIRECTIONS = ["increase", "decrease", "neutral"] as const;

export type CostDecision = (typeof COST_DECISIONS)[number];
export type MainCostDriver = (typeof COST_DRIVERS)[number];
export type PerformanceDirection = (typeof PERFORMANCE_DIRECTIONS)[number];
export type VoiceTier = "economy" | "premium" | "elite" | "unknown";

const CostAnalysisSchema = z.object({
  decision: z.enum(COST_DECISIONS),
  reasoning: z
    .string()
    .min(12)
    .max(320)
    .describe(
      "Short explanation of why this decision improves cost-performance efficiency.",
    ),
  cost_optimization: z.object({
    main_cost_driver: z.enum(COST_DRIVERS),
    suggestion: z
      .string()
      .min(8)
      .max(240)
      .describe("What to reduce or optimize for better ROI."),
  }),
  performance_expectation: z.object({
    ctr: z.enum(PERFORMANCE_DIRECTIONS),
    retention: z.enum(PERFORMANCE_DIRECTIONS),
  }),
});

export type CostAnalysis = z.infer<typeof CostAnalysisSchema>;

const COST_ANALYSIS_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    [
      "You are an AI Cost Optimization and Decision Agent for a YouTube automation system.",
      "Your goal is to maximize expected CTR, retention, and engagement while minimizing cost.",
      "You must choose one concrete action decision, not just analysis.",
      "Use pipeline outputs, cost breakdown, and historical memory to make the decision.",
      "Prefer historically strong patterns and avoid poor ROI patterns.",
      "When spend is high but expected performance is weak, prioritize cost-saving actions.",
      "When performance risk is high, prioritize actions that improve hook/script/topic quality.",
      "Return only structured JSON with the required schema.",
    ].join(" "),
  ],
  [
    "human",
    [
      "Run ID: {runId}",
      "Pipeline outputs:",
      "{pipelineJson}",
      "",
      "Cost breakdown:",
      "{costJson}",
      "",
      "Historical memory:",
      "{historyJson}",
      "",
      "Choose exactly one decision and output structured JSON only.",
    ].join("\n"),
  ],
]);

type HistoricalSignals = {
  sampleSize: number;
  avgCtr: number | null;
  avgRetention: number | null;
  avgPerformance: number | null;
  strongPatternCount: number;
  weakPatternCount: number;
  topSuccessfulHooks: string[];
  lowRoiHooks: string[];
  nicheSaturation: boolean;
};

type PipelineDecisionContext = {
  niche: string | null;
  durationSec: number | null;
  hookText: string | null;
  scriptWordCount: number | null;
  predictionScore: number | null;
  predictedCtr: number | null;
  predictedRetention: number | null;
  voiceTier: VoiceTier;
  thumbnailEnabled: boolean;
  thumbnailQuality: string | null;
};

type CostDecisionContext = {
  pipeline: PipelineDecisionContext;
  history: HistoricalSignals;
};

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

type CostAnalysisResult = {
  analysis: CostAnalysis;
  model: string;
};

const costAnalysisCache = new Map<
  string,
  { value: CostAnalysisResult; expiresAt: number }
>();
const inFlightCostAnalysis = new Map<string, Promise<CostAnalysisResult>>();

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

const EMPTY_HISTORICAL_SIGNALS: HistoricalSignals = {
  sampleSize: 0,
  avgCtr: null,
  avgRetention: null,
  avgPerformance: null,
  strongPatternCount: 0,
  weakPatternCount: 0,
  topSuccessfulHooks: [],
  lowRoiHooks: [],
  nicheSaturation: false,
};

function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (nums.length === 0) return null;
  const sum = nums.reduce((acc, value) => acc + value, 0);
  return sum / nums.length;
}

function normalizeVoiceTier(value: unknown): VoiceTier {
  if (value === "economy" || value === "premium" || value === "elite") {
    return value;
  }
  return "unknown";
}

function voiceTierFromProvider(provider: string | null): VoiceTier {
  if (provider === "elevenlabs") return "elite";
  if (provider === "openai-tts-1-hd") return "premium";
  if (provider === "openai-tts-1") return "economy";
  return "unknown";
}

function compactText(text: string, maxLen = 96): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function targetWordBudget(durationSec: number | null): number {
  if (durationSec == null || durationSec <= 0) return 170;
  return Math.max(45, Math.round(durationSec * 2.8));
}

function pickMainCostDriver(cost: CostSnapshot): MainCostDriver {
  const buckets: Array<[MainCostDriver, number]> = [
    ["voice", cost.voiceUsd],
    ["llm", cost.llmUsd],
    ["thumbnail", cost.thumbnailUsd],
    // We do not persist a dedicated "video" dollar amount yet. Whisper runtime
    // is used as the nearest direct media-processing proxy.
    ["video", cost.whisperUsd],
  ];
  buckets.sort((a, b) => b[1] - a[1]);
  return buckets[0]?.[0] ?? "llm";
}

function defaultSuggestionForDriver(driver: MainCostDriver): string {
  if (driver === "voice") {
    return "Reserve premium or elite voice tiers for high-confidence runs only.";
  }
  if (driver === "thumbnail") {
    return "Use thumbnail generation only for high-potential runs or upload candidates.";
  }
  if (driver === "video") {
    return "Reduce media-processing load by keeping duration tight and scene count focused.";
  }
  return "Reduce regeneration loops and reuse stable prompts to cap LLM spend.";
}

function buildHeuristicDecision(
  cost: CostSnapshot,
  context: CostDecisionContext,
): CostAnalysis {
  const mainCostDriver = pickMainCostDriver(cost);
  const predictionScore = context.pipeline.predictionScore ?? 5;
  const predictedCtr =
    context.pipeline.predictedCtr ?? context.history.avgCtr ?? 4;
  const predictedRetention =
    context.pipeline.predictedRetention ?? context.history.avgRetention ?? 50;
  const wordCount = context.pipeline.scriptWordCount ?? 0;
  const wordBudget = targetWordBudget(context.pipeline.durationSec);

  const lowCtr = predictedCtr < 3.5 || predictionScore < 4.8;
  const lowRetention = predictedRetention < 42;
  const highCost = cost.totalUsd >= 0.12;
  const expensiveVoiceTier =
    (context.pipeline.voiceTier === "premium" ||
      context.pipeline.voiceTier === "elite") &&
    cost.voiceUsd >= 0.02;
  const expensiveThumbnail =
    context.pipeline.thumbnailEnabled && cost.thumbnailUsd >= 0.04;

  if (context.history.nicheSaturation && (lowCtr || lowRetention)) {
    return {
      decision: "CHANGE_TOPIC",
      reasoning:
        "Recent runs in this niche show weak ROI and this run's expected performance is also low, so shifting to a fresher angle is the most efficient move.",
      cost_optimization: {
        main_cost_driver: mainCostDriver,
        suggestion:
          "Change to a less saturated topic before spending more on premium voice, thumbnails, or retries.",
      },
      performance_expectation: { ctr: "increase", retention: "increase" },
    };
  }

  if (
    lowCtr &&
    (highCost ||
      context.history.weakPatternCount > context.history.strongPatternCount)
  ) {
    return {
      decision: "REGENERATE_HOOK",
      reasoning:
        "Expected CTR is below target while spend is non-trivial, so improving the opening hook gives the best chance to lift ROI before further costs.",
      cost_optimization: {
        main_cost_driver: mainCostDriver,
        suggestion:
          "Generate 3-5 stronger curiosity-gap hooks and keep the first 2-3 seconds specific and high-stakes.",
      },
      performance_expectation: { ctr: "increase", retention: "neutral" },
    };
  }

  if (lowRetention && (wordCount > wordBudget || highCost)) {
    return {
      decision: "MODIFY_SCRIPT",
      reasoning:
        "Predicted retention is weak for the current script density, so tightening structure should improve hold rate and reduce unnecessary voice spend.",
      cost_optimization: {
        main_cost_driver: mainCostDriver,
        suggestion:
          "Shorten and simplify the script, move payoff earlier, and remove low-value filler lines.",
      },
      performance_expectation: { ctr: "neutral", retention: "increase" },
    };
  }

  if (expensiveVoiceTier && predictionScore < 7.2) {
    return {
      decision: "CHANGE_VOICE_TIER",
      reasoning:
        "The selected voice tier is expensive relative to expected performance, so downgrading tier preserves budget with limited downside.",
      cost_optimization: {
        main_cost_driver: "voice",
        suggestion:
          "Downgrade to economy for this run and reserve premium or elite only for higher-confidence predictions.",
      },
      performance_expectation: { ctr: "neutral", retention: "neutral" },
    };
  }

  if (expensiveThumbnail && predictionScore < 5.2) {
    return {
      decision: "SKIP_THUMBNAIL",
      reasoning:
        "Thumbnail spend is high for a low-confidence run, so skipping it improves cost efficiency without major retention impact.",
      cost_optimization: {
        main_cost_driver: "thumbnail",
        suggestion:
          "Skip thumbnail generation for this run and apply thumbnails only to strong predicted performers.",
      },
      performance_expectation: { ctr: "neutral", retention: "neutral" },
    };
  }

  return {
    decision: "APPROVE_PIPELINE",
    reasoning:
      "Current expected performance and spend are reasonably balanced, so the pipeline can proceed without extra regeneration cost.",
    cost_optimization: {
      main_cost_driver: mainCostDriver,
      suggestion: defaultSuggestionForDriver(mainCostDriver),
    },
    performance_expectation: { ctr: "neutral", retention: "neutral" },
  };
}

async function loadHistoricalSignals(
  niche: string | null,
): Promise<HistoricalSignals> {
  if (!niche) {
    return { ...EMPTY_HISTORICAL_SIGNALS };
  }

  const [topicMemoryRows, hookMemoryRows, recentRuns] = await Promise.all([
    prisma.topicMemory.findMany({
      where: { niche },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        ctr: true,
        avgViewPct: true,
        performance: true,
      },
    }),
    prisma.hookMemory.findMany({
      where: { niche },
      orderBy: { performance: "desc" },
      take: 30,
      select: {
        hookText: true,
        ctr: true,
        avgViewPct: true,
        performance: true,
      },
    }),
    prisma.pipelineRun.findMany({
      where: { niche },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        analytics: {
          orderBy: { snapshotAt: "desc" },
          take: 1,
          select: { ctr: true, avgViewPercentage: true },
        },
      },
    }),
  ]);

  const latestAnalytics = recentRuns
    .map((run) => run.analytics[0] ?? null)
    .filter(
      (
        value,
      ): value is { ctr: number | null; avgViewPercentage: number | null } =>
        value != null,
    );

  const ctrValues: Array<number | null | undefined> = [
    ...topicMemoryRows.map((row) => row.ctr),
    ...hookMemoryRows.map((row) => row.ctr),
    ...latestAnalytics.map((row) => row.ctr),
  ];
  const retentionValues: Array<number | null | undefined> = [
    ...topicMemoryRows.map((row) => row.avgViewPct),
    ...hookMemoryRows.map((row) => row.avgViewPct),
    ...latestAnalytics.map((row) => row.avgViewPercentage),
  ];
  const perfValues = [
    ...topicMemoryRows.map((row) => row.performance),
    ...hookMemoryRows.map((row) => row.performance),
  ];

  const avgCtr = average(ctrValues);
  const avgRetention = average(retentionValues);
  const avgPerformance = average(perfValues);
  const strongPatternCount = perfValues.filter((value) => value >= 0.67).length;
  const weakPatternCount = perfValues.filter((value) => value <= 0.4).length;

  const topSuccessfulHooks = Array.from(
    new Set(
      hookMemoryRows
        .filter(
          (row) =>
            row.performance >= 0.67 ||
            (row.ctr ?? 0) >= 4.5 ||
            (row.avgViewPct ?? 0) >= 55,
        )
        .map((row) => compactText(row.hookText)),
    ),
  ).slice(0, 3);

  const lowRoiHooks = Array.from(
    new Set(
      [...hookMemoryRows]
        .sort((a, b) => a.performance - b.performance)
        .filter(
          (row) =>
            row.performance <= 0.4 ||
            ((row.ctr ?? 100) < 2.5 && (row.avgViewPct ?? 100) < 45),
        )
        .map((row) => compactText(row.hookText)),
    ),
  ).slice(0, 2);

  const sampleSize =
    topicMemoryRows.length + hookMemoryRows.length + latestAnalytics.length;
  const nicheSaturation =
    sampleSize >= 16 &&
    (avgCtr ?? 100) <= 3.2 &&
    (avgRetention ?? 100) <= 45 &&
    weakPatternCount >= strongPatternCount + 2;

  return {
    sampleSize,
    avgCtr: avgCtr == null ? null : round4(avgCtr),
    avgRetention: avgRetention == null ? null : round4(avgRetention),
    avgPerformance: avgPerformance == null ? null : round4(avgPerformance),
    strongPatternCount,
    weakPatternCount,
    topSuccessfulHooks,
    lowRoiHooks,
    nicheSaturation,
  };
}

async function buildDecisionContext(params: {
  runProfile: {
    niche: string;
    targetDurationSec: number;
    script: { hook: string; wordCount: number } | null;
    prediction: {
      score: number;
      predictedCtr: number;
      predictedRetention: number;
    } | null;
  } | null;
  voiceLog: { inputJson: unknown } | null;
  voiceProvider: string | null;
  thumbnailEnabled: boolean;
  thumbnailQuality: string | null;
}): Promise<CostDecisionContext> {
  const voiceInput = asRecord(params.voiceLog?.inputJson);
  const voiceTierFromInput = normalizeVoiceTier(asString(voiceInput?.tier));
  const voiceTier =
    voiceTierFromInput === "unknown"
      ? voiceTierFromProvider(params.voiceProvider)
      : voiceTierFromInput;

  const history = await loadHistoricalSignals(params.runProfile?.niche ?? null);

  return {
    pipeline: {
      niche: params.runProfile?.niche ?? null,
      durationSec: params.runProfile?.targetDurationSec ?? null,
      hookText: params.runProfile?.script?.hook ?? null,
      scriptWordCount: params.runProfile?.script?.wordCount ?? null,
      predictionScore: params.runProfile?.prediction?.score ?? null,
      predictedCtr: params.runProfile?.prediction?.predictedCtr ?? null,
      predictedRetention:
        params.runProfile?.prediction?.predictedRetention ?? null,
      voiceTier,
      thumbnailEnabled: params.thumbnailEnabled,
      thumbnailQuality: params.thumbnailQuality,
    },
    history,
  };
}

function contextFingerprint(context: CostDecisionContext): string {
  return [
    context.pipeline.niche ?? "",
    context.pipeline.durationSec ?? "",
    context.pipeline.hookText ?? "",
    context.pipeline.scriptWordCount ?? "",
    context.pipeline.predictionScore ?? "",
    context.pipeline.predictedCtr ?? "",
    context.pipeline.predictedRetention ?? "",
    context.pipeline.voiceTier,
    String(context.pipeline.thumbnailEnabled),
    context.pipeline.thumbnailQuality ?? "",
    context.history.sampleSize,
    context.history.avgCtr ?? "",
    context.history.avgRetention ?? "",
    context.history.avgPerformance ?? "",
    context.history.strongPatternCount,
    context.history.weakPatternCount,
    String(context.history.nicheSaturation),
    context.history.topSuccessfulHooks.join("||"),
    context.history.lowRoiHooks.join("||"),
  ].join("|");
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

function buildAnalysisCacheKey(
  runId: string,
  cost: CostSnapshot,
  context: CostDecisionContext,
): string {
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
    contextFingerprint(context),
  ].join("|");
}

function getCachedAnalysis(key: string): CostAnalysisResult | null {
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
  context: CostDecisionContext,
  options?: EstimateRunCostOptions,
): Promise<CostAnalysisResult> {
  costAnalysisMetrics.requests += 1;

  const cacheKey = buildAnalysisCacheKey(runId, cost, context);
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

  const task = (async (): Promise<CostAnalysisResult> => {
    try {
      const heuristic = (): CostAnalysisResult => ({
        analysis: buildHeuristicDecision(cost, context),
        model: "heuristic",
      });

      let result: CostAnalysisResult;
      if (!env.ENABLE_LANGCHAIN_COST_ANALYSIS) {
        costAnalysisMetrics.skippedDisabled += 1;
        result = heuristic();
      } else if (!env.OPENAI_API_KEY) {
        costAnalysisMetrics.skippedMissingApiKey += 1;
        result = heuristic();
      } else if (cost.totalUsd <= 0) {
        costAnalysisMetrics.skippedZeroTotal += 1;
        result = heuristic();
      } else {
        const model = new ChatOpenAI({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL_COST_ANALYSIS,
          temperature: 0.15,
          maxRetries: 1,
          timeout: 15_000,
        });

        const chain = COST_ANALYSIS_PROMPT.pipe(
          model.withStructuredOutput(CostAnalysisSchema),
        );

        const analysis = await chain.invoke({
          runId,
          pipelineJson: JSON.stringify(context.pipeline),
          costJson: JSON.stringify({
            llmCostUsd: round4(cost.llmUsd),
            voiceCostUsd: round4(cost.voiceUsd),
            videoCostUsd: round4(cost.whisperUsd),
            thumbnailCostUsd: round4(cost.thumbnailUsd),
            totalCostUsd: round4(cost.totalUsd),
            source: cost.source,
          }),
          historyJson: JSON.stringify(context.history),
        });

        result = {
          analysis,
          model: env.OPENAI_MODEL_COST_ANALYSIS,
        };
        costAnalysisCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + COST_ANALYSIS_CACHE_TTL_MS,
        });
        costAnalysisMetrics.generated += 1;
        return result;
      }

      costAnalysisCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + COST_ANALYSIS_CACHE_TTL_MS,
      });
      return result;
    } catch (err) {
      costAnalysisMetrics.failed += 1;
      const fallback: CostAnalysisResult = {
        analysis: buildHeuristicDecision(cost, context),
        model: "heuristic",
      };
      log.warn(
        { err, runId },
        "langchain cost analysis failed; using heuristic decision",
      );
      costAnalysisCache.set(cacheKey, {
        value: fallback,
        expiresAt: Date.now() + COST_ANALYSIS_CACHE_TTL_MS,
      });
      return fallback;
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
  const [voice, thumbnailLog, voiceLog, runProfile] = await Promise.all([
    prisma.voiceAsset.findUnique({ where: { runId } }),
    prisma.agentLog.findFirst({
      where: { runId, agent: "thumbnail", status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.agentLog.findFirst({
      where: { runId, agent: "voice", status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.pipelineRun.findUnique({
      where: { id: runId },
      select: {
        niche: true,
        targetDurationSec: true,
        script: {
          select: {
            hook: true,
            wordCount: true,
          },
        },
        prediction: {
          select: {
            score: true,
            predictedCtr: true,
            predictedRetention: true,
          },
        },
      },
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

  const context = await buildDecisionContext({
    runProfile,
    voiceLog: voiceLog ? { inputJson: voiceLog.inputJson } : null,
    voiceProvider,
    thumbnailEnabled,
    thumbnailQuality,
  });

  const analysisResult = await analyzeCostWithLangChain(
    runId,
    base,
    context,
    options,
  );

  return {
    ...base,
    analysis: analysisResult.analysis,
    analysisModel: analysisResult.model,
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
