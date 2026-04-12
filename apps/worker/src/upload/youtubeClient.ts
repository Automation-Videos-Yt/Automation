import { createReadStream } from "node:fs";
import { google } from "googleapis";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("yt-client");

function oauth2() {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not configured");
  }
  return new google.auth.OAuth2(
    env.YOUTUBE_CLIENT_ID,
    env.YOUTUBE_CLIENT_SECRET,
    env.YOUTUBE_REDIRECT_URI
  );
}

async function loadAuthedClient() {
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

  // Persist rotated tokens automatically.
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

  return client;
}

export type UploadOptions = {
  videoPath: string;
  thumbnailPath?: string | null;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: "private" | "unlisted" | "public";
  categoryId?: string; // default "22" (People & Blogs)
};

/**
 * YouTube tag rules:
 *   - Total concatenated length <= 500 chars; tags containing spaces are
 *     effectively quoted, so each counts as `tag.length + 2` against the budget.
 *   - Individual tag length <= 100 chars.
 *   - No `<` or `>`.
 *   - No empty strings; no duplicates (case-insensitive).
 * Over-budget runs get the tail dropped rather than the whole upload failing.
 */
export function sanitizeYouTubeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  let budget = 500;

  for (const t of raw) {
    if (typeof t !== "string") continue;
    const stripped = t.replace(/[<>]/g, "").trim();
    if (!stripped) continue;
    const capped = stripped.slice(0, 100);
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;

    const cost = capped.includes(" ") ? capped.length + 2 : capped.length;
    if (cost > budget) continue;

    seen.add(key);
    clean.push(capped);
    budget -= cost;
  }
  return clean;
}

export async function uploadToYouTube(opts: UploadOptions): Promise<{
  videoId: string;
  videoUrl: string;
}> {
  const auth = await loadAuthedClient();
  const youtube = google.youtube({ version: "v3", auth });

  const tags = sanitizeYouTubeTags(opts.tags).slice(0, 30);

  log.info(
    {
      title: opts.title,
      tagCountRaw: opts.tags.length,
      tagCountClean: tags.length,
      privacy: opts.privacyStatus,
      file: opts.videoPath,
    },
    "videos.insert start"
  );

  const insertRes = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: opts.title.slice(0, 100),
        description: opts.description.slice(0, 5000),
        tags,
        categoryId: opts.categoryId ?? "22",
      },
      status: {
        privacyStatus: opts.privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(opts.videoPath),
    },
  });

  const videoId = insertRes.data.id;
  if (!videoId) {
    throw new Error("videos.insert returned no id");
  }
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  log.info({ videoId }, "videos.insert ok");

  if (opts.thumbnailPath) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: { body: createReadStream(opts.thumbnailPath) },
      });
      log.info({ videoId }, "thumbnails.set ok");
    } catch (err) {
      // Thumbnail failure is non-fatal — the video is already up.
      log.warn({ err, videoId }, "thumbnails.set failed — continuing");
    }
  }

  return { videoId, videoUrl };
}
