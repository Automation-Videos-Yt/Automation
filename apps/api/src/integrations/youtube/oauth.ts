import { google } from "googleapis";
import { env } from "../../config/env";

// Scope notes:
// - youtube.upload: videos.insert + thumbnails.set for videos the app uploaded
// - youtube.readonly: channel info (handle, title) for the status endpoint
// - yt-analytics.readonly: YouTube Analytics reports.query (Phase 4 feedback loop)
export const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

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
