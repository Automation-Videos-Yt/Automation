import type {
  CostAction,
  CostAnalysis,
  CostBreakdown,
} from "../services/cost.service";
import type {
  RunControlOverrides,
  StageResetPoint,
  VoiceTierOverride,
} from "../services/pipeline.service";

const ACTIONABLE_ACTIONS = new Set<CostAction>([
  "REGENERATE_HOOK",
  "MODIFY_SCRIPT",
  "CHANGE_VOICE_TIER",
  "SKIP_THUMBNAIL",
  "CHANGE_TOPIC",
]);

export function stageForAction(action: CostAction): StageResetPoint | null {
  switch (action) {
    case "CHANGE_TOPIC":
      return "TOPIC";
    case "MODIFY_SCRIPT":
      return "SCRIPT";
    case "REGENERATE_HOOK":
      return "HOOK";
    case "CHANGE_VOICE_TIER":
      return "VOICE";
    case "SKIP_THUMBNAIL":
      return "THUMBNAIL";
    default:
      return null;
  }
}

export function isActionable(action: CostAction): boolean {
  return ACTIONABLE_ACTIONS.has(action);
}

function currentVoiceTier(provider: string | null): VoiceTierOverride {
  if (provider === "elevenlabs") return "elite";
  if (provider === "openai-tts-1-hd") return "premium";
  return "economy";
}

function nextUpgradeTier(current: VoiceTierOverride): VoiceTierOverride {
  if (current === "economy") return "premium";
  if (current === "premium") return "elite";
  return "elite";
}

function resolveVoiceTierOverride(
  analysis: CostAnalysis,
  cost: CostBreakdown,
): VoiceTierOverride | null {
  const current = currentVoiceTier(cost.source.voiceProvider);
  const downgrade =
    analysis.cost_optimization.main_cost_driver === "voice" ||
    cost.totalUsd >= 0.12 ||
    (analysis.expected_impact.ctr !== "increase" &&
      analysis.expected_impact.retention !== "increase");

  if (downgrade) {
    return current === "economy" ? null : "economy";
  }

  const upgraded = nextUpgradeTier(current);
  return upgraded === current ? null : upgraded;
}

export function buildControlOverrides(
  action: CostAction,
  analysis: CostAnalysis,
  cost: CostBreakdown,
): RunControlOverrides | null {
  if (action === "CHANGE_VOICE_TIER") {
    const forceVoiceTier = resolveVoiceTierOverride(analysis, cost);
    if (!forceVoiceTier) return null;
    return {
      forceVoiceTier,
      sourceAction: action,
    };
  }

  if (action === "SKIP_THUMBNAIL") {
    return {
      forceSkipThumbnail: true,
      sourceAction: action,
    };
  }

  return {
    sourceAction: action,
  };
}
