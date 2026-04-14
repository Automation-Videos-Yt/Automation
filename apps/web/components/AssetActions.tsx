"use client";

import { useState } from "react";
import { api, PipelineRun } from "../services/api";

function DownloadLink({
  href,
  label,
  filename,
}: {
  href: string;
  label: string;
  filename?: string;
}) {
  return (
    <a
      href={href}
      download={filename}
      target="_blank"
      rel="noreferrer"
      className="text-xs rounded-md bg-white/5 border border-white/10 text-white/80 px-3 py-1.5 hover:bg-white/10"
    >
      ↓ {label}
    </a>
  );
}

function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard disabled in insecure contexts — ignore
        }
      }}
      className="text-xs rounded-md bg-white/5 border border-white/10 text-white/80 px-3 py-1.5 hover:bg-white/10"
    >
      {copied ? "✓ copied" : `⧉ ${label}`}
    </button>
  );
}

export function AssetActions({ run }: { run: PipelineRun }) {
  const hasAudio = !!run.voiceAsset?.audioPath;
  const hasVideo = !!run.video?.videoPath;
  const hasThumb = !!run.video?.thumbnailPath;
  const srtUrl = `${api.base}/media/temp/${run.id}/subs.srt`;

  const scriptText = run.script
    ? [run.script.hook, run.script.body, run.script.cta]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const metaText =
    run.video && run.video.title
      ? `${run.video.title}\n\n${run.video.description ?? ""}\n\nTags: ${(
          run.video.tags ?? []
        ).join(", ")}`
      : "";

  const anyAction =
    scriptText || hasAudio || hasVideo || hasThumb || metaText;
  if (!anyAction) return null;

  return (
    <section className="rounded-md border border-white/10 p-4 space-y-2">
      <h2 className="font-semibold">Assets</h2>
      <div className="flex flex-wrap gap-2">
        {scriptText && (
          <CopyButton text={scriptText} label="copy script" />
        )}
        {metaText && <CopyButton text={metaText} label="copy SEO metadata" />}
        {hasAudio && (
          <DownloadLink
            href={api.mediaUrl(run.voiceAsset!.audioPath)}
            label="audio (mp3)"
            filename={`${run.id}.mp3`}
          />
        )}
        {hasVideo && (
          <>
            <DownloadLink
              href={api.mediaUrl(run.video!.videoPath)}
              label="video (mp4)"
              filename={`${run.id}.mp4`}
            />
            <DownloadLink href={srtUrl} label="subtitles (srt)" filename={`${run.id}.srt`} />
          </>
        )}
        {hasThumb && (
          <DownloadLink
            href={api.mediaUrl(run.video!.thumbnailPath!)}
            label="thumbnail (png)"
            filename={`${run.id}.png`}
          />
        )}
      </div>
    </section>
  );
}
