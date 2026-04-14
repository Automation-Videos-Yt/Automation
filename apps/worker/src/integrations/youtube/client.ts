import { google } from "googleapis";
import { prisma } from "../../db/prisma";
import { env } from "../../config/env";
import { scoped } from "../../lib/logger";

const log = scoped("yt-oauth-lib");

export class NotConnectedError extends Error {
  code = "NOT_CONNECTED" as const;
  constructor() {
    super("no connected YouTube account");
  }
}

function oauth2() {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    throw new Error(
      "YouTube OAuth not configured: set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET"
    );
  }
  return new google.auth.OAuth2(
    env.YOUTUBE_CLIENT_ID,
    env.YOUTUBE_CLIENT_SECRET,
    env.YOUTUBE_REDIRECT_URI
  );
}

/**
 * Load the stored singleton YouTubeAccount, build an OAuth2 client with its
 * tokens, and register a handler that persists rotated tokens back to Postgres.
 */
export async function authedYouTubeClient() {
  const acct = await prisma.youTubeAccount.findUnique({
    where: { id: "default" },
  });
  if (!acct) throw new NotConnectedError();

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
          ...(tokens.refresh_token
            ? { refreshToken: tokens.refresh_token }
            : {}),
          tokenExpiresAt: tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : acct.tokenExpiresAt,
        },
      });
      log.info("rotated tokens persisted");
    } catch (err) {
      log.error({ err }, "failed to persist rotated tokens");
    }
  });

  return { client, account: acct };
}

/**
 * Pluck a numeric cell from an Analytics reports.query row.
 */
export function parseAnalyticsCell(
  row: (string | number)[],
  idx: number
): number | null {
  if (idx < 0 || idx >= row.length) return null;
  const v = row[idx];
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
