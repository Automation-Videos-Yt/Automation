"use client";

import { PerformancePrediction, VideoAnalyticsSnapshot } from "../services/api";

function scoreColor(score: number) {
  if (score >= 7.5) return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  if (score >= 5) return "text-yellow-200 border-yellow-500/40 bg-yellow-500/10";
  return "text-red-300 border-red-500/40 bg-red-500/10";
}

export function PredictionCard({
  prediction,
  actual,
}: {
  prediction: PerformancePrediction;
  actual: VideoAnalyticsSnapshot | null | undefined;
}) {
  return (
    <section
      className={`rounded-md border p-4 space-y-3 ${scoreColor(prediction.score)}`}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Performance prediction</h2>
        <div className="text-xs text-white/60">
          generated at pipeline time · advisory
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Pair
          label="Predicted CTR"
          predicted={`${prediction.predictedCtr.toFixed(2)}%`}
          actual={actual?.ctr != null ? `${actual.ctr.toFixed(2)}%` : null}
        />
        <Pair
          label="Predicted retention"
          predicted={`${prediction.predictedRetention.toFixed(1)}%`}
          actual={
            actual?.avgViewPercentage != null
              ? `${actual.avgViewPercentage.toFixed(1)}%`
              : null
          }
        />
        <Pair
          label="Score"
          predicted={prediction.score.toFixed(1)}
          actual={null}
          suffix=" / 10"
        />
      </div>

      <div className="text-sm text-white/80 whitespace-pre-wrap">
        {prediction.reasoning}
      </div>
    </section>
  );
}

function Pair({
  label,
  predicted,
  actual,
  suffix,
}: {
  label: string;
  predicted: string;
  actual: string | null;
  suffix?: string;
}) {
  return (
    <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/60">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums text-white">
        {predicted}
        {suffix}
      </div>
      {actual != null && (
        <div className="text-xs text-white/70 mt-0.5">actual: {actual}</div>
      )}
    </div>
  );
}
