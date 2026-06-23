import { createReadStream } from "node:fs";
import { google } from "googleapis";
import { authedYouTubeClient } from "../integrations/youtube/client";
import { scoped } from "../lib/logger";
import { FatalError, TransientError } from "../lib/errors";
import { isS3Path, getS3KeyFromPath, downloadFileFromS3 } from "../lib/s3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const log = scoped("yt-client");

async function loadAuthedClient() {
  const { client } = await authedYouTubeClient();
  return client;
}

export type UploadOptions = {
  videoPath: string;
  thumbnailPath?: string | null;
  title: string;
  description: string;
  tags: string[];
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
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
      language: opts.defaultLanguage,
      privacy: opts.privacyStatus,
      file: opts.videoPath,
    },
    "videos.insert start",
  );

  // Handle S3 files by downloading them locally first
  let localVideoPath = opts.videoPath;
  let tempVideoPath: string | null = null;
  if (isS3Path(opts.videoPath)) {
    tempVideoPath = path.join(os.tmpdir(), `yt_upload_${crypto.randomUUID()}.mp4`);
    log.info({ s3Url: opts.videoPath }, "Downloading video from S3 for YouTube upload");
    await downloadFileFromS3(getS3KeyFromPath(opts.videoPath), tempVideoPath);
    localVideoPath = tempVideoPath;
  }

  let localThumbPath = opts.thumbnailPath;
  let tempThumbPath: string | null = null;
  if (opts.thumbnailPath && isS3Path(opts.thumbnailPath)) {
    tempThumbPath = path.join(os.tmpdir(), `yt_thumb_${crypto.randomUUID()}.jpg`);
    log.info({ s3Url: opts.thumbnailPath }, "Downloading thumbnail from S3");
    await downloadFileFromS3(getS3KeyFromPath(opts.thumbnailPath), tempThumbPath);
    localThumbPath = tempThumbPath;
  }

  try {
    const insertRes = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: opts.title.slice(0, 100),
          description: opts.description.slice(0, 5000),
          tags,
          categoryId: opts.categoryId ?? "22",
          ...(opts.defaultLanguage
            ? { defaultLanguage: opts.defaultLanguage }
            : {}),
          ...(opts.defaultAudioLanguage
            ? { defaultAudioLanguage: opts.defaultAudioLanguage }
            : {}),
        },
        status: {
          privacyStatus: opts.privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: createReadStream(localVideoPath),
      },
    });

    const videoId = insertRes.data.id;
    if (!videoId) {
      throw new Error("videos.insert returned no id");
    }
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    log.info({ videoId }, "videos.insert ok");

    if (localThumbPath) {
      try {
        await youtube.thumbnails.set({
          videoId,
          media: { body: createReadStream(localThumbPath) },
        });
        log.info({ videoId }, "thumbnails.set ok");
      } catch (err) {
        // Thumbnail failure is non-fatal — the video is already up.
        log.warn({ err, videoId }, "thumbnails.set failed — continuing");
      }
    }

    return { videoId, videoUrl };
  } catch (err: any) {
    if (err.status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
      throw new TransientError(`YouTube API temporarily unavailable: ${err.message}`, { originalError: err.message });
    } else if (err.status === 401 || err.status === 403) {
      throw new FatalError(`YouTube authentication or quota failed: ${err.message}`, { originalError: err.message });
    }
    throw new FatalError(`YouTube upload failed: ${err.message}`, { originalError: err.message });
  } finally {
    if (tempVideoPath) await fs.unlink(tempVideoPath).catch(() => {});
    if (tempThumbPath) await fs.unlink(tempThumbPath).catch(() => {});
  }
}
