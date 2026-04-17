import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
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

type RunCostPayload = Exclude<Awaited<ReturnType<typeof getRunCost>>, null>;

type CostAgentGraphData = {
  runId: string;
  source: "manual" | "autopilot";
  requestedAction: CostAction | null;
  forceReanalyze: boolean;
  payload: RunCostPayload | null;
  analysis: CostAnalysis | null;
  analysisModel: string | null;
  selectedAction: CostAction | null;
  fromStage: StageResetPoint | null;
  control: RunControlOverrides | null;
  reason: string;
  executed: boolean;
  terminal: boolean;
  notFound: boolean;
};

const CostAgentGraphAnnotation = Annotation.Root({
  state: Annotation<CostAgentGraphData>,
});

type CostAgentGraphState = typeof CostAgentGraphAnnotation.State;

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

function seedGraphState(
  runId: string,
  options?: ExecuteCostAgentActionOptions,
): CostAgentGraphData {
  return {
    runId,
    source: options?.source ?? "manual",
    requestedAction: options?.requestedAction ?? null,
    forceReanalyze: options?.forceReanalyze ?? true,
    payload: null,
    analysis: null,
    analysisModel: null,
    selectedAction: null,
    fromStage: null,
    control: null,
    reason: "",
    executed: false,
    terminal: false,
    notFound: false,
  };
}

function withState(
  graphState: CostAgentGraphState,
  patch: Partial<CostAgentGraphData>,
): CostAgentGraphData {
  return { ...graphState.state, ...patch };
}

async function loadContextNode(graphState: CostAgentGraphState) {
  const current = graphState.state;
  const payload = await getRunCost(current.runId, {
    forceReanalyze: current.forceReanalyze,
  });

  if (!payload) {
    return {
      state: withState(graphState, {
        terminal: true,
        notFound: true,
        reason: "run not found",
      }),
    };
  }

  const analysis = payload.cost.analysis;
  const analysisModel = payload.cost.analysisModel;
  if (!analysis) {
    return {
      state: withState(graphState, {
        payload,
        analysis: null,
        analysisModel,
        terminal: true,
        reason: "cost analysis unavailable",
      }),
    };
  }

  return {
    state: withState(graphState, {
      payload,
      analysis,
      analysisModel,
    }),
  };
}

async function selectActionNode(graphState: CostAgentGraphState) {
  const current = graphState.state;
  if (current.terminal) {
    return { state: current };
  }

  const selectedAction =
    current.requestedAction ?? current.analysis?.actions[0] ?? null;
  if (!selectedAction) {
    return {
      state: withState(graphState, {
        terminal: true,
        reason: "no action selected by controller",
      }),
    };
  }

  if (!isActionable(selectedAction)) {
    return {
      state: withState(graphState, {
        selectedAction,
        terminal: true,
        reason: "controller approved pipeline; no execution required",
      }),
    };
  }

  if (!current.analysis?.iteration_control.should_continue) {
    return {
      state: withState(graphState, {
        selectedAction,
        terminal: true,
        reason: `controller stop condition: ${current.analysis?.iteration_control.reason ?? "unknown"}`,
      }),
    };
  }

  return {
    state: withState(graphState, {
      selectedAction,
    }),
  };
}

async function mapExecutionNode(graphState: CostAgentGraphState) {
  const current = graphState.state;
  if (current.terminal) {
    return { state: current };
  }

  if (!current.selectedAction || !current.analysis || !current.payload) {
    return {
      state: withState(graphState, {
        terminal: true,
        reason: "insufficient state to map action execution",
      }),
    };
  }

  const fromStage = stageForAction(current.selectedAction);
  if (!fromStage) {
    return {
      state: withState(graphState, {
        terminal: true,
        reason: "selected action has no execution stage mapping",
      }),
    };
  }

  const control = buildControlOverrides(
    current.selectedAction,
    current.analysis,
    current.payload.cost,
  );

  if (
    current.selectedAction === "CHANGE_VOICE_TIER" &&
    !control?.forceVoiceTier
  ) {
    return {
      state: withState(graphState, {
        fromStage,
        control: null,
        terminal: true,
        reason: "voice tier is already at target level; nothing to change",
      }),
    };
  }

  return {
    state: withState(graphState, {
      fromStage,
      control,
    }),
  };
}

async function executeActionNode(graphState: CostAgentGraphState) {
  const current = graphState.state;
  if (current.terminal) {
    return { state: current };
  }

  if (!current.fromStage) {
    return {
      state: withState(graphState, {
        terminal: true,
        reason: "execution stage is missing",
      }),
    };
  }

  await requeuePipelineRunFromStage(
    current.runId,
    current.fromStage,
    current.control ?? undefined,
  );

  return {
    state: withState(graphState, {
      executed: true,
      reason: "action executed and run requeued",
    }),
  };
}

let compiledCostAgentGraph: ReturnType<typeof buildCostAgentGraph> | null =
  null;

function buildCostAgentGraph() {
  return new StateGraph(CostAgentGraphAnnotation)
    .addNode("loadContext", loadContextNode)
    .addNode("selectAction", selectActionNode)
    .addNode("mapExecution", mapExecutionNode)
    .addNode("executeAction", executeActionNode)
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "selectAction")
    .addEdge("selectAction", "mapExecution")
    .addEdge("mapExecution", "executeAction")
    .addEdge("executeAction", END)
    .compile();
}

function getCostAgentGraph() {
  if (!compiledCostAgentGraph) {
    compiledCostAgentGraph = buildCostAgentGraph();
  }
  return compiledCostAgentGraph;
}

export async function executeCostAgentAction(
  runId: string,
  options?: ExecuteCostAgentActionOptions,
): Promise<ExecuteCostAgentActionResult | null> {
  const output = (await getCostAgentGraph().invoke({
    state: seedGraphState(runId, options),
  })) as CostAgentGraphState;

  const finalState = output.state;
  if (finalState.notFound) return null;

  if (finalState.executed) {
    log.info(
      {
        runId,
        source: finalState.source,
        selectedAction: finalState.selectedAction,
        fromStage: finalState.fromStage,
        control: finalState.control,
      },
      "cost-agent action executed via langgraph",
    );
  }

  return {
    runId,
    source: finalState.source,
    executed: finalState.executed,
    selectedAction: finalState.selectedAction,
    reason: finalState.reason,
    fromStage: finalState.fromStage,
    control: finalState.control,
    analysis: finalState.analysis,
    analysisModel: finalState.analysisModel,
  };
}

export { PipelineServiceError };
