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

const COST_ACTIONS = [
  "APPROVE_PIPELINE",
  "REGENERATE_HOOK",
  "MODIFY_SCRIPT",
  "CHANGE_VOICE_TIER",
  "SKIP_THUMBNAIL",
  "CHANGE_TOPIC",
] as const;

const COST_DRIVERS = ["voice", "llm", "thumbnail", "video"] as const;
const PERFORMANCE_DIRECTIONS = ["increase", "decrease", "neutral"] as const;
const ITERATION_CONTROL_REASONS = [
  "max_iterations",
  "converged",
  "improvement_expected",
] as const;
const MAX_CONTROLLER_ITERATIONS = 3;
const NORMALIZED_COST_CAP_USD = 0.2;
const MIN_REWARD_IMPROVEMENT_PCT = 0.02;
const CTR_ACTION_THRESHOLD = 0.5;
const RETENTION_ACTION_THRESHOLD = 0.45;
const PREDICTION_ACTION_THRESHOLD = 0.55;
const APPROVAL_CTR_THRESHOLD = 0.55;
const APPROVAL_RETENTION_THRESHOLD = 0.5;
const APPROVAL_PREDICTION_THRESHOLD = 0.65;
const APPROVAL_COST_THRESHOLD = 0.4;

export type CostAction = (typeof COST_ACTIONS)[number];
export type MainCostDriver = (typeof COST_DRIVERS)[number];
export type PerformanceDirection = (typeof PERFORMANCE_DIRECTIONS)[number];
export type IterationControlReason = (typeof ITERATION_CONTROL_REASONS)[number];
export type VoiceTier = "economy" | "premium" | "elite" | "unknown";

const CostAnalysisSchema = z.object({
  actions: z.array(z.enum(COST_ACTIONS)).min(1).max(4),
  confidence: z.number().min(0).max(1),
  reasoning: z
    .string()
    .min(12)
    .max(420)
    .describe(
      "Short explanation of why these actions maximize reward while controlling cost.",
    ),
  cost_optimization: z.object({
    main_cost_driver: z.enum(COST_DRIVERS),
    suggestion: z
      .string()
      .min(8)
      .max(240)
      .describe("What to reduce or optimize for better ROI."),
  }),
  expected_impact: z.object({
    ctr: z.enum(PERFORMANCE_DIRECTIONS),
    retention: z.enum(PERFORMANCE_DIRECTIONS),
  }),
  iteration_control: z.object({
    should_continue: z.boolean(),
    reason: z.enum(ITERATION_CONTROL_REASONS),
  }),
  learning_signal: z.object({
    pattern_detected: z.string().min(8).max(220).nullable(),
    should_store: z.boolean(),
  }),
});

export type CostAnalysis = z.infer<typeof CostAnalysisSchema>;

const COST_ANALYSIS_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    [
      "You are an autonomous AI Decision and Control Agent for a YouTube Shorts generation pipeline.",
      "You do not just analyze; you choose and execute actions through the control loop.",
      "Objective: maximize reward = (CTR_score*0.5 + retention_score*0.5) - normalized_cost.",
      "Use prediction scores (0..1), current cost, current assets, and memory patterns to decide actions.",
      "You may return one or multiple actions when they are complementary.",
      "Policy guidance: if CTR<0.5 prioritize hook; if retention<0.45 prioritize script; if both weak change topic.",
      "If prediction score is below 5.5/10, avoid APPROVE_PIPELINE and prioritize hook/script/topic interventions.",
      "Conservative policy: if CTR>=0.55 and retention>=0.5 and normalized_cost<0.4, prefer APPROVE_PIPELINE.",
      "If cost is high and performance is weak, prefer cost-down actions (voice downgrade, skip thumbnail).",
      "If performance is strong and ROI supports it, quality upgrades are acceptable.",
      "Do not output disruptive actions when the loop is converged or max iterations has been reached.",
      "Stop loop when iteration>=max_iterations, reward improvement <2%, or APPROVE_PIPELINE is selected.",
      "Return strict JSON only with the required schema.",
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
      "Iteration context:",
      "{controllerJson}",
      "",
      "Output strict JSON only.",
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
  topTopics: string[];
  patterns: string[];
  lowRoiHooks: string[];
  nicheSaturation: boolean;
};

type PipelineDecisionContext = {
  topic: string | null;
  scriptSummary: string | null;
  niche: string | null;
  durationSec: number | null;
  hookText: string | null;
  scriptWordCount: number | null;
  ctrScore: number | null;
  retentionScore: number | null;
  predictionScore: number | null;
  predictedCtr: number | null;
  predictedRetention: number | null;
  voiceTier: VoiceTier;
  thumbnailEnabled: boolean;
  thumbnailQuality: string | null;
};

type BaseCostDecisionContext = {
  pipeline: PipelineDecisionContext;
  history: HistoricalSignals;
};

type CostDecisionContext = BaseCostDecisionContext & {
  iterationCount: number;
  maxIterations: number;
  previousActions: CostAction[];
  previousReward: number | null;
};

type ControllerIterationState = {
  baseFingerprint: string;
  iterationCount: number;
  priorActions: CostAction[];
  lastReward: number | null;
};

type LoopSignals = {
  currentReward: number;
  improvementPct: number | null;
  converged: boolean;
  maxIterationsReached: boolean;
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
const controllerStateByRunId = new Map<string, ControllerIterationState>();

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
  topTopics: [],
  patterns: [],
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

function normalizeScore(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function normalizeCost(totalUsd: number): number {
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return 0;
  return Math.max(0, Math.min(1, totalUsd / NORMALIZED_COST_CAP_USD));
}

function normalizedPredictionQuality(context: CostDecisionContext): number {
  const modelScore =
    context.pipeline.predictionScore == null
      ? null
      : normalizeScore(context.pipeline.predictionScore / 10);
  if (modelScore != null) return modelScore;

  const ctrScore =
    context.pipeline.ctrScore ??
    normalizeScore((context.history.avgCtr ?? 4) / 10) ??
    0.4;
  const retentionScore =
    context.pipeline.retentionScore ??
    normalizeScore((context.history.avgRetention ?? 50) / 100) ??
    0.5;

  return normalizeScore(ctrScore * 0.55 + retentionScore * 0.45) ?? 0.45;
}

function shouldPreferApproval(
  cost: CostSnapshot,
  context: CostDecisionContext,
): boolean {
  const ctrScore =
    context.pipeline.ctrScore ??
    normalizeScore((context.history.avgCtr ?? 4) / 10) ??
    0.4;
  const retentionScore =
    context.pipeline.retentionScore ??
    normalizeScore((context.history.avgRetention ?? 50) / 100) ??
    0.5;

  const neutralOrBetter =
    ctrScore >= APPROVAL_CTR_THRESHOLD &&
    retentionScore >= APPROVAL_RETENTION_THRESHOLD;
  const lowCost = normalizeCost(cost.totalUsd) < APPROVAL_COST_THRESHOLD;
  const strongPrediction =
    normalizedPredictionQuality(context) >= APPROVAL_PREDICTION_THRESHOLD;

  return (
    neutralOrBetter &&
    strongPrediction &&
    lowCost &&
    !context.history.nicheSaturation
  );
}

function buildInterventionActions(context: CostDecisionContext): CostAction[] {
  const ctrScore =
    context.pipeline.ctrScore ??
    normalizeScore((context.history.avgCtr ?? 4) / 10) ??
    0.4;
  const retentionScore =
    context.pipeline.retentionScore ??
    normalizeScore((context.history.avgRetention ?? 50) / 100) ??
    0.5;
  const predictionQuality = normalizedPredictionQuality(context);

  if (
    ctrScore <= CTR_ACTION_THRESHOLD &&
    retentionScore <= RETENTION_ACTION_THRESHOLD
  ) {
    return ["CHANGE_TOPIC"];
  }
  if (ctrScore <= CTR_ACTION_THRESHOLD) {
    return ["REGENERATE_HOOK"];
  }
  if (retentionScore <= RETENTION_ACTION_THRESHOLD) {
    return ["MODIFY_SCRIPT"];
  }
  if (predictionQuality < PREDICTION_ACTION_THRESHOLD) {
    return ["REGENERATE_HOOK"];
  }
  return ["MODIFY_SCRIPT"];
}

function summarizeScript(
  body: string | null | undefined,
  cta: string | null | undefined,
): string | null {
  const scriptBody = (body ?? "").trim();
  const scriptCta = (cta ?? "").trim();
  if (!scriptBody && !scriptCta) return null;
  if (!scriptBody) return compactText(scriptCta, 180);
  const merged = scriptCta ? `${scriptBody} ${scriptCta}` : scriptBody;
  return compactText(merged, 220);
}

function dedupeActions(actions: CostAction[]): CostAction[] {
  const unique: CostAction[] = [];
  for (const action of actions) {
    if (!unique.includes(action)) unique.push(action);
  }
  if (unique.length > 1) {
    return unique.filter((action) => action !== "APPROVE_PIPELINE");
  }
  return unique;
}

function computeReward(
  cost: CostSnapshot,
  context: CostDecisionContext,
): number {
  const ctrScore =
    context.pipeline.ctrScore ??
    normalizeScore((context.history.avgCtr ?? 4) / 10) ??
    0.4;
  const retentionScore =
    context.pipeline.retentionScore ??
    normalizeScore((context.history.avgRetention ?? 50) / 100) ??
    0.5;
  const normalizedCost = normalizeCost(cost.totalUsd);
  return round4(ctrScore * 0.5 + retentionScore * 0.5 - normalizedCost);
}

function computeLoopSignals(
  cost: CostSnapshot,
  context: CostDecisionContext,
): LoopSignals {
  const currentReward = computeReward(cost, context);
  const maxIterationsReached = context.iterationCount >= context.maxIterations;

  let improvementPct: number | null = null;
  let converged = false;
  if (
    context.previousReward != null &&
    Number.isFinite(context.previousReward)
  ) {
    const baseline = Math.max(0.05, Math.abs(context.previousReward));
    improvementPct = (currentReward - context.previousReward) / baseline;
    converged = improvementPct < MIN_REWARD_IMPROVEMENT_PCT;
  }

  return {
    currentReward,
    improvementPct: improvementPct == null ? null : round4(improvementPct),
    converged,
    maxIterationsReached,
  };
}

function selectIterationReason(params: {
  actions: CostAction[];
  loopSignals: LoopSignals;
}): IterationControlReason {
  if (params.loopSignals.maxIterationsReached) return "max_iterations";
  if (params.actions.includes("APPROVE_PIPELINE")) {
    return "converged";
  }
  return "improvement_expected";
}

function learningPattern(context: CostDecisionContext): string | undefined {
  if (context.history.patterns.length > 0) {
    return context.history.patterns[0];
  }
  if (context.history.topSuccessfulHooks.length > 0) {
    return `Successful hook pattern: ${context.history.topSuccessfulHooks[0]}`;
  }
  if (context.history.topTopics.length > 0) {
    return `Top topic pattern: ${context.history.topTopics[0]}`;
  }
  if (context.history.lowRoiHooks.length > 0) {
    return `Low ROI pattern to avoid: ${context.history.lowRoiHooks[0]}`;
  }
  if (context.history.nicheSaturation) {
    return "Niche is showing weak recent ROI; fresh topic angles perform better.";
  }
  return undefined;
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
  const loopSignals = computeLoopSignals(cost, context);
  const mainCostDriver = pickMainCostDriver(cost);
  const ctrScore =
    context.pipeline.ctrScore ??
    normalizeScore((context.history.avgCtr ?? 4) / 10);
  const retentionScore =
    context.pipeline.retentionScore ??
    normalizeScore((context.history.avgRetention ?? 50) / 100);
  const performanceConfidence =
    context.pipeline.predictionScore != null
      ? (normalizeScore(context.pipeline.predictionScore / 10) ?? 0.5)
      : (normalizeScore(
          (ctrScore ?? 0.4) * 0.55 + (retentionScore ?? 0.5) * 0.45,
        ) ?? 0.5);
  const wordCount = context.pipeline.scriptWordCount ?? 0;
  const wordBudget = targetWordBudget(context.pipeline.durationSec);
  const longScript = wordCount > wordBudget;
  const prior = new Set(context.previousActions);

  const lowCtr = (ctrScore ?? 0.4) <= CTR_ACTION_THRESHOLD;
  const lowRetention = (retentionScore ?? 0.5) <= RETENTION_ACTION_THRESHOLD;
  const predictionQuality = normalizedPredictionQuality(context);
  const bothWeak = lowCtr && lowRetention;
  const weightedPerformance = ((ctrScore ?? 0.4) + (retentionScore ?? 0.5)) / 2;
  const highCost = cost.totalUsd >= 0.12;
  const highNormalizedCost = normalizeCost(cost.totalUsd) >= 0.6;
  const lowPerformance =
    weightedPerformance < 0.45 ||
    predictionQuality < PREDICTION_ACTION_THRESHOLD;
  const strongPerformance = weightedPerformance >= 0.72;
  const expensiveVoiceTier =
    (context.pipeline.voiceTier === "premium" ||
      context.pipeline.voiceTier === "elite") &&
    cost.voiceUsd >= 0.02;
  const expensiveThumbnail =
    context.pipeline.thumbnailEnabled && cost.thumbnailUsd >= 0.04;

  const actions: CostAction[] = [];

  if (bothWeak) {
    actions.push("CHANGE_TOPIC");
  } else {
    if (lowCtr && !prior.has("REGENERATE_HOOK")) {
      actions.push("REGENERATE_HOOK");
    }

    if (lowRetention && (!prior.has("MODIFY_SCRIPT") || longScript)) {
      actions.push("MODIFY_SCRIPT");
    }

    if (
      predictionQuality < PREDICTION_ACTION_THRESHOLD &&
      !prior.has("REGENERATE_HOOK")
    ) {
      actions.push("REGENERATE_HOOK");
    }
  }

  if (
    (highCost || highNormalizedCost) &&
    lowPerformance &&
    expensiveVoiceTier
  ) {
    actions.push("CHANGE_VOICE_TIER");
  }

  if (
    (highCost || highNormalizedCost) &&
    lowPerformance &&
    expensiveThumbnail &&
    performanceConfidence < 0.62
  ) {
    actions.push("SKIP_THUMBNAIL");
  }

  if (
    strongPerformance &&
    !highNormalizedCost &&
    context.pipeline.voiceTier !== "elite"
  ) {
    actions.push("CHANGE_VOICE_TIER");
  }

  let normalizedActions = dedupeActions(actions);

  if (context.history.nicheSaturation && (lowCtr || lowRetention)) {
    normalizedActions = ["CHANGE_TOPIC"];
  }

  if (
    loopSignals.maxIterationsReached &&
    !normalizedActions.includes("APPROVE_PIPELINE")
  ) {
    normalizedActions = ["CHANGE_TOPIC"];
  }

  if (normalizedActions.includes("CHANGE_TOPIC")) {
    normalizedActions = ["CHANGE_TOPIC"];
  }

  if (normalizedActions.length === 0) {
    normalizedActions = ["APPROVE_PIPELINE"];
  }

  const shouldDowngradeVoice =
    normalizedActions.includes("CHANGE_VOICE_TIER") &&
    (highCost || highNormalizedCost) &&
    lowPerformance;
  const shouldUpgradeVoice =
    normalizedActions.includes("CHANGE_VOICE_TIER") &&
    strongPerformance &&
    !shouldDowngradeVoice;

  const repeatingSamePlan =
    context.iterationCount > 1 &&
    normalizedActions.length > 0 &&
    normalizedActions.every((action) => prior.has(action));

  let ctrExpectation: PerformanceDirection = "neutral";
  let retentionExpectation: PerformanceDirection = "neutral";
  if (
    normalizedActions.includes("REGENERATE_HOOK") ||
    normalizedActions.includes("CHANGE_TOPIC")
  ) {
    ctrExpectation = "increase";
  }
  if (
    normalizedActions.includes("MODIFY_SCRIPT") ||
    normalizedActions.includes("CHANGE_TOPIC")
  ) {
    retentionExpectation = "increase";
  }
  if (shouldDowngradeVoice && !strongPerformance) {
    ctrExpectation = ctrExpectation === "increase" ? "increase" : "neutral";
  }

  let confidence = 0.58;
  const signalCount = [
    lowCtr,
    lowRetention,
    highCost,
    expensiveVoiceTier,
    expensiveThumbnail,
    context.history.nicheSaturation,
  ].filter(Boolean).length;
  confidence += signalCount * 0.06;
  if (context.iterationCount > 1) confidence += 0.05;
  if (normalizedActions[0] === "APPROVE_PIPELINE") {
    confidence = 0.62 + (performanceConfidence >= 0.68 ? 0.12 : 0);
  }
  if (repeatingSamePlan) confidence = Math.max(confidence, 0.74);
  if (loopSignals.maxIterationsReached) confidence = Math.max(confidence, 0.82);
  confidence = Math.max(0, Math.min(1, round4(confidence)));

  const iterationReason = selectIterationReason({
    actions: normalizedActions,
    loopSignals,
  });
  const shouldContinue = iterationReason === "improvement_expected";

  let patternDetected = learningPattern(context);
  if (normalizedActions.includes("REGENERATE_HOOK")) {
    patternDetected =
      patternDetected ??
      "Curiosity-forward hooks tend to improve CTR in similar runs.";
  } else if (normalizedActions.includes("MODIFY_SCRIPT")) {
    patternDetected =
      patternDetected ??
      "Tighter scripts with pattern interrupts improve retention.";
  }

  const reasoningParts: string[] = [];
  if (lowCtr) reasoningParts.push("predicted CTR is weak");
  if (lowRetention) reasoningParts.push("predicted retention is weak");
  if (highCost || highNormalizedCost)
    reasoningParts.push("cost pressure is high");
  if (shouldDowngradeVoice)
    reasoningParts.push("voice spend is not justified by ROI");
  if (shouldUpgradeVoice)
    reasoningParts.push("high predicted ROI supports voice quality upgrade");
  if (context.iterationCount > 1) {
    reasoningParts.push(
      `iteration ${context.iterationCount} requires escalation-aware control`,
    );
  }
  if (loopSignals.improvementPct != null) {
    reasoningParts.push(
      `reward improvement ${(loopSignals.improvementPct * 100).toFixed(2)}% vs previous iteration`,
    );
  }

  const reasoning =
    reasoningParts.length > 0
      ? `Controller selected ${normalizedActions.join(", ")} because ${reasoningParts.join("; ")}.`
      : "Controller selected APPROVE_PIPELINE because expected performance and cost are already balanced.";

  const costSuggestion = shouldDowngradeVoice
    ? "Downgrade voice tier for this iteration and reserve premium tiers for stronger ROI cases."
    : shouldUpgradeVoice
      ? "Upgrade voice tier to improve perceived quality while ROI remains favorable."
      : normalizedActions.includes("SKIP_THUMBNAIL")
        ? "Skip thumbnail generation this iteration to reduce cost without meaningful CTR loss."
        : defaultSuggestionForDriver(mainCostDriver);

  return {
    actions: normalizedActions,
    confidence,
    reasoning,
    cost_optimization: {
      main_cost_driver: mainCostDriver,
      suggestion: costSuggestion,
    },
    expected_impact: {
      ctr: ctrExpectation,
      retention: retentionExpectation,
    },
    iteration_control: {
      should_continue: shouldContinue,
      reason: iterationReason,
    },
    learning_signal: {
      pattern_detected: patternDetected ?? null,
      should_store:
        normalizedActions.includes("APPROVE_PIPELINE") ||
        normalizedActions.includes("CHANGE_TOPIC") ||
        !!patternDetected,
    },
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
        topicTitle: true,
        topicAngle: true,
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

  const topTopics = Array.from(
    new Set(
      [...topicMemoryRows]
        .sort((a, b) => b.performance - a.performance)
        .slice(0, 5)
        .map((row) =>
          compactText(`${row.topicTitle} (${row.topicAngle})`, 120),
        ),
    ),
  ).slice(0, 3);

  const patterns = Array.from(
    new Set([
      ...topSuccessfulHooks.map((hook) => `High-ROI hook pattern: ${hook}`),
      ...topTopics.map((topic) => `Top topic pattern: ${topic}`),
      ...lowRoiHooks.map((hook) => `Avoid low-ROI hook pattern: ${hook}`),
    ]),
  ).slice(0, 6);

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
    topTopics,
    patterns,
    lowRoiHooks,
    nicheSaturation,
  };
}

async function buildDecisionContext(params: {
  runProfile: {
    niche: string;
    targetDurationSec: number;
    topic: { title: string; angle: string } | null;
    script: {
      hook: string;
      body: string;
      cta: string;
      wordCount: number;
    } | null;
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
}): Promise<BaseCostDecisionContext> {
  const voiceInput = asRecord(params.voiceLog?.inputJson);
  const voiceTierFromInput = normalizeVoiceTier(asString(voiceInput?.tier));
  const voiceTier =
    voiceTierFromInput === "unknown"
      ? voiceTierFromProvider(params.voiceProvider)
      : voiceTierFromInput;

  const history = await loadHistoricalSignals(params.runProfile?.niche ?? null);

  return {
    pipeline: {
      topic: params.runProfile?.topic?.title ?? null,
      scriptSummary: summarizeScript(
        params.runProfile?.script?.body,
        params.runProfile?.script?.cta,
      ),
      niche: params.runProfile?.niche ?? null,
      durationSec: params.runProfile?.targetDurationSec ?? null,
      hookText: params.runProfile?.script?.hook ?? null,
      scriptWordCount: params.runProfile?.script?.wordCount ?? null,
      ctrScore:
        params.runProfile?.prediction?.predictedCtr == null
          ? null
          : normalizeScore(params.runProfile.prediction.predictedCtr / 10),
      retentionScore:
        params.runProfile?.prediction?.predictedRetention == null
          ? null
          : normalizeScore(
              params.runProfile.prediction.predictedRetention / 100,
            ),
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

function baseContextFingerprint(context: BaseCostDecisionContext): string {
  return [
    context.pipeline.topic ?? "",
    context.pipeline.scriptSummary ?? "",
    context.pipeline.niche ?? "",
    context.pipeline.durationSec ?? "",
    context.pipeline.hookText ?? "",
    context.pipeline.scriptWordCount ?? "",
    context.pipeline.ctrScore ?? "",
    context.pipeline.retentionScore ?? "",
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
    context.history.topTopics.join("||"),
    context.history.patterns.join("||"),
    context.history.lowRoiHooks.join("||"),
  ].join("|");
}

function contextFingerprint(context: CostDecisionContext): string {
  return [
    baseContextFingerprint(context),
    context.iterationCount,
    context.maxIterations,
    context.previousActions.join("||"),
    context.previousReward ?? "",
  ].join("|");
}

function resolveIterationContext(params: {
  runId: string;
  forceReanalyze: boolean;
  baseContext: BaseCostDecisionContext;
}): { context: CostDecisionContext; baseFingerprint: string } {
  const baseFingerprint = baseContextFingerprint(params.baseContext);
  const existing = controllerStateByRunId.get(params.runId);

  let iterationCount = 1;
  let previousActions: CostAction[] = [];
  let previousReward: number | null = null;

  if (existing && existing.baseFingerprint === baseFingerprint) {
    iterationCount = existing.iterationCount;
    previousActions = [...existing.priorActions];
    previousReward = existing.lastReward;
    if (params.forceReanalyze) {
      iterationCount = Math.min(
        iterationCount + 1,
        MAX_CONTROLLER_ITERATIONS + 1,
      );
    }
  }

  return {
    baseFingerprint,
    context: {
      ...params.baseContext,
      iterationCount,
      maxIterations: MAX_CONTROLLER_ITERATIONS,
      previousActions: previousActions.slice(-8),
      previousReward,
    },
  };
}

function persistIterationState(params: {
  runId: string;
  baseFingerprint: string;
  iterationCount: number;
  actions: CostAction[];
  reward: number;
}): void {
  const previous = controllerStateByRunId.get(params.runId);
  const sameBase = previous?.baseFingerprint === params.baseFingerprint;
  const prior = sameBase ? (previous?.priorActions ?? []) : [];
  const merged = [...prior, ...params.actions].slice(-12);
  controllerStateByRunId.set(params.runId, {
    baseFingerprint: params.baseFingerprint,
    iterationCount: params.iterationCount,
    priorActions: merged,
    lastReward: round4(params.reward),
  });
}

function normalizeAnalysisOutput(
  analysis: CostAnalysis,
  loopSignals: LoopSignals,
  context: CostDecisionContext,
  cost: CostSnapshot,
): CostAnalysis {
  const actions = dedupeActions(analysis.actions);
  let safeActions: CostAction[] =
    actions.length > 0 ? actions : ["APPROVE_PIPELINE"];

  const ctrScore =
    context.pipeline.ctrScore ??
    normalizeScore((context.history.avgCtr ?? 4) / 10) ??
    0.4;
  const retentionScore =
    context.pipeline.retentionScore ??
    normalizeScore((context.history.avgRetention ?? 50) / 100) ??
    0.5;
  const predictionQuality = normalizedPredictionQuality(context);
  const needsIntervention =
    ctrScore <= CTR_ACTION_THRESHOLD ||
    retentionScore <= RETENTION_ACTION_THRESHOLD ||
    predictionQuality < PREDICTION_ACTION_THRESHOLD ||
    context.history.nicheSaturation;

  const forceApprove =
    loopSignals.maxIterationsReached ||
    shouldPreferApproval(cost, context) ||
    (loopSignals.converged && !needsIntervention);

  if (forceApprove && !safeActions.includes("APPROVE_PIPELINE")) {
    safeActions = ["APPROVE_PIPELINE"];
  }

  if (!forceApprove && needsIntervention) {
    const hasPerformanceAction = safeActions.some(
      (action) =>
        action === "REGENERATE_HOOK" ||
        action === "MODIFY_SCRIPT" ||
        action === "CHANGE_TOPIC",
    );

    if (!hasPerformanceAction) {
      safeActions = dedupeActions([
        ...buildInterventionActions(context),
        ...safeActions.filter((action) => action !== "APPROVE_PIPELINE"),
      ]);
    }

    if (safeActions.length === 0) {
      safeActions = buildInterventionActions(context);
    }
  }

  const confidence = Math.max(0, Math.min(1, analysis.confidence));
  const normalizedReason = selectIterationReason({
    actions: safeActions,
    loopSignals,
  });
  const normalizedShouldContinue = normalizedReason === "improvement_expected";

  const rawPattern = analysis.learning_signal.pattern_detected;
  const normalizedPattern =
    rawPattern == null
      ? null
      : rawPattern.trim().length >= 8
        ? rawPattern.trim()
        : null;

  const reasoning =
    forceApprove && safeActions[0] === "APPROVE_PIPELINE"
      ? "Auto-stabilized to APPROVE_PIPELINE because current reward is converged or cost/performance is already in an acceptable range."
      : analysis.reasoning;

  return {
    ...analysis,
    actions: safeActions,
    confidence: round4(confidence),
    reasoning,
    iteration_control: {
      should_continue: normalizedShouldContinue,
      reason: normalizedReason,
    },
    learning_signal: {
      ...analysis.learning_signal,
      pattern_detected: normalizedPattern,
    },
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
  baseContext: BaseCostDecisionContext,
  options?: EstimateRunCostOptions,
): Promise<CostAnalysisResult> {
  costAnalysisMetrics.requests += 1;

  const resolved = resolveIterationContext({
    runId,
    forceReanalyze: !!options?.forceReanalyze,
    baseContext,
  });
  const context = resolved.context;
  const loopSignals = computeLoopSignals(cost, context);

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
        analysis: normalizeAnalysisOutput(
          buildHeuristicDecision(cost, context),
          loopSignals,
          context,
          cost,
        ),
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
          pipelineJson: JSON.stringify({
            prediction: {
              ctr_score: context.pipeline.ctrScore,
              retention_score: context.pipeline.retentionScore,
            },
            current_assets: {
              topic: context.pipeline.topic,
              hook: context.pipeline.hookText,
              script: context.pipeline.scriptSummary,
              voice_tier: context.pipeline.voiceTier,
            },
            run_context: {
              niche: context.pipeline.niche,
              duration_sec: context.pipeline.durationSec,
              script_word_count: context.pipeline.scriptWordCount,
              thumbnail_enabled: context.pipeline.thumbnailEnabled,
              thumbnail_quality: context.pipeline.thumbnailQuality,
            },
          }),
          costJson: JSON.stringify({
            total: round4(cost.totalUsd),
            normalized: round4(normalizeCost(cost.totalUsd)),
            breakdown: {
              voice: round4(cost.voiceUsd),
              llm: round4(cost.llmUsd),
              thumbnail: round4(cost.thumbnailUsd),
              whisper: round4(cost.whisperUsd),
            },
            source: cost.source,
          }),
          historyJson: JSON.stringify({
            top_hooks: context.history.topSuccessfulHooks,
            top_topics: context.history.topTopics,
            patterns: context.history.patterns,
            low_roi_hooks: context.history.lowRoiHooks,
            avg_ctr: context.history.avgCtr,
            avg_retention: context.history.avgRetention,
            sample_size: context.history.sampleSize,
          }),
          controllerJson: JSON.stringify({
            iteration: context.iterationCount,
            max_iterations: context.maxIterations,
            previous_actions: context.previousActions,
            previous_reward: context.previousReward,
            current_reward: loopSignals.currentReward,
            reward_improvement_pct: loopSignals.improvementPct,
          }),
        });

        result = {
          analysis: normalizeAnalysisOutput(
            analysis,
            loopSignals,
            context,
            cost,
          ),
          model: env.OPENAI_MODEL_COST_ANALYSIS,
        };
        costAnalysisCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + COST_ANALYSIS_CACHE_TTL_MS,
        });
        persistIterationState({
          runId,
          baseFingerprint: resolved.baseFingerprint,
          iterationCount: context.iterationCount,
          actions: result.analysis.actions,
          reward: loopSignals.currentReward,
        });
        costAnalysisMetrics.generated += 1;
        return result;
      }

      costAnalysisCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + COST_ANALYSIS_CACHE_TTL_MS,
      });
      persistIterationState({
        runId,
        baseFingerprint: resolved.baseFingerprint,
        iterationCount: context.iterationCount,
        actions: result.analysis.actions,
        reward: loopSignals.currentReward,
      });
      return result;
    } catch (err) {
      costAnalysisMetrics.failed += 1;
      const fallback: CostAnalysisResult = {
        analysis: normalizeAnalysisOutput(
          buildHeuristicDecision(cost, context),
          loopSignals,
          context,
          cost,
        ),
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
      persistIterationState({
        runId,
        baseFingerprint: resolved.baseFingerprint,
        iterationCount: context.iterationCount,
        actions: fallback.analysis.actions,
        reward: loopSignals.currentReward,
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
        topic: {
          select: {
            title: true,
            angle: true,
          },
        },
        script: {
          select: {
            hook: true,
            body: true,
            cta: true,
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
