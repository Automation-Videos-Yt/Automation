"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

function tagColor(tag: string) {
  switch (tag.toLowerCase()) {
    case "strong":
      return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
    case "weak":
      return "bg-red-500/20 text-red-300 border-red-500/40";
    default:
      return "bg-yellow-500/20 text-yellow-200 border-yellow-500/40";
  }
}

export function FeedbackCard({
  runId,
  hasUpload,
}: {
  runId: string;
  hasUpload: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["run-analytics", runId],
    queryFn: () => api.getRunAnalytics(runId),
    enabled: hasUpload,
    refetchInterval: 5000,
  });

  const fb = data?.feedback;
  if (!fb) return null;

  return (
    <section className="rounded-md border border-white/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Feedback insights</h2>
        <span
          className={`text-xs rounded-md border px-2 py-0.5 ${tagColor(
            fb.performanceTag
          )}`}
        >
          {fb.performanceTag}
        </span>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-emerald-400/80 mb-1">
          What worked
        </div>
        <p className="text-sm whitespace-pre-wrap">{fb.whatWorked}</p>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-red-400/80 mb-1">
          What didn&apos;t
        </div>
        <p className="text-sm whitespace-pre-wrap">{fb.whatDidnt}</p>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-white/60 mb-1">
          Suggestions for next run
        </div>
        <p className="text-sm whitespace-pre-wrap">{fb.suggestions}</p>
      </div>

      <div className="text-[11px] text-white/40">
        generated {new Date(fb.updatedAt).toLocaleString()}
      </div>
    </section>
  );
}
