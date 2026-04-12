import { google } from "googleapis";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("channel-analytics");

// ── OAuth helper (reusable, same pattern as worker) ──────────────────────────

function oauth2() {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    throw new Error("YouTube OAuth not configured");
  }
  return new google.auth.OAuth2(
    env.YOUTUBE_CLIENT_ID,
    env.YOUTUBE_CLIENT_SECRET,
    env.YOUTUBE_REDIRECT_URI
  );
}

async function authedClient() {
  const acct = await prisma.youTubeAccount.findUnique({
    where: { id: "default" },
  });
  if (!acct) throw new Error("no connected YouTube account");

  const client = oauth2();
  client.setCredentials({
    access_token: acct.accessToken,
    refresh_token: acct.refreshToken,
    expiry_date: acct.tokenExpiresAt.getTime(),
    scope: acct.scope,
  });

  // Persist rotated tokens automatically
  client.on("tokens", async (tokens) => {
    try {
      await prisma.youTubeAccount.update({
        where: { id: "default" },
        data: {
          accessToken: tokens.access_token ?? acct.accessToken,
          ...(tokens.refresh_token
            ? { refreshToken: tokens.refresh_token }
            : {}),
          tokenExpiresAt: tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : acct.tokenExpiresAt,
        },
      });
    } catch (err) {
      log.error({ err }, "failed to persist rotated tokens");
    }
  });

  return { client, acct };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseCell(row: (string | number)[], idx: number): number | null {
  if (idx < 0 || idx >= row.length) return null;
  const v = row[idx];
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ChannelOverview = {
  channelId: string | null;
  channelTitle: string | null;
  subscriberCount: number;
  totalViews: number;
  totalVideos: number;
  hiddenSubscriberCount: boolean;
  channelThumbnail: string | null;
  customUrl: string | null;
  publishedAt: string | null;
};

export type DailyMetrics = {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number | null;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  comments: number;
  shares: number;
};

export type ChannelAnalyticsSummary = {
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  subscribersGained: number;
  subscribersLost: number;
  netSubscribers: number;
  likes: number;
  comments: number;
  shares: number;
  impressions: number | null;
  impressionsCtr: number | null;
};

export type TopVideo = {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  likes: number;
  comments: number;
  subscribersGained: number;
};

export type ChannelAnalyticsResponse = {
  overview: ChannelOverview;
  summary: ChannelAnalyticsSummary;
  daily: DailyMetrics[];
  topVideos: TopVideo[];
  dateRange: { start: string; end: string };
};

// ── Channel overview via Data API v3 ─────────────────────────────────────────

async function fetchChannelOverview(
  auth: ReturnType<typeof oauth2>
): Promise<ChannelOverview> {
  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.channels.list({
    mine: true,
    part: ["snippet", "statistics"],
  });

  const channel = res.data.items?.[0];
  if (!channel) throw new Error("no channel found for authenticated user");

  return {
    channelId: channel.id ?? null,
    channelTitle: channel.snippet?.title ?? null,
    subscriberCount: Number(channel.statistics?.subscriberCount ?? 0),
    totalViews: Number(channel.statistics?.viewCount ?? 0),
    totalVideos: Number(channel.statistics?.videoCount ?? 0),
    hiddenSubscriberCount: channel.statistics?.hiddenSubscriberCount ?? false,
    channelThumbnail:
      channel.snippet?.thumbnails?.medium?.url ??
      channel.snippet?.thumbnails?.default?.url ??
      null,
    customUrl: channel.snippet?.customUrl ?? null,
    publishedAt: channel.snippet?.publishedAt ?? null,
  };
}

// ── Daily analytics via YouTube Analytics API v2 ─────────────────────────────

async function fetchDailyAnalytics(
  auth: ReturnType<typeof oauth2>,
  startDate: string,
  endDate: string
): Promise<{ summary: ChannelAnalyticsSummary; daily: DailyMetrics[] }> {
  const analytics = google.youtubeAnalytics({ version: "v2", auth });

  const metrics = [
    "views",
    "estimatedMinutesWatched",
    "averageViewDuration",
    "averageViewPercentage",
    "subscribersGained",
    "subscribersLost",
    "likes",
    "comments",
    "shares",
  ].join(",");

  // Daily breakdown
  log.info({ startDate, endDate }, "fetching daily channel analytics");

  const dailyRes = await analytics.reports.query({
    ids: "channel==MINE",
    startDate,
    endDate,
    metrics,
    dimensions: "day",
    sort: "day",
  });

  const headers = (dailyRes.data.columnHeaders ?? []).map(
    (h) => h.name ?? ""
  );
  const rows = dailyRes.data.rows ?? [];
  const col = (name: string) => headers.indexOf(name);

  const daily: DailyMetrics[] = rows.map((row) => ({
    date: String(row[col("day")] ?? ""),
    views: parseCell(row, col("views")) ?? 0,
    estimatedMinutesWatched:
      parseCell(row, col("estimatedMinutesWatched")) ?? 0,
    averageViewDuration: parseCell(row, col("averageViewDuration")) ?? 0,
    averageViewPercentage: parseCell(row, col("averageViewPercentage")),
    subscribersGained: parseCell(row, col("subscribersGained")) ?? 0,
    subscribersLost: parseCell(row, col("subscribersLost")) ?? 0,
    likes: parseCell(row, col("likes")) ?? 0,
    comments: parseCell(row, col("comments")) ?? 0,
    shares: parseCell(row, col("shares")) ?? 0,
  }));

  // Aggregate summary
  const totals = daily.reduce(
    (acc, d) => {
      acc.views += d.views;
      acc.estimatedMinutesWatched += d.estimatedMinutesWatched;
      acc.subscribersGained += d.subscribersGained;
      acc.subscribersLost += d.subscribersLost;
      acc.likes += d.likes;
      acc.comments += d.comments;
      acc.shares += d.shares;
      return acc;
    },
    {
      views: 0,
      estimatedMinutesWatched: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    }
  );

  const avgDuration =
    daily.length > 0
      ? daily.reduce((s, d) => s + d.averageViewDuration, 0) / daily.length
      : 0;

  // Impressions (separate query — can fail for some accounts)
  let impressions: number | null = null;
  let impressionsCtr: number | null = null;
  try {
    const impRes = await analytics.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "impressions,impressionsCtr",
    });
    const impHeaders = (impRes.data.columnHeaders ?? []).map(
      (h) => h.name ?? ""
    );
    const impRow = (impRes.data.rows ?? [])[0] ?? [];
    impressions = parseCell(impRow, impHeaders.indexOf("impressions"));
    impressionsCtr = parseCell(impRow, impHeaders.indexOf("impressionsCtr"));
  } catch (err) {
    log.warn({ err }, "impressions query failed — continuing");
  }

  return {
    summary: {
      ...totals,
      averageViewDuration: Math.round(avgDuration),
      netSubscribers: totals.subscribersGained - totals.subscribersLost,
      impressions,
      impressionsCtr,
    },
    daily,
  };
}

// ── Top videos via YouTube Analytics API v2 ──────────────────────────────────

async function fetchTopVideos(
  auth: ReturnType<typeof oauth2>,
  startDate: string,
  endDate: string,
  limit = 10
): Promise<TopVideo[]> {
  const analytics = google.youtubeAnalytics({ version: "v2", auth });

  const res = await analytics.reports.query({
    ids: "channel==MINE",
    startDate,
    endDate,
    metrics:
      "views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained",
    dimensions: "video",
    sort: "-views",
    maxResults: limit,
  });

  const headers = (res.data.columnHeaders ?? []).map((h) => h.name ?? "");
  const rows = res.data.rows ?? [];
  const col = (name: string) => headers.indexOf(name);

  const videoIds = rows.map((r) => String(r[col("video")] ?? "")).filter(Boolean);

  // Fetch video metadata (titles, thumbnails) via Data API
  let videoMeta: Record<string, { title: string; thumbnail: string | null }> =
    {};

  if (videoIds.length > 0) {
    try {
      const youtube = google.youtube({ version: "v3", auth });
      const metaRes = await youtube.videos.list({
        id: videoIds,
        part: ["snippet"],
      });
      for (const item of metaRes.data.items ?? []) {
        if (item.id) {
          videoMeta[item.id] = {
            title: item.snippet?.title ?? "Untitled",
            thumbnail:
              item.snippet?.thumbnails?.medium?.url ??
              item.snippet?.thumbnails?.default?.url ??
              null,
          };
        }
      }
    } catch (err) {
      log.warn({ err }, "video metadata fetch failed — continuing without titles");
    }
  }

  return rows.map((row) => {
    const videoId = String(row[col("video")] ?? "");
    const meta = videoMeta[videoId];
    return {
      videoId,
      title: meta?.title ?? null,
      thumbnailUrl: meta?.thumbnail ?? null,
      views: parseCell(row, col("views")) ?? 0,
      estimatedMinutesWatched:
        parseCell(row, col("estimatedMinutesWatched")) ?? 0,
      averageViewDuration: parseCell(row, col("averageViewDuration")) ?? 0,
      likes: parseCell(row, col("likes")) ?? 0,
      comments: parseCell(row, col("comments")) ?? 0,
      subscribersGained: parseCell(row, col("subscribersGained")) ?? 0,
    };
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

export type DateRangePreset = "7" | "28" | "90" | "365";

export async function getChannelAnalytics(
  days: DateRangePreset = "28"
): Promise<ChannelAnalyticsResponse> {
  const { client: auth } = await authedClient();

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - Number(days));

  const start = fmtDate(startDate);
  const end = fmtDate(endDate);

  log.info({ days, start, end }, "fetching channel analytics");

  const [overview, { summary, daily }, topVideos] = await Promise.all([
    fetchChannelOverview(auth),
    fetchDailyAnalytics(auth, start, end),
    fetchTopVideos(auth, start, end),
  ]);

  return {
    overview,
    summary,
    daily,
    topVideos,
    dateRange: { start, end },
  };
}
