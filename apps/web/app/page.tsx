"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type RunFeatureToggles } from "../services/api";

type Preset = { label: string; value: number };
const PRESETS: Preset[] = [
  { label: "Snappy · 15s", value: 15 },
  { label: "Short · 25s", value: 25 },
  { label: "Standard · 45s", value: 45 },
  { label: "Long · 75s", value: 75 },
];

const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "id", label: "Indonesian" },
  { code: "ja", label: "Japanese" },
];

const FEATURE_OPTIONS: Array<{
  key: keyof RunFeatureToggles;
  label: string;
  hint: string;
}> = [
  {
    key: "enableTimestamp",
    label: "Timestamp Alignment",
    hint: "Whisper word timing for better scene pacing.",
  },
  {
    key: "enableSubtitles",
    label: "Burned-In Subtitles",
    hint: "Render subtitles directly into the final video.",
  },
  {
    key: "enableThumbnail",
    label: "AI Thumbnail",
    hint: "Generate a custom thumbnail when enabled server-side.",
  },
  {
    key: "enableHookVariants",
    label: "Hook A/B Variants",
    hint: "Spawn multiple hook variants when A/B testing is enabled.",
  },
];

export default function HomePage() {
  const [niche, setNiche] = useState("");
  const [durationSec, setDurationSec] = useState<number>(75);
  const [custom, setCustom] = useState(false);
  const [count, setCount] = useState<number>(1);
  const [languageCodes, setLanguageCodes] = useState<string[]>(["en"]);
  const [features, setFeatures] = useState<RunFeatureToggles>({
    enableTimestamp: true,
    enableSubtitles: true,
    enableThumbnail: true,
    enableHookVariants: false,
  });
  const router = useRouter();

  const plannedRuns = count * Math.max(languageCodes.length, 1);
  const isMultiCreate = count > 1 || languageCodes.length > 1;

  function toggleLanguage(code: string) {
    setLanguageCodes((prev) => {
      if (prev.includes(code)) {
        // Always keep at least one language selected.
        return prev.length > 1 ? prev.filter((c) => c !== code) : prev;
      }
      return [...prev, code];
    });
  }

  function toggleFeature(key: keyof RunFeatureToggles) {
    setFeatures((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (key === "enableTimestamp" && !next.enableTimestamp) {
        next.enableSubtitles = false;
      }
      if (key === "enableSubtitles" && next.enableSubtitles) {
        next.enableTimestamp = true;
      }
      return next;
    });
  }

  const single = useMutation({
    mutationFn: (v: {
      niche: string;
      durationSec: number;
      languageCode: string;
      features: RunFeatureToggles;
    }) => api.createRun(v.niche, v.durationSec, v.languageCode, v.features),
    onSuccess: (run) => router.push(`/runs/${run.id}`),
  });

  const batch = useMutation({
    mutationFn: (v: {
      niche: string;
      durationSec: number;
      count: number;
      languageCodes: string[];
      features: RunFeatureToggles;
    }) =>
      api.createBatch(
        v.niche,
        v.count,
        v.durationSec,
        v.languageCodes,
        v.features,
      ),
    onSuccess: () => router.push("/runs"),
  });

  const pending = single.isPending || batch.isPending;
  const err = single.error ?? batch.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Generate a video</h1>
        <p className="text-white/60 mt-1">
          Pick a niche and duration. The pipeline picks a topic, writes a
          script, generates TTS, and renders a vertical video with burned-in
          subtitles.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = niche.trim();
          if (trimmed.length < 3) return;
          if (isMultiCreate) {
            batch.mutate({
              niche: trimmed,
              durationSec,
              count,
              languageCodes,
              features,
            });
          } else {
            single.mutate({
              niche: trimmed,
              durationSec,
              languageCode: languageCodes[0] ?? "en",
              features,
            });
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
              ? isMultiCreate
                ? `Queueing ${plannedRuns}…`
                : "Starting..."
              : isMultiCreate
                ? `Start ${plannedRuns} runs`
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
                    Math.max(10, Math.min(180, Number(e.target.value) || 10)),
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
            Languages
          </div>
          <div className="flex flex-wrap gap-2">
            {LANGUAGE_OPTIONS.map((lang) => {
              const active = languageCodes.includes(lang.code);
              return (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => toggleLanguage(lang.code)}
                  className={`text-sm rounded-md border px-3 py-1.5 ${
                    active
                      ? "bg-white text-black border-white"
                      : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
                  }`}
                >
                  {lang.label}
                </button>
              );
            })}
          </div>
          <div className="text-xs text-white/50">
            Select one or more languages. Each selected language generates its
            own video run.
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-white/50">
            Features
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            {FEATURE_OPTIONS.map((feature) => {
              const active = features[feature.key];
              return (
                <button
                  key={feature.key}
                  type="button"
                  onClick={() => toggleFeature(feature.key)}
                  className={`text-left rounded-md border px-3 py-2 transition-colors ${
                    active
                      ? "bg-white text-black border-white"
                      : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{feature.label}</span>
                    <span className="text-[11px] uppercase tracking-wide">
                      {active ? "On" : "Off"}
                    </span>
                  </div>
                  <div
                    className={`text-xs mt-1 ${
                      active ? "text-black/70" : "text-white/55"
                    }`}
                  >
                    {feature.hint}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="text-xs text-white/50">
            Subtitles require timestamp alignment. Non-English runs currently
            skip timestamps and subtitles automatically.
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
              planned jobs: {plannedRuns} ({count} per language ×{" "}
              {languageCodes.length} language
              {languageCodes.length === 1 ? "" : "s"})
            </span>
          </div>
        </div>
      </form>

      {err && (
        <div className="text-red-400 text-sm">{(err as Error).message}</div>
      )}
    </div>
  );
}
