import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { scoped } from "../lib/logger";
import {
  type CostAction,
  type CostAnalysis,
  type CostBreakdown,
} from "./cost.service";
import {
  PipelineServiceError,
  type RunControlOverrides,
  type StageResetPoint,
} from "./pipeline.service";
import {
  getCostAgentRunCost,
  requeueCostAgentRun,
} from "../repositories/cost-agent.repository";
import {
  buildControlOverrides,
  isActionable,
  stageForAction,
} from "../utils/cost-agent.utils";

const log = scoped("cost-agent");

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

type RunCostPayload = Exclude<
  Awaited<ReturnType<typeof getCostAgentRunCost>>,
  null
>;

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
  const payload = await getCostAgentRunCost(
    current.runId,
    current.forceReanalyze,
  );

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

  await requeueCostAgentRun(
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
