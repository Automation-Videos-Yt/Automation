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

function driverLabel(driver: CostAnalysis["dominantDriver"]) {
  switch (driver) {
    case "voice":
      return "Voice";
    case "thumbnail":
      return "Thumbnail";
    case "llm":
      return "LLM";
    case "whisper":
      return "Whisper";
    default:
      return "Mixed";
  }
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
          <div className="text-sm text-cyan-100">{analysis.summary}</div>
          <div className="text-xs text-cyan-200/90">
            dominant driver: {driverLabel(analysis.dominantDriver)} · potential
            savings {usd(analysis.estimatedSavingsUsd)}
          </div>
          <ul className="text-sm list-disc pl-5 space-y-1 text-white/90">
            {analysis.optimizationActions.map((action, idx) => (
              <li key={`${idx}-${action.slice(0, 24)}`}>{action}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded border border-white/10 bg-white/[0.03] p-3 text-sm text-white/70">
          AI optimization suggestions are unavailable for this run right now.
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
