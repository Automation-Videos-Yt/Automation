"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, CostAnalysis, CostHistoryEvent, RunCost } from "../services/api";

function usd(value: number) {
  return `$${value.toFixed(4)}`;
}

function pct(value: number, total: number) {
  if (total <= 0) return "0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function decisionLabel(decision: CostAnalysis["actions"][number]) {
  switch (decision) {
    case "APPROVE_PIPELINE":
      return "Approve pipeline";
    case "REGENERATE_HOOK":
      return "Regenerate hook";
    case "MODIFY_SCRIPT":
      return "Modify script";
    case "CHANGE_VOICE_TIER":
      return "Change voice tier";
    case "SKIP_THUMBNAIL":
      return "Skip thumbnail";
    case "CHANGE_TOPIC":
      return "Change topic";
    default:
      return decision;
  }
}

function driverLabel(
  driver: CostAnalysis["cost_optimization"]["main_cost_driver"],
) {
  switch (driver) {
    case "voice":
      return "Voice";
    case "thumbnail":
      return "Thumbnail";
    case "llm":
      return "LLM";
    case "video":
      return "Video";
    default:
      return driver;
  }
}

function directionTone(value: CostAnalysis["expected_impact"]["ctr"]) {
  if (value === "increase") return "text-emerald-200 bg-emerald-500/20";
  if (value === "decrease") return "text-red-200 bg-red-500/20";
  return "text-slate-200 bg-slate-500/20";
}

function directionLabel(value: CostAnalysis["expected_impact"]["ctr"]) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function iterationReasonLabel(
  value: CostAnalysis["iteration_control"]["reason"],
) {
  switch (value) {
    case "max_iterations":
      return "Max iterations reached";
    case "converged":
      return "Converged";
    case "improvement_expected":
      return "Improvement expected";
    default:
      return value;
  }
}

function confidencePct(value: number) {
  const bounded = Math.max(0, Math.min(1, value));
  return `${Math.round(bounded * 100)}%`;
}

function CostBucket({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const width =
    total > 0 ? Math.max(4, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-white/60">{label}</span>
        <span className="tabular-nums text-white/80">
          {usd(value)} · {pct(value, total)}
        </span>
      </div>
      <div className="h-1.5 rounded bg-white/10 overflow-hidden">
        <div className="h-full bg-cyan-400/80" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function EventRow({ event }: { event: CostHistoryEvent }) {
  const positive = event.deltaUsd >= 0;
  return (
    <li className="rounded border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="uppercase tracking-wider text-white/60">
          {event.agent}
        </span>
        <span
          className={`tabular-nums ${
            positive ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {positive ? "+" : ""}
          {usd(event.deltaUsd)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
        <span className="text-white/50">
          {new Date(event.at).toLocaleString()}
        </span>
        <span className="tabular-nums text-white/70">
          total {usd(event.totalUsd)}
        </span>
      </div>
    </li>
  );
}

export function CostAnalysisCard({
  runId,
  initialCost,
}: {
  runId: string;
  initialCost?: RunCost | null;
}) {
  const qc = useQueryClient();
  const historyLimit = 30;

  const { data: costResp } = useQuery({
    queryKey: ["run-cost", runId],
    queryFn: () => api.getRunCost(runId),
    initialData: initialCost ? { runId, cost: initialCost } : undefined,
    refetchInterval: 30_000,
  });

  const { data: historyResp } = useQuery({
    queryKey: ["run-cost-history", runId, historyLimit],
    queryFn: () => api.getRunCostHistory(runId, { limit: historyLimit }),
    refetchInterval: 30_000,
  });

  const { data: cacheStats } = useQuery({
    queryKey: ["cost-cache-stats"],
    queryFn: () => api.getCostCacheStats(),
    refetchInterval: 30_000,
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const [cost, history] = await Promise.all([
        api.getRunCost(runId, { refreshAnalysis: true }),
        api.getRunCostHistory(runId, {
          limit: historyLimit,
          refreshAnalysis: true,
        }),
      ]);
      return { cost, history };
    },
    onSuccess: ({ cost, history }) => {
      qc.setQueryData(["run-cost", runId], cost);
      qc.setQueryData(["run-cost-history", runId, historyLimit], history);
      qc.invalidateQueries({ queryKey: ["run", runId] });
      qc.invalidateQueries({ queryKey: ["cost-cache-stats"] });
    },
  });

  const cost = costResp?.cost ?? historyResp?.latest ?? initialCost ?? null;
  if (!cost) return null;

  const analysis = cost.analysis ?? null;
  const total = Math.max(0, cost.totalUsd);
  const timeline = (historyResp?.events ?? []).slice(-8).reverse();

  return (
    <section className="rounded-md border border-white/10 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Cost analysis</h2>
          <div className="text-xs text-white/50 mt-0.5">
            latest spend {usd(cost.totalUsd)}
            {cost.analysisModel && ` · ${cost.analysisModel}`}
          </div>
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="text-xs rounded-md bg-white/10 border border-white/10 text-white/80 px-3 py-1.5 hover:bg-white/20 disabled:opacity-40"
        >
          {refresh.isPending ? "Refreshing…" : "Refresh analysis"}
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <CostBucket label="Voice" value={cost.voiceUsd} total={total} />
        <CostBucket label="Whisper" value={cost.whisperUsd} total={total} />
        <CostBucket label="Thumbnail" value={cost.thumbnailUsd} total={total} />
        <CostBucket label="LLM" value={cost.llmUsd} total={total} />
      </div>

      <div className="text-xs text-white/50 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>voice provider: {cost.source.voiceProvider ?? "—"}</span>
        <span>
          audio sec: {cost.source.audioDurationSec?.toFixed(1) ?? "—"}
        </span>
        <span>thumbnail: {cost.source.thumbnailQuality ?? "off"}</span>
      </div>

      {analysis ? (
        <div className="rounded border border-cyan-500/30 bg-cyan-500/10 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-cyan-200/90">
              Actions
            </span>
            {analysis.actions.map((decision) => (
              <span
                key={decision}
                className="text-xs rounded bg-cyan-400/20 text-cyan-100 px-2 py-1 border border-cyan-300/30"
              >
                {decisionLabel(decision)}
              </span>
            ))}
            <span className="text-[11px] rounded bg-cyan-900/40 text-cyan-200 px-2 py-1 border border-cyan-600/40">
              confidence {confidencePct(analysis.confidence)}
            </span>
          </div>
          <div className="text-sm text-cyan-100">{analysis.reasoning}</div>
          <div className="rounded border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-2 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-cyan-200/90">
              Cost optimization
            </div>
            <div className="text-xs text-cyan-100/90">
              main cost driver:{" "}
              {driverLabel(analysis.cost_optimization.main_cost_driver)}
            </div>
            <div className="text-sm text-white/90">
              {analysis.cost_optimization.suggestion}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-cyan-200/90">
              Performance expectation
            </span>
            <span
              className={`text-xs px-2 py-1 rounded border border-white/10 ${directionTone(
                analysis.expected_impact.ctr,
              )}`}
            >
              CTR {directionLabel(analysis.expected_impact.ctr)}
            </span>
            <span
              className={`text-xs px-2 py-1 rounded border border-white/10 ${directionTone(
                analysis.expected_impact.retention,
              )}`}
            >
              Retention {directionLabel(analysis.expected_impact.retention)}
            </span>
          </div>
          <div className="rounded border border-cyan-400/20 bg-cyan-400/5 px-2.5 py-2 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-cyan-200/90">
              Iteration control
            </div>
            <div className="text-xs text-cyan-100/90">
              should continue:{" "}
              {analysis.iteration_control.should_continue ? "yes" : "no"}
            </div>
            <div className="text-xs text-cyan-100/90">
              reason: {iterationReasonLabel(analysis.iteration_control.reason)}
            </div>
          </div>
          <div className="rounded border border-cyan-400/20 bg-cyan-400/5 px-2.5 py-2 space-y-1">
            <div className="text-[11px] uppercase tracking-wider text-cyan-200/90">
              Learning signal
            </div>
            <div className="text-xs text-cyan-100/90">
              should store:{" "}
              {analysis.learning_signal.should_store ? "yes" : "no"}
            </div>
            {analysis.learning_signal.pattern_detected && (
              <div className="text-sm text-white/90">
                {analysis.learning_signal.pattern_detected}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded border border-white/10 bg-white/[0.03] p-3 text-sm text-white/70">
          Decision analysis is unavailable for this run right now.
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium text-white/90">Cost timeline</div>
        {timeline.length > 0 ? (
          <ul className="space-y-2">
            {timeline.map((event) => (
              <EventRow key={`${event.agent}-${event.at}`} event={event} />
            ))}
          </ul>
        ) : (
          <div className="text-sm text-white/60">
            No timeline events yet. They appear as script/voice/thumbnail stages
            complete.
          </div>
        )}
      </div>

      {cacheStats && (
        <div className="text-[11px] text-white/40 border-t border-white/10 pt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>cache entries: {cacheStats.entries}</span>
          <span>hits: {cacheStats.metrics.cacheHits}</span>
          <span>misses: {cacheStats.metrics.cacheMisses}</span>
          <span>generated: {cacheStats.metrics.generated}</span>
          <span>failed: {cacheStats.metrics.failed}</span>
        </div>
      )}
    </section>
  );
}
