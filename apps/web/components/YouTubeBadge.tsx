"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";

export function YouTubeBadge() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["yt-status"],
    queryFn: () => api.youtubeStatus(),
    refetchOnWindowFocus: true,
  });
  const disconnect = useMutation({
    mutationFn: () => api.youtubeDisconnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["yt-status"] }),
  });

  if (isLoading) {
    return <span className="text-xs text-white/40">…</span>;
  }

  if (!data?.connected) {
    return (
      <a
        href={api.youtubeConnectUrl()}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs rounded-md bg-red-500/20 border border-red-500/40 text-red-200 px-3 py-1.5 hover:bg-red-500/30"
      >
        Connect YouTube
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="text-xs">
        <div className="text-emerald-400">● YouTube connected</div>
        <div className="text-white/50">
          {data.channelTitle ?? data.channelId}
        </div>
      </div>
      <button
        onClick={() => disconnect.mutate()}
        className="text-xs text-white/50 hover:text-white underline"
      >
        disconnect
      </button>
    </div>
  );
}
