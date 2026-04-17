import { google } from "googleapis";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { scoped } from "../../lib/logger";
import { decryptSecret, encryptSecret } from "../../lib/secret-crypto";

const log = scoped("yt-oauth-lib");

// Scope notes:
// - youtube.upload: videos.insert + thumbnails.set for videos the app uploaded
// - youtube.readonly: channel info (handle, title) for the status endpoint
// - yt-analytics.readonly: YouTube Analytics reports.query (Phase 4 feedback loop)
export const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export class NotConnectedError extends Error {
  code = "NOT_CONNECTED" as const;
  constructor() {
    super("no connected YouTube account");
  }
}

export function oauthClient() {
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

export function buildAuthUrl(state: string): string {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token on repeat connects
    scope: YT_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

/**
 * Load the stored singleton YouTubeAccount, build an OAuth2 client with its
 * tokens, and register a handler that persists rotated tokens back to Postgres
 * so subsequent calls pick up the new access_token.
 *
 * Throws NotConnectedError if no account is stored — callers can surface 409.
 */
export async function authedClient() {
  const acct = await prisma.youTubeAccount.findUnique({
    where: { id: "default" },
  });
  if (!acct) throw new NotConnectedError();

  const client = oauthClient();
  client.setCredentials({
    access_token: decryptSecret(acct.accessToken),
    refresh_token: decryptSecret(acct.refreshToken),
    expiry_date: acct.tokenExpiresAt.getTime(),
    scope: acct.scope,
  });

  client.on("tokens", async (tokens) => {
    try {
      await prisma.youTubeAccount.update({
        where: { id: "default" },
        data: {
          accessToken: tokens.access_token
            ? encryptSecret(tokens.access_token)
            : acct.accessToken,
          ...(tokens.refresh_token
            ? { refreshToken: encryptSecret(tokens.refresh_token) }
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
 * Pluck a numeric cell from an Analytics reports.query row, tolerating
 * missing columns, string-encoded numbers, and non-finite values.
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
