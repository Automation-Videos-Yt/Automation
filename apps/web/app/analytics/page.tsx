"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  ChannelAnalyticsResponse,
  DailyMetrics,
  TopVideo,
} from "../../services/api";

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null) return "—";
  return n.toFixed(digits) + "%";
}

function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtWatchTime(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${m}m`;
  }
  return `${Math.round(minutes)}m`;
}

// ── Mini line chart (pure SVG, no deps) ──────────────────────────────────────

function MiniChart({
  data,
  dataKey,
  color = "#6366f1",
  height = 180,
  label,
}: {
  data: DailyMetrics[];
  dataKey: keyof DailyMetrics;
  color?: string;
  height?: number;
  label: string;
}) {
  const values = data.map((d) => {
    const v = d[dataKey];
    return typeof v === "number" ? v : 0;
  });

  const max = Math.max(...values, 1);
  const min = 0;
  const w = 100;
  const h = 100;
  const pad = 2;

  const points = values
    .map((v, i) => {
      const x = pad + (i / Math.max(values.length - 1, 1)) * (w - 2 * pad);
      const y = h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
      return `${x},${y}`;
    })
    .join(" ");

  const areaPoints = `${pad},${h - pad} ${points} ${w - pad},${h - pad}`;

  const total = values.reduce((a, b) => a + b, 0);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-white/50">
          {label}
        </span>
        <span className="text-sm font-semibold tabular-nums">
          {fmtNum(total)} total
        </span>
      </div>
      {values.length > 1 ? (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full"
          style={{ height }}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <polygon
            points={areaPoints}
            fill={`url(#grad-${label})`}
          />
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div
          className="flex items-center justify-center text-white/30 text-sm"
          style={{ height }}
        >
          Not enough data for chart
        </div>
      )}
      {data.length > 0 && (
        <div className="flex justify-between text-[10px] text-white/40 tabular-nums">
          <span>{data[0]?.date}</span>
          <span>{data[data.length - 1]?.date}</span>
        </div>
      )}
    </div>
  );
}

// ── Summary stat card ────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subValue,
  accent,
}: {
  label: string;
  value: string;
  subValue?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-1">
      <div className="text-[11px] uppercase tracking-wider text-white/50">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums" style={{ color: accent }}>
        {value}
      </div>
      {subValue && (
        <div className="text-xs text-white/50">{subValue}</div>
      )}
    </div>
  );
}

// ── Top videos table ─────────────────────────────────────────────────────────

function TopVideosTable({ videos }: { videos: TopVideo[] }) {
  if (videos.length === 0) {
    return (
      <div className="text-sm text-white/50">No video data in this range.</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-white/50 text-xs uppercase tracking-wider">
            <th className="text-left py-2 pr-3">#</th>
            <th className="text-left py-2 pr-3">Video</th>
            <th className="text-right py-2 px-2">Views</th>
            <th className="text-right py-2 px-2">Watch time</th>
            <th className="text-right py-2 px-2">Avg duration</th>
            <th className="text-right py-2 px-2">Likes</th>
            <th className="text-right py-2 px-2">Comments</th>
            <th className="text-right py-2 pl-2">Subs gained</th>
          </tr>
        </thead>
        <tbody>
          {videos.map((v, i) => (
            <tr
              key={v.videoId}
              className="border-t border-white/5 hover:bg-white/[0.03] transition-colors"
            >
              <td className="py-2 pr-3 text-white/40 tabular-nums">{i + 1}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-3">
                  {v.thumbnailUrl ? (
                    <img
                      src={v.thumbnailUrl}
                      alt=""
                      className="w-16 h-9 rounded object-cover shrink-0 border border-white/10"
                    />
                  ) : (
                    <div className="w-16 h-9 rounded bg-white/10 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <a
                      href={`https://www.youtube.com/watch?v=${v.videoId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium hover:text-indigo-400 transition-colors line-clamp-2"
                    >
                      {v.title ?? v.videoId}
                    </a>
                  </div>
                </div>
              </td>
              <td className="py-2 px-2 text-right tabular-nums">
                {fmtNum(v.views)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">
                {fmtWatchTime(v.estimatedMinutesWatched)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">
                {fmtDuration(v.averageViewDuration)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">
                {fmtNum(v.likes)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums">
                {fmtNum(v.comments)}
              </td>
              <td className="py-2 pl-2 text-right tabular-nums">
                {v.subscribersGained > 0 ? (
                  <span className="text-emerald-400">
                    +{fmtNum(v.subscribersGained)}
                  </span>
                ) : (
                  "0"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

type DateRange = "7" | "28" | "90" | "365";

const RANGE_LABELS: Record<DateRange, string> = {
  "7": "Last 7 days",
  "28": "Last 28 days",
  "90": "Last 90 days",
  "365": "Last 365 days",
};

export default function ChannelAnalyticsPage() {
  const [range, setRange] = useState<DateRange>("28");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["channel-analytics", range],
    queryFn: () => api.getChannelAnalytics(range),
    staleTime: 60_000,
    // Don't retry 4xx — they won't succeed. Retry once on 5xx / network failures.
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        return false;
      }
      return failureCount < 1;
    },
  });

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          {data?.overview.channelThumbnail && (
            <img
              src={data.overview.channelThumbnail}
              alt=""
              className="w-12 h-12 rounded-full border-2 border-white/20"
            />
          )}
          <div>
            <h1 className="text-2xl font-bold">Channel Analytics</h1>
            {data?.overview.channelTitle && (
              <div className="text-sm text-white/60 mt-0.5">
                {data.overview.channelTitle}
                {data.overview.customUrl && (
                  <span className="ml-2 text-white/40">
                    {data.overview.customUrl}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {(Object.keys(RANGE_LABELS) as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                range === r
                  ? "bg-indigo-500/30 text-indigo-200 border-r border-white/10"
                  : "bg-white/[0.03] text-white/60 hover:bg-white/[0.06] border-r border-white/10"
              } last:border-r-0`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="flex items-center gap-3 text-white/50">
            <svg
              className="animate-spin h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
                className="opacity-20"
              />
              <path
                d="M4 12a8 8 0 018-8"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
            <span>Fetching channel analytics…</span>
          </div>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
          <div className="text-red-300 font-medium">
            Failed to load analytics
          </div>
          <div className="text-sm text-red-300/70 mt-1">
            {error instanceof Error ? error.message : "Unknown error"}
          </div>
          <div className="text-xs text-white/50 mt-3">
            Make sure your YouTube account is connected and has the analytics
            scope.
          </div>
        </div>
      )}

      {/* Data loaded */}
      {data && <AnalyticsDashboard data={data} />}
    </div>
  );
}

function AnalyticsDashboard({ data }: { data: ChannelAnalyticsResponse }) {
  const { overview, summary, daily, topVideos } = data;

  return (
    <>
      {/* Channel overview row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label="Subscribers"
          value={fmtNum(overview.subscriberCount)}
          subValue={
            summary.netSubscribers !== 0
              ? `${summary.netSubscribers > 0 ? "+" : ""}${fmtNum(summary.netSubscribers)} in period`
              : undefined
          }
          accent={
            summary.netSubscribers > 0
              ? "#34d399"
              : summary.netSubscribers < 0
              ? "#f87171"
              : undefined
          }
        />
        <StatCard
          label="Views"
          value={fmtNum(summary.views)}
          subValue={`${fmtNum(overview.totalViews)} lifetime`}
        />
        <StatCard
          label="Watch time"
          value={fmtWatchTime(summary.estimatedMinutesWatched)}
        />
        <StatCard
          label="Avg view duration"
          value={fmtDuration(summary.averageViewDuration)}
        />
        <StatCard
          label="Videos"
          value={fmtNum(overview.totalVideos)}
          subValue={`total on channel`}
        />
      </div>

      {/* Engagement row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Likes" value={fmtNum(summary.likes)} />
        <StatCard label="Comments" value={fmtNum(summary.comments)} />
        <StatCard label="Shares" value={fmtNum(summary.shares)} />
        <StatCard
          label="Impressions"
          value={fmtNum(summary.impressions)}
        />
        <StatCard
          label="Impression CTR"
          value={fmtPct(summary.impressionsCtr)}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MiniChart
          data={daily}
          dataKey="views"
          color="#6366f1"
          label="Views"
        />
        <MiniChart
          data={daily}
          dataKey="estimatedMinutesWatched"
          color="#8b5cf6"
          label="Watch time (min)"
        />
        <MiniChart
          data={daily}
          dataKey="subscribersGained"
          color="#34d399"
          label="Subscribers gained"
        />
        <MiniChart
          data={daily}
          dataKey="likes"
          color="#f59e0b"
          label="Likes"
        />
      </div>

      {/* Top videos */}
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
        <h2 className="text-lg font-semibold">Top content</h2>
        <TopVideosTable videos={topVideos} />
      </section>

      {/* Date range footer */}
      <div className="text-xs text-white/30 text-center">
        Data from {data.dateRange.start} to {data.dateRange.end} · YouTube
        Analytics API
      </div>
    </>
  );
}
