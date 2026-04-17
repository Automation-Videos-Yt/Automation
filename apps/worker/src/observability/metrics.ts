import type { StageName } from "../stages";

type StageMetric = {
  completions: number;
  failures: number;
  retries: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastErrorType: string | null;
};

type RunMetric = {
  completed: number;
  failed: number;
  totalRuntimeMs: number;
  maxRuntimeMs: number;
};

const stageMetrics = new Map<StageName, StageMetric>();
const runMetrics: RunMetric = {
  completed: 0,
  failed: 0,
  totalRuntimeMs: 0,
  maxRuntimeMs: 0,
};

function getStageMetric(stage: StageName): StageMetric {
  const existing = stageMetrics.get(stage);
  if (existing) return existing;
  const created: StageMetric = {
    completions: 0,
    failures: 0,
    retries: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastErrorType: null,
  };
  stageMetrics.set(stage, created);
  return created;
}

export function observeStageCompleted(stage: StageName, durationMs: number): void {
  const metric = getStageMetric(stage);
  metric.completions += 1;
  metric.totalDurationMs += durationMs;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
}

export function observeStageFailed(
  stage: StageName,
  durationMs: number,
  errorType: string,
): void {
  const metric = getStageMetric(stage);
  metric.failures += 1;
  metric.totalDurationMs += durationMs;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
  metric.lastErrorType = errorType;
}

export function observeStageRetry(stage: StageName): void {
  const metric = getStageMetric(stage);
  metric.retries += 1;
}

export function observeRunCompleted(durationMs: number): void {
  runMetrics.completed += 1;
  runMetrics.totalRuntimeMs += durationMs;
  runMetrics.maxRuntimeMs = Math.max(runMetrics.maxRuntimeMs, durationMs);
}

export function observeRunFailed(durationMs: number): void {
  runMetrics.failed += 1;
  runMetrics.totalRuntimeMs += durationMs;
  runMetrics.maxRuntimeMs = Math.max(runMetrics.maxRuntimeMs, durationMs);
}

export function getWorkerMetricsSnapshot() {
  return {
    runs: {
      completed: runMetrics.completed,
      failed: runMetrics.failed,
      avgRuntimeMs:
        runMetrics.completed + runMetrics.failed === 0
          ? 0
          : Math.round(
              runMetrics.totalRuntimeMs /
                (runMetrics.completed + runMetrics.failed),
            ),
      maxRuntimeMs: runMetrics.maxRuntimeMs,
    },
    stages: Array.from(stageMetrics.entries()).map(([stage, metric]) => ({
      stage,
      completions: metric.completions,
      failures: metric.failures,
      retries: metric.retries,
      avgDurationMs:
        metric.completions + metric.failures === 0
          ? 0
          : Math.round(
              metric.totalDurationMs / (metric.completions + metric.failures),
            ),
      maxDurationMs: metric.maxDurationMs,
      lastErrorType: metric.lastErrorType,
    })),
  };
}
