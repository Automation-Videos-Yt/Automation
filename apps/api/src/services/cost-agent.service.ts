import { scoped } from "../lib/logger";
import {
  getRunCost,
  type CostAction,
  type CostAnalysis,
  type CostBreakdown,
} from "./cost.service";
import {
  PipelineServiceError,
  requeuePipelineRunFromStage,
  type RunControlOverrides,
  type StageResetPoint,
  type VoiceTierOverride,
} from "./pipeline.service";

const log = scoped("cost-agent");

const ACTIONABLE_ACTIONS = new Set<CostAction>([
  "REGENERATE_HOOK",
  "MODIFY_SCRIPT",
  "CHANGE_VOICE_TIER",
  "SKIP_THUMBNAIL",
  "CHANGE_TOPIC",
]);

export type ExecuteCostAgentActionOptions = {
  requestedAction?: CostAction;
  forceReanalyze?: boolean;
  source?: "manual" | "autopilot";
};

export type ExecuteCostAgentActionResult = {
  runId: string;
  source: "manual" | "autopilot";
  executed: boolean;
  selectedAction: CostAction | null;
  reason: string;
  fromStage: StageResetPoint | null;
  control: RunControlOverrides | null;
  analysis: CostAnalysis | null;
  analysisModel: string | null;
};

function stageForAction(action: CostAction): StageResetPoint | null {
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

function isActionable(action: CostAction): boolean {
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

function buildControlOverrides(
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

export async function executeCostAgentAction(
  runId: string,
  options?: ExecuteCostAgentActionOptions,
): Promise<ExecuteCostAgentActionResult | null> {
  const source = options?.source ?? "manual";
  const payload = await getRunCost(runId, {
    forceReanalyze: options?.forceReanalyze ?? true,
  });
  if (!payload) return null;

  const analysis = payload.cost.analysis;
  const analysisModel = payload.cost.analysisModel;
  if (!analysis) {
    return {
      runId,
      source,
      executed: false,
      selectedAction: null,
      reason: "cost analysis unavailable",
      fromStage: null,
      control: null,
      analysis: null,
      analysisModel,
    };
  }

  const selectedAction =
    options?.requestedAction ?? analysis.actions[0] ?? null;
  if (!selectedAction) {
    return {
      runId,
      source,
      executed: false,
      selectedAction: null,
      reason: "no action selected by controller",
      fromStage: null,
      control: null,
      analysis,
      analysisModel,
    };
  }

  if (!isActionable(selectedAction)) {
    return {
      runId,
      source,
      executed: false,
      selectedAction,
      reason: "controller approved pipeline; no execution required",
      fromStage: null,
      control: null,
      analysis,
      analysisModel,
    };
  }

  if (!analysis.iteration_control.should_continue) {
    return {
      runId,
      source,
      executed: false,
      selectedAction,
      reason: `controller stop condition: ${analysis.iteration_control.reason}`,
      fromStage: null,
      control: null,
      analysis,
      analysisModel,
    };
  }

  const fromStage = stageForAction(selectedAction);
  if (!fromStage) {
    return {
      runId,
      source,
      executed: false,
      selectedAction,
      reason: "selected action has no execution stage mapping",
      fromStage: null,
      control: null,
      analysis,
      analysisModel,
    };
  }

  const control = buildControlOverrides(selectedAction, analysis, payload.cost);
  if (selectedAction === "CHANGE_VOICE_TIER" && !control?.forceVoiceTier) {
    return {
      runId,
      source,
      executed: false,
      selectedAction,
      reason: "voice tier is already at target level; nothing to change",
      fromStage,
      control: null,
      analysis,
      analysisModel,
    };
  }

  await requeuePipelineRunFromStage(runId, fromStage, control ?? undefined);
  log.info(
    { runId, source, selectedAction, fromStage, control },
    "cost-agent action executed",
  );

  return {
    runId,
    source,
    executed: true,
    selectedAction,
    reason: "action executed and run requeued",
    fromStage,
    control,
    analysis,
    analysisModel,
  };
}

export { PipelineServiceError };
