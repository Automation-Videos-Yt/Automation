import { google } from "googleapis";
import {
  authedYouTubeClient,
  parseAnalyticsCell as parseCell,
} from "../integrations/youtube/client";
import { scoped } from "../lib/logger";

const log = scoped("yt-analytics");

export type AnalyticsSnapshot = {
  views: number;
  likes: number;
  comments: number;
  shares: number | null;
  impressions: number | null;
  /** CTR in percent form (0–100), normalized from the API's 0–1 decimal. */
  ctr: number | null;
  avgViewDurationSec: number | null;
  avgViewPercentage: number | null;
  watchTimeMinutes: number | null;
  subsGained: number | null;
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pull a single-video analytics snapshot from the YouTube Analytics API.
 * Covers lifetime-to-date — we query from upload date to today.
 */
export async function fetchVideoAnalytics(
  youtubeVideoId: string,
  uploadedAt: Date
): Promise<AnalyticsSnapshot> {
  const { client: auth } = await authedYouTubeClient();
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
    // YouTube returns CTR as a 0–1 decimal; normalize to percent so admission
    // thresholds + feedback prompts + display all speak the same units.
    const ctrDecimal = parseCell(impRow, impHeaders.indexOf("impressionsCtr"));
    ctr = ctrDecimal == null ? null : ctrDecimal * 100;
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
