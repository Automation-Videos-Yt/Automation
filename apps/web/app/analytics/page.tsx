"use client";

import Image from "next/image";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  ChannelAnalyticsResponse,
  DailyMetrics,
  TopVideo,
} from "../../services/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
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

  const gradientId = `grad-${safeId(`${label}-${String(dataKey)}`)}`;

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
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardDescription className="text-[11px] uppercase tracking-wider text-white/50">
            {label}
          </CardDescription>
          <Badge variant="secondary" className="tabular-nums">
            {fmtNum(total)} total
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {values.length > 1 ? (
          <svg
            viewBox={`0 0 ${w} ${h}`}
            className="w-full"
            style={{ height }}
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <polygon points={areaPoints} fill={`url(#${gradientId})`} />
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
      </CardContent>
    </Card>
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
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="text-[11px] uppercase tracking-wider text-white/50">
          {label}
        </div>
        <div
          className="text-2xl font-bold tabular-nums"
          style={{ color: accent }}
        >
          {value}
        </div>
        {subValue && <div className="text-xs text-white/50">{subValue}</div>}
      </CardContent>
    </Card>
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">#</TableHead>
          <TableHead>Video</TableHead>
          <TableHead className="text-right">Views</TableHead>
          <TableHead className="text-right">Watch time</TableHead>
          <TableHead className="text-right">Avg duration</TableHead>
          <TableHead className="text-right">Likes</TableHead>
          <TableHead className="text-right">Comments</TableHead>
          <TableHead className="text-right">Subs gained</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {videos.map((v, i) => (
          <TableRow key={v.videoId}>
            <TableCell className="text-white/40 tabular-nums">
              {i + 1}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-3">
                {v.thumbnailUrl ? (
                  <Image
                    src={v.thumbnailUrl}
                    alt="Video thumbnail"
                    width={160}
                    height={90}
                    className="h-9 w-16 rounded object-cover border border-white/10"
                  />
                ) : (
                  <div className="h-9 w-16 rounded bg-white/10" />
                )}
                <a
                  href={`https://www.youtube.com/watch?v=${v.videoId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:text-indigo-300 transition-colors line-clamp-2"
                >
                  {v.title ?? v.videoId}
                </a>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtNum(v.views)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtWatchTime(v.estimatedMinutesWatched)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtDuration(v.averageViewDuration)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtNum(v.likes)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtNum(v.comments)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {v.subscribersGained > 0 ? (
                <span className="text-emerald-300">
                  +{fmtNum(v.subscribersGained)}
                </span>
              ) : (
                "0"
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AnalyticsLoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {Array.from({ length: 10 }).map((_, idx) => (
          <Card key={idx}>
            <CardContent className="p-4 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, idx) => (
          <Card key={idx}>
            <CardHeader>
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-44 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
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

  const { data, isLoading, isError, error, refetch } = useQuery({
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
      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              {data?.overview.channelThumbnail ? (
                <Image
                  src={data.overview.channelThumbnail}
                  alt="Channel thumbnail"
                  width={48}
                  height={48}
                  className="h-12 w-12 rounded-full border border-white/20"
                />
              ) : (
                <div className="h-12 w-12 rounded-full border border-white/20 bg-white/10" />
              )}
              <div>
                <CardTitle>Channel Analytics</CardTitle>
                <CardDescription className="mt-1">
                  {data?.overview.channelTitle ?? "Connected YouTube channel"}
                  {data?.overview.customUrl
                    ? ` · ${data.overview.customUrl}`
                    : ""}
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary">{RANGE_LABELS[range]}</Badge>
          </div>

          <Tabs value={range} onValueChange={(v) => setRange(v as DateRange)}>
            <TabsList>
              {(Object.keys(RANGE_LABELS) as DateRange[]).map((r) => (
                <TabsTrigger key={r} value={r}>
                  {RANGE_LABELS[r]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
      </Card>

      {isLoading && <AnalyticsLoadingState />}

      {isError && (
        <Card className="border-red-500/40 bg-red-500/10">
          <CardHeader>
            <CardTitle className="text-red-200">
              Failed to load analytics
            </CardTitle>
            <CardDescription className="text-red-100/80">
              {error instanceof Error ? error.message : "Unknown error"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-white/70">
              Make sure your YouTube account is connected and has the analytics
              scope.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {data && <AnalyticsDashboard data={data} />}
    </div>
  );
}

function AnalyticsDashboard({ data }: { data: ChannelAnalyticsResponse }) {
  const { overview, summary, daily, topVideos } = data;

  return (
    <>
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

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Likes" value={fmtNum(summary.likes)} />
        <StatCard label="Comments" value={fmtNum(summary.comments)} />
        <StatCard label="Shares" value={fmtNum(summary.shares)} />
        <StatCard label="Impressions" value={fmtNum(summary.impressions)} />
        <StatCard
          label="Impression CTR"
          value={fmtPct(summary.impressionsCtr)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MiniChart data={daily} dataKey="views" color="#6366f1" label="Views" />
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
        <MiniChart data={daily} dataKey="likes" color="#f59e0b" label="Likes" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top Content</CardTitle>
          <CardDescription>
            Best performing videos in the selected date range.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TopVideosTable videos={topVideos} />
        </CardContent>
      </Card>

      <div className="text-xs text-white/35 text-center">
        Data from {data.dateRange.start} to {data.dateRange.end} · YouTube
        Analytics API
      </div>
    </>
  );
}
