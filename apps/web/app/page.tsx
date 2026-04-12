"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../services/api";

export default function HomePage() {
  const [niche, setNiche] = useState("");
  const router = useRouter();

  const m = useMutation({
    mutationFn: (v: string) => api.createRun(v),
    onSuccess: (run) => router.push(`/runs/${run.id}`),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Generate a video</h1>
        <p className="text-white/60 mt-1">
          Pick a niche. The pipeline picks a topic, writes a script, generates TTS, and
          renders a video with burned-in subtitles.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (niche.trim().length >= 3) m.mutate(niche.trim());
        }}
        className="flex gap-2 max-w-xl"
      >
        <input
          value={niche}
          onChange={(e) => setNiche(e.target.value)}
          placeholder="e.g. productivity hacks"
          className="flex-1 rounded-md bg-white/5 border border-white/10 px-3 py-2 outline-none focus:border-white/30"
          minLength={3}
          maxLength={120}
          required
        />
        <button
          type="submit"
          disabled={m.isPending}
          className="rounded-md bg-white text-black px-4 py-2 font-medium disabled:opacity-50"
        >
          {m.isPending ? "Starting..." : "Start run"}
        </button>
      </form>

      {m.error && (
        <div className="text-red-400 text-sm">
          {(m.error as Error).message}
        </div>
      )}
    </div>
  );
}
