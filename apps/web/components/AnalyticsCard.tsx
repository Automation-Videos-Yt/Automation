"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, VideoAnalyticsSnapshot } from "../services/api";

function Metric({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string | number | null | undefined;
  suffix?: string;
}) {
  const v = value == null || value === "" ? "—" : `${value}${suffix ?? ""}`;
  return (
    <div className="rounded border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/50">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums">{v}</div>
    </div>
  );
}

function fmtInt(n: number | null | undefined) {
  return n == null ? null : n.toLocaleString();
}
function fmtPct(n: number | null | undefined, digits = 1) {
  return n == null ? null : n.toFixed(digits);
}
function fmtDur(n: number | null | undefined) {
  if (n == null) return null;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function AnalyticsCard({
  runId,
  hasUpload,
}: {
  runId: string;
  hasUpload: boolean;
}) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["run-analytics", runId],
    queryFn: () => api.getRunAnalytics(runId),
    enabled: hasUpload,
    refetchInterval: 5000,
  });

  const sync = useMutation({
    mutationFn: () => api.syncRunAnalytics(runId),
    onSuccess: () => {
      // Give the worker a couple seconds to write the snapshot, then refetch.
      setTimeout(
        () => qc.invalidateQueries({ queryKey: ["run-analytics", runId] }),
        3000
      );
    },
  });

  if (!hasUpload) return null;

  const latest: VideoAnalyticsSnapshot | null = data?.latest ?? null;

  return (
    <section className="rounded-md border border-white/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">YouTube analytics</h2>
          {latest && (
            <div className="text-xs text-white/50">
              updated {new Date(latest.snapshotAt).toLocaleString()}
            </div>
          )}
        </div>
        <button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="text-xs rounded-md bg-white/10 border border-white/10 text-white/80 px-3 py-1.5 hover:bg-white/20 disabled:opacity-40"
        >
          {sync.isPending ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {isLoading && !latest && (
        <div className="text-sm text-white/50">Loading analytics…</div>
      )}

      {!isLoading && !latest && (
        <div className="text-sm text-white/60">
          No snapshots yet. Click <span className="font-medium">Sync now</span>{" "}
          — YouTube typically takes a few hours to populate metrics after upload.
        </div>
      )}

      {latest && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Metric label="Views" value={fmtInt(latest.views)} />
          <Metric
            label="Impressions"
            value={fmtInt(latest.impressions)}
          />
          <Metric
            label="CTR"
            value={fmtPct(latest.ctr, 2)}
            suffix="%"
          />
          <Metric
            label="Avg view %"
            value={fmtPct(latest.avgViewPercentage)}
            suffix="%"
          />
          <Metric
            label="Avg view time"
            value={fmtDur(latest.avgViewDurationSec)}
          />
          <Metric
            label="Watch min"
            value={fmtInt(Math.round(latest.watchTimeMinutes ?? 0))}
          />
          <Metric label="Likes" value={fmtInt(latest.likes)} />
          <Metric label="Comments" value={fmtInt(latest.comments)} />
        </div>
      )}
    </section>
  );
}
