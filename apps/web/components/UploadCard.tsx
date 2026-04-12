"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, UploadPrivacy, YouTubeUpload } from "../services/api";

function statusColor(status: YouTubeUpload["status"]) {
  switch (status) {
    case "COMPLETED":
      return "text-emerald-400";
    case "FAILED":
      return "text-red-400";
    case "RUNNING":
      return "text-yellow-400";
    default:
      return "text-white/60";
  }
}

export function UploadCard({
  runId,
  initial,
}: {
  runId: string;
  initial: YouTubeUpload | null | undefined;
}) {
  const [privacy, setPrivacy] = useState<UploadPrivacy>("PRIVATE");
  const qc = useQueryClient();

  const { data: ytStatus } = useQuery({
    queryKey: ["yt-status"],
    queryFn: () => api.youtubeStatus(),
  });

  const { data: upload } = useQuery({
    queryKey: ["upload", runId],
    queryFn: () => api.getUpload(runId),
    enabled: !!initial,
    initialData: initial ?? undefined,
    refetchInterval: (q) => {
      const u = q.state.data;
      if (!u) return false;
      return u.status === "PENDING" || u.status === "RUNNING" ? 2000 : false;
    },
  });

  const start = useMutation({
    mutationFn: () => api.startUpload(runId, privacy),
    onSuccess: (u) => {
      qc.setQueryData(["upload", runId], u);
      qc.invalidateQueries({ queryKey: ["upload", runId] });
    },
  });

  const connected = ytStatus?.connected === true;
  const current = upload ?? initial ?? null;
  const inFlight =
    current?.status === "PENDING" || current?.status === "RUNNING";

  return (
    <section className="rounded-md border border-white/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Publish to YouTube</h2>
        {current && (
          <span className={`text-xs ${statusColor(current.status)}`}>
            {current.status}
          </span>
        )}
      </div>

      {!connected && (
        <div className="text-sm text-white/60">
          Connect a YouTube account first (top right) to enable upload.
        </div>
      )}

      {current?.videoUrl && (
        <a
          href={current.videoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm text-emerald-300 underline"
        >
          {current.videoUrl}
        </a>
      )}

      {current?.errorMessage && (
        <div className="text-sm text-red-300">{current.errorMessage}</div>
      )}

      {!current?.youtubeVideoId && (
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-white/60 flex flex-col gap-1">
            Privacy
            <select
              value={privacy}
              onChange={(e) => setPrivacy(e.target.value as UploadPrivacy)}
              disabled={!connected || inFlight}
              className="rounded-md bg-white/5 border border-white/10 px-2 py-1.5 text-sm"
            >
              <option value="PRIVATE">Private</option>
              <option value="UNLISTED">Unlisted</option>
              <option value="PUBLIC">Public</option>
            </select>
          </label>
          <button
            onClick={() => start.mutate()}
            disabled={!connected || inFlight || start.isPending}
            className="rounded-md bg-white text-black text-sm px-4 py-1.5 font-medium disabled:opacity-40"
          >
            {inFlight
              ? "Uploading…"
              : current?.status === "FAILED"
              ? "Retry upload"
              : "Upload"}
          </button>
        </div>
      )}
    </section>
  );
}
