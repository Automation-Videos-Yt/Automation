import { getRunCost } from "../services/cost.service";
import {
  requeuePipelineRunFromStage,
  type RunControlOverrides,
  type StageResetPoint,
} from "../services/pipeline.service";

export async function getCostAgentRunCost(
  runId: string,
  forceReanalyze: boolean,
) {
  return getRunCost(runId, { forceReanalyze });
}

export async function requeueCostAgentRun(
  runId: string,
  fromStage: StageResetPoint,
  control?: RunControlOverrides,
) {
  return requeuePipelineRunFromStage(runId, fromStage, control);
}
