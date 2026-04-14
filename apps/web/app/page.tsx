"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../services/api";

type Preset = { label: string; value: number };
const PRESETS: Preset[] = [
  { label: "Snappy · 15s", value: 15 },
  { label: "Short · 25s", value: 25 },
  { label: "Standard · 45s", value: 45 },
  { label: "Long · 75s", value: 75 },
];

export default function HomePage() {
  const [niche, setNiche] = useState("");
  const [durationSec, setDurationSec] = useState<number>(75);
  const [custom, setCustom] = useState(false);
  const [count, setCount] = useState<number>(1);
  const router = useRouter();

  const single = useMutation({
    mutationFn: (v: { niche: string; durationSec: number }) =>
      api.createRun(v.niche, v.durationSec),
    onSuccess: (run) => router.push(`/runs/${run.id}`),
  });

  const batch = useMutation({
    mutationFn: (v: { niche: string; durationSec: number; count: number }) =>
      api.createBatch(v.niche, v.count, v.durationSec),
    onSuccess: () => router.push("/runs"),
  });

  const pending = single.isPending || batch.isPending;
  const err = single.error ?? batch.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Generate a video</h1>
        <p className="text-white/60 mt-1">
          Pick a niche and duration. The pipeline picks a topic, writes a script,
          generates TTS, and renders a vertical video with burned-in subtitles.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = niche.trim();
          if (trimmed.length < 3) return;
          if (count > 1) {
            batch.mutate({ niche: trimmed, durationSec, count });
          } else {
            single.mutate({ niche: trimmed, durationSec });
          }
        }}
        className="space-y-4 max-w-xl"
      >
        <div className="flex gap-2">
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
            disabled={pending}
            className="rounded-md bg-white text-black px-4 py-2 font-medium disabled:opacity-50"
          >
            {pending
              ? count > 1
                ? `Queueing ${count}…`
                : "Starting..."
              : count > 1
              ? `Start ${count} runs`
              : "Start run"}
          </button>
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-white/50">
            Target duration
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const active = !custom && durationSec === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => {
                    setDurationSec(p.value);
                    setCustom(false);
                  }}
                  className={`text-sm rounded-md border px-3 py-1.5 ${
                    active
                      ? "bg-white text-black border-white"
                      : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setCustom(true)}
              className={`text-sm rounded-md border px-3 py-1.5 ${
                custom
                  ? "bg-white text-black border-white"
                  : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
              }`}
            >
              Custom
            </button>
            {custom && (
              <input
                type="number"
                min={10}
                max={180}
                value={durationSec}
                onChange={(e) =>
                  setDurationSec(
                    Math.max(10, Math.min(180, Number(e.target.value) || 10))
                  )
                }
                className="w-24 rounded-md bg-white/5 border border-white/10 px-2 py-1.5 text-sm"
              />
            )}
          </div>
          <div className="text-xs text-white/50">
            10–180s · short durations auto-use 4s scene chunks instead of 7.5s
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-white/50">
            Batch size
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[1, 3, 5, 10].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCount(n)}
                className={`text-sm rounded-md border px-3 py-1.5 ${
                  count === n
                    ? "bg-white text-black border-white"
                    : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
                }`}
              >
                {n === 1 ? "Single" : `×${n}`}
              </button>
            ))}
            <span className="text-xs text-white/50">
              duplicate-topic guard prevents the batch from landing on the same idea
            </span>
          </div>
        </div>
      </form>

      {err && (
        <div className="text-red-400 text-sm">
          {(err as Error).message}
        </div>
      )}
    </div>
  );
}
