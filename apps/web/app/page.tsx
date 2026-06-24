"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type RunFeatureToggles } from "../services/api";
import { calculateRunCost } from "@youtube-automation/pricing";

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
  const [languageCode, setLanguageCode] = useState<string>("en");
  const [features, setFeatures] = useState<RunFeatureToggles>({
    enableTimestamp: true,
    enableSubtitles: true,
    enableThumbnail: true,
    enableHookVariants: false,
  });
  const router = useRouter();

  function toggleLanguage(code: string) {
    setLanguageCode(code);
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

  const pending = single.isPending;
  const err = single.error;

  const costSnapshot = calculateRunCost({
    durationSec,
    languageCode,
    generateThumbnail: features.enableThumbnail,
    generateSubtitles: features.enableSubtitles,
  });

  return (
    <div className="space-y-8 relative">
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-indigo-500/10 blur-[120px] pointer-events-none rounded-full" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 blur-[100px] pointer-events-none rounded-full" />
      
      <div className="relative z-10">
        <h1 className="text-4xl font-bold tracking-tight text-white drop-shadow-sm">Generate a video</h1>
        <p className="text-white/60 mt-2 text-lg max-w-2xl leading-relaxed">
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
          single.mutate({
            niche: trimmed,
            durationSec,
            languageCode,
            features,
          });
        }}
        className="space-y-6 max-w-xl bg-white/[0.03] backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-2xl shadow-2xl relative z-10"
      >
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="e.g. productivity hacks"
            className="flex-1 rounded-xl bg-black/20 border border-white/10 px-4 py-3 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all shadow-inner text-base"
            minLength={3}
            maxLength={120}
            required
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white px-6 py-3 font-semibold shadow-lg hover:shadow-indigo-500/25 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            {pending ? "Starting..." : "Start run"}
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
                  className={`text-sm rounded-lg border px-4 py-2 font-medium transition-all ${
                    active
                      ? "bg-indigo-500/20 text-indigo-200 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.15)]"
                      : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setCustom(true)}
              className={`text-sm rounded-lg border px-4 py-2 font-medium transition-all ${
                custom
                  ? "bg-indigo-500/20 text-indigo-200 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.15)]"
                  : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
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
                className="w-24 rounded-lg bg-black/20 border border-white/10 px-3 py-2 text-sm outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all shadow-inner"
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
              const active = languageCode === lang.code;
              return (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => toggleLanguage(lang.code)}
                  className={`text-sm rounded-lg border px-4 py-2 font-medium transition-all ${
                    active
                      ? "bg-indigo-500/20 text-indigo-200 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.15)]"
                      : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {lang.label}
                </button>
              );
            })}
          </div>
          <div className="text-xs text-white/50">
            Select a language for the video run.
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
                  className={`text-left rounded-xl border px-4 py-3 transition-all flex flex-col justify-center ${
                    active
                      ? "bg-indigo-500/10 border-indigo-500/40 shadow-[0_0_15px_rgba(99,102,241,0.1)]"
                      : "bg-white/5 border-white/10 hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{feature.label}</span>
                    <span className="text-[11px] uppercase tracking-wide">
                      {active ? "On" : "Off"}
                    </span>
                  </div>
                  <div
                    className={`text-xs mt-1 leading-relaxed ${
                      active ? "text-indigo-200/80" : "text-white/50"
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


      </form>

      {err && (
        <div className="text-red-400 text-sm">
          {(err as Error).message.includes("Not enough credits") || (err as Error).message.includes("402") ? (
            <div className="flex items-center gap-4 bg-red-500/10 p-4 rounded-xl border border-red-500/20">
              <span>Insufficient credits. You need {costSnapshot.total} credits for this run.</span>
              <button onClick={() => router.push("/pricing")} className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg font-medium transition-colors">
                Buy Credits
              </button>
            </div>
          ) : (
            (err as Error).message
          )}
        </div>
      )}

      {/* Itemized Breakdown */}
      <div className="max-w-xl bg-white/[0.03] backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-2xl shadow-2xl relative z-10 space-y-4">
        <h3 className="text-xl font-semibold text-white drop-shadow-sm">Estimated Cost</h3>
        <div className="space-y-2 text-sm text-white/80">
          <div className="flex justify-between">
            <span>Base Video (up to 60s)</span>
            <span>{costSnapshot.breakdown.base} credits</span>
          </div>
          {costSnapshot.breakdown.duration > 0 && (
            <div className="flex justify-between text-indigo-300">
              <span>Extra Duration ({durationSec - 60}s)</span>
              <span>+{costSnapshot.breakdown.duration} credits</span>
            </div>
          )}
          {costSnapshot.breakdown.language > 0 && (
            <div className="flex justify-between text-indigo-300">
              <span>Non-English ({languageCode})</span>
              <span>+{costSnapshot.breakdown.language} credits</span>
            </div>
          )}
          {costSnapshot.breakdown.thumbnail > 0 && (
            <div className="flex justify-between text-indigo-300">
              <span>AI Thumbnail</span>
              <span>+{costSnapshot.breakdown.thumbnail} credits</span>
            </div>
          )}
          {costSnapshot.breakdown.subtitles > 0 && (
            <div className="flex justify-between text-indigo-300">
              <span>Burned-In Subtitles</span>
              <span>+{costSnapshot.breakdown.subtitles} credits</span>
            </div>
          )}
          <div className="border-t border-white/10 pt-2 mt-2 flex justify-between font-bold text-white text-base">
            <span>Total Cost</span>
            <span className="text-indigo-400">{costSnapshot.total} credits</span>
          </div>
        </div>
      </div>
    </div>
  );
}
