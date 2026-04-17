import { env } from "../config/env";
import { subscribeAll, type PipelineEvent } from "../events/bus";
import { scoped } from "../lib/logger";
import {
  executeCostAgentAction,
  PipelineServiceError,
} from "../services/cost-agent.service";

const log = scoped("cost-agent-autopilot");

let started = false;
const inFlightRuns = new Set<string>();

function isRunCompletionStageEvent(evt: PipelineEvent): boolean {
  if (evt.kind !== "stage") return false;
  const stage = typeof evt.meta?.stage === "string" ? evt.meta.stage : "";
  const status = typeof evt.meta?.status === "string" ? evt.meta.status : "";
  return stage === "DONE" && status === "COMPLETED";
}

async function handleRunCompletion(runId: string): Promise<void> {
  if (inFlightRuns.has(runId)) return;
  inFlightRuns.add(runId);
  try {
    const result = await executeCostAgentAction(runId, {
      forceReanalyze: true,
      source: "autopilot",
    });

    if (!result) {
      log.warn({ runId }, "autopilot skipped: run not found");
      return;
    }

    if (result.executed) {
      log.info(
        {
          runId,
          action: result.selectedAction,
          fromStage: result.fromStage,
          control: result.control,
        },
        "autopilot executed optimization action",
      );
      return;
    }

    log.info(
      {
        runId,
        action: result.selectedAction,
        reason: result.reason,
      },
      "autopilot no-op",
    );
  } catch (err) {
    if (err instanceof PipelineServiceError) {
      log.warn(
        { runId, code: err.code, message: err.message },
        "autopilot blocked by pipeline constraints",
      );
      return;
    }

    log.error({ runId, err }, "autopilot execution failed");
  } finally {
    inFlightRuns.delete(runId);
  }
}

export function startCostAgentAutopilot(): void {
  if (started) return;
  started = true;

  if (!env.ENABLE_AGENTIC_COST_AUTOPILOT) {
    log.info("autopilot disabled by config");
    return;
  }

  subscribeAll((evt) => {
    if (!isRunCompletionStageEvent(evt)) return;
    void handleRunCompletion(evt.runId);
  });

  log.info("autopilot subscribed to pipeline completion events");
}
