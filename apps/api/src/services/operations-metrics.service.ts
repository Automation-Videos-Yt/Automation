import { prisma } from "../db/prisma";
import { estimateRunCost } from "./cost.service";

export type OperationsStageMetric = {
  stage: string;
  failures: number;
  avgRetries: number;
};

export type OperationsMetricsResponse = {
  windowDays: number;
  totals: {
    created: number;
    completed: number;
    failed: number;
    successRate: number;
    avgRuntimeSec: number;
    avgCostUsd: number;
  };
  performance: {
    avgPredictedCtr: number;
    avgActualCtr: number;
    ctrDelta: number;
  };
  stages: OperationsStageMetric[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function getOperationsMetrics(
  days = 28,
): Promise<OperationsMetricsResponse> {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days)));
  const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const runs = await prisma.pipelineRun.findMany({
    where: { createdAt: { gte: from } },
    orderBy: { createdAt: "desc" },
    include: {
      prediction: {
        select: {
          predictedCtr: true,
        },
      },
      analytics: {
        orderBy: { snapshotAt: "desc" },
        take: 1,
        select: {
          ctr: true,
        },
      },
    },
  });

  const created = runs.length;
  const completed = runs.filter((run) => run.status === "COMPLETED").length;
  const failed = runs.filter((run) => run.status === "FAILED").length;
  const successRate = created === 0 ? 0 : completed / created;

  const runtimeValues = runs
    .filter((run) => run.startedAt && run.completedAt)
    .map(
      (run) =>
        (run.completedAt!.getTime() - run.startedAt!.getTime()) / 1000,
    )
    .filter((value) => Number.isFinite(value) && value >= 0);

  const completedRunIds = runs
    .filter((run) => run.status === "COMPLETED")
    .slice(0, 50)
    .map((run) => run.id);
  const costBreakdowns = await Promise.all(
    completedRunIds.map((runId) => estimateRunCost(runId)),
  );

  const predictedCtrValues = runs
    .map((run) => run.prediction?.predictedCtr ?? null)
    .filter((value): value is number => value != null);
  const actualCtrValues = runs
    .map((run) => run.analytics[0]?.ctr ?? null)
    .filter((value): value is number => value != null);

  const stageMap = new Map<string, { failures: number; retries: number[] }>();
  for (const run of runs) {
    if (!run.failedStage) continue;
    const key = run.failedStage;
    const current = stageMap.get(key) ?? { failures: 0, retries: [] };
    current.failures += 1;
    const retryCounts =
      run.stageRetryCounts && typeof run.stageRetryCounts === "object"
        ? (run.stageRetryCounts as Record<string, unknown>)
        : {};
    const retries = retryCounts[key];
    if (typeof retries === "number" && Number.isFinite(retries)) {
      current.retries.push(retries);
    }
    stageMap.set(key, current);
  }

  return {
    windowDays,
    totals: {
      created,
      completed,
      failed,
      successRate: round2(successRate * 100),
      avgRuntimeSec: round2(average(runtimeValues)),
      avgCostUsd: round2(
        average(costBreakdowns.map((cost) => cost.totalUsd)),
      ),
    },
    performance: {
      avgPredictedCtr: round2(average(predictedCtrValues)),
      avgActualCtr: round2(average(actualCtrValues)),
      ctrDelta: round2(
        average(actualCtrValues) - average(predictedCtrValues),
      ),
    },
    stages: Array.from(stageMap.entries())
      .map(([stage, metric]) => ({
        stage,
        failures: metric.failures,
        avgRetries: round2(average(metric.retries)),
      }))
      .sort((left, right) => right.failures - left.failures),
  };
}
