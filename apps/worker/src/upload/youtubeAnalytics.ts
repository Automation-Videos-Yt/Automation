import { google } from "googleapis";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("yt-analytics");

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

  client.on("tokens", async (tokens) => {
    try {
      await prisma.youTubeAccount.update({
        where: { id: "default" },
        data: {
          accessToken: tokens.access_token ?? acct.accessToken,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          tokenExpiresAt: tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : acct.tokenExpiresAt,
        },
      });
    } catch (err) {
      log.error({ err }, "failed to persist rotated tokens");
    }
  });

  return client;
}

export type AnalyticsSnapshot = {
  views: number;
  likes: number;
  comments: number;
  shares: number | null;
  impressions: number | null;
  ctr: number | null;
  avgViewDurationSec: number | null;
  avgViewPercentage: number | null;
  watchTimeMinutes: number | null;
  subsGained: number | null;
};

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

/**
 * Pull a single-video analytics snapshot from the YouTube Analytics API.
 * Covers lifetime-to-date — we query from upload date to today.
 */
export async function fetchVideoAnalytics(
  youtubeVideoId: string,
  uploadedAt: Date
): Promise<AnalyticsSnapshot> {
  const auth = await authedClient();
  const analytics = google.youtubeAnalytics({ version: "v2", auth });

  const startDate = fmtDate(uploadedAt);
  const endDate = fmtDate(new Date());

  log.info(
    { videoId: youtubeVideoId, startDate, endDate },
    "reports.query"
  );

  const metrics = [
    "views",
    "likes",
    "comments",
    "shares",
    "estimatedMinutesWatched",
    "averageViewDuration",
    "averageViewPercentage",
    "subscribersGained",
  ].join(",");

  const baseRes = await analytics.reports.query({
    ids: "channel==MINE",
    startDate,
    endDate,
    metrics,
    filters: `video==${youtubeVideoId}`,
  });

  const baseHeaders = (baseRes.data.columnHeaders ?? []).map(
    (h) => h.name ?? ""
  );
  const baseRow = (baseRes.data.rows ?? [])[0] ?? [];

  const col = (name: string) => baseHeaders.indexOf(name);

  let impressions: number | null = null;
  let ctr: number | null = null;
  try {
    const impRes = await analytics.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "impressions,impressionsCtr",
      filters: `video==${youtubeVideoId}`,
    });
    const impHeaders = (impRes.data.columnHeaders ?? []).map((h) => h.name ?? "");
    const impRow = (impRes.data.rows ?? [])[0] ?? [];
    impressions = parseCell(impRow, impHeaders.indexOf("impressions"));
    ctr = parseCell(impRow, impHeaders.indexOf("impressionsCtr"));
  } catch (err) {
    // Impression metrics aren't always available (content-owner reports only, some regions lag).
    log.warn({ err, videoId: youtubeVideoId }, "impressions query failed — continuing without");
  }

  return {
    views: parseCell(baseRow, col("views")) ?? 0,
    likes: parseCell(baseRow, col("likes")) ?? 0,
    comments: parseCell(baseRow, col("comments")) ?? 0,
    shares: parseCell(baseRow, col("shares")),
    impressions,
    ctr,
    avgViewDurationSec: parseCell(baseRow, col("averageViewDuration")),
    avgViewPercentage: parseCell(baseRow, col("averageViewPercentage")),
    watchTimeMinutes: parseCell(baseRow, col("estimatedMinutesWatched")),
    subsGained: parseCell(baseRow, col("subscribersGained")),
  };
}
