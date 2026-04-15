"use client";

import Link from "next/link";
import { HookExperimentResponse } from "../services/api";

function fmtNum(value: number | null): string {
  if (value == null) return "—";
  return value.toLocaleString();
}

function fmtPct(value: number | null, digits = 1): string {
  if (value == null) return "—";
  return `${value.toFixed(digits)}%`;
}

function fmtMins(value: number | null): string {
  if (value == null) return "—";
  if (value >= 60) {
    const h = Math.floor(value / 60);
    const m = Math.round(value % 60);
    return `${h}h ${m}m`;
  }
  return `${Math.round(value)}m`;
}

export function HookExperimentCard({
  experiment,
  currentRunId,
}: {
  experiment: HookExperimentResponse;
  currentRunId: string;
}) {
  return (
    <section className="rounded-md border border-white/10 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold">Hook experiment</h2>
          <div className="text-xs text-white/50 mt-0.5">
            experiment {experiment.experimentId}
          </div>
        </div>
        <div className="text-xs text-white/60">
          {experiment.canPickWinner
            ? "winner selected from retention + watch time + replay"
            : "winner pending until all variants have analytics"}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-white/50">
            <tr>
              <th className="text-left py-1">Run</th>
              <th className="text-left py-1">Hook</th>
              <th className="text-right py-1">Retention</th>
              <th className="text-right py-1">Watch time</th>
              <th className="text-right py-1">Replay</th>
              <th className="text-right py-1">Score</th>
              <th className="text-right py-1">Winner</th>
            </tr>
          </thead>
          <tbody>
            {experiment.runs.map((r) => {
              const isCurrent = r.runId === currentRunId;
              const rowClass = r.isWinner
                ? "bg-emerald-500/10"
                : isCurrent
                  ? "bg-white/5"
                  : "";

              return (
                <tr
                  key={r.runId}
                  className={`border-t border-white/5 ${rowClass}`}
                >
                  <td className="py-1.5">
                    <Link
                      href={`/runs/${r.runId}`}
                      className="text-white/80 hover:text-white underline"
                    >
                      {isCurrent ? "this run" : r.runId.slice(0, 8)}
                    </Link>
                    <div className="text-[11px] text-white/50">
                      {r.status} · {r.stage}
                    </div>
                  </td>
                  <td className="py-1.5 max-w-[380px]">
                    <div className="line-clamp-2">{r.hookText ?? "—"}</div>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {fmtPct(r.avgViewPercentage)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {fmtMins(r.watchTimeMinutes)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {fmtPct(
                      r.replayRate == null ? null : r.replayRate * 100,
                      2,
                    )}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.score == null ? "—" : r.score.toFixed(4)}
                    <div className="text-[11px] text-white/50">
                      views {fmtNum(r.views)}
                    </div>
                  </td>
                  <td className="py-1.5 text-right">
                    {r.isWinner ? (
                      <span className="text-xs rounded border border-emerald-500/40 bg-emerald-500/20 text-emerald-300 px-2 py-0.5">
                        winner
                      </span>
                    ) : (
                      <span className="text-white/40">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
