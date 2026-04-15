"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api, PipelineRun } from "../../../services/api";
import { UploadCard } from "../../../components/UploadCard";
import { AnalyticsCard } from "../../../components/AnalyticsCard";
import { FeedbackCard } from "../../../components/FeedbackCard";
import { PredictionCard } from "../../../components/PredictionCard";
import { AssetActions } from "../../../components/AssetActions";

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  hi: "Hindi",
  ar: "Arabic",
  id: "Indonesian",
  ja: "Japanese",
};

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}

const STAGES: PipelineRun["stage"][] = [
  "TOPIC",
  "SCRIPT",
  "HOOK",
  "PREDICTION",
  "VOICE",
  "TIMESTAMP",
  "VIDEO_SELECTION",
  "VIDEO",
  "THUMBNAIL",
  "DONE",
];

function StageTimeline({ run }: { run: PipelineRun }) {
  const currentIdx = STAGES.indexOf(run.stage);
  return (
    <ol className="flex gap-2 flex-wrap">
      {STAGES.map((s, i) => {
        const done = i < currentIdx || run.stage === "DONE";
        const active = i === currentIdx && run.status === "RUNNING";
        const failed = run.status === "FAILED" && i === currentIdx;
        const cls = failed
          ? "bg-red-500/20 text-red-300 border-red-500/40"
          : done
            ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
            : active
              ? "bg-yellow-500/20 text-yellow-200 border-yellow-500/40 animate-pulse"
              : "bg-white/5 text-white/50 border-white/10";
        return (
          <li
            key={s}
            className={`rounded-md border px-3 py-1 text-xs font-medium ${cls}`}
          >
            {s.replace("_", " ")}
          </li>
        );
      })}
    </ol>
  );
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function useRunEvents(runId: string, onEvent: (kind: string) => void) {
  useEffect(() => {
    if (!runId) return;
    const url = `${
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"
    }/pipeline/${runId}/stream`;
    const es = new EventSource(url);
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data);
        onEvent(evt.kind ?? "update");
      } catch {
        onEvent("update");
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; leave it alone unless closed.
    };
    return () => es.close();
  }, [runId, onEvent]);
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();

  const { data: run } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id),
    // SSE is the primary notifier; polling survives as a slow fallback.
    refetchInterval: (q) => {
      const r = q.state.data;
      if (!r) return 4000;
      return r.status === "COMPLETED" || r.status === "FAILED" ? false : 10_000;
    },
  });

  const { data: logs } = useQuery({
    queryKey: ["run-logs", id],
    queryFn: () => api.getLogs(id),
    refetchInterval: () => {
      if (run?.status === "COMPLETED" || run?.status === "FAILED") return false;
      return 10_000;
    },
  });

  // Push-based refreshes: any worker-published event invalidates all run-scoped queries.
  useRunEvents(id, (kind) => {
    qc.invalidateQueries({ queryKey: ["run", id] });
    qc.invalidateQueries({ queryKey: ["run-logs", id] });
    if (kind === "upload" || kind === "analytics" || kind === "feedback") {
      qc.invalidateQueries({ queryKey: ["upload", id] });
      qc.invalidateQueries({ queryKey: ["run-analytics", id] });
    }
  });

  const retry = useMutation({
    mutationFn: () => api.retryRun(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["run", id] });
    },
  });

  const { data: analyticsData } = useQuery({
    queryKey: ["run-analytics", id],
    queryFn: () => api.getRunAnalytics(id),
    enabled: run?.upload?.status === "COMPLETED",
  });

  if (!run) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-white/50 text-sm">Run · {run.id}</div>
        <h1 className="text-2xl font-semibold mt-1">{run.niche}</h1>
        <div className="text-xs text-white/50 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>language: {languageLabel(run.languageCode)}</span>
          <span>target duration: {run.targetDurationSec}s</span>
          {run.cost && run.cost.totalUsd > 0 && (
            <span
              title={`voice $${run.cost.voiceUsd.toFixed(4)} · whisper $${run.cost.whisperUsd.toFixed(4)} · thumbnail $${run.cost.thumbnailUsd.toFixed(4)} · llm $${run.cost.llmUsd.toFixed(4)}`}
            >
              spend:{" "}
              <span className="tabular-nums text-white/70">
                ${run.cost.totalUsd.toFixed(3)}
              </span>
            </span>
          )}
          {run.cost?.source.voiceProvider && (
            <span className="text-white/40">
              voice: {run.cost.source.voiceProvider}
            </span>
          )}
        </div>
      </div>

      <StageTimeline run={run} />

      {run.status === "FAILED" && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 space-y-2">
          {run.errorMessage && (
            <div className="text-sm text-red-200">{run.errorMessage}</div>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="rounded-md bg-white text-black text-sm px-3 py-1.5 font-medium disabled:opacity-50"
            >
              {retry.isPending ? "Re-queuing…" : "Retry from last success"}
            </button>
            <span className="text-xs text-white/60">
              cached stages are reused — only the failing step (and anything
              after) re-runs
            </span>
          </div>
        </div>
      )}

      {run.topic && (
        <section className="rounded-md border border-white/10 p-4">
          <h2 className="font-semibold mb-2">Topic</h2>
          <div className="font-medium">{run.topic.title}</div>
          <div className="text-sm text-white/70 mt-1">
            Angle: {run.topic.angle}
          </div>
          <div className="text-sm text-white/60 mt-1">
            {run.topic.rationale}
          </div>
        </section>
      )}

      {run.script && (
        <section className="rounded-md border border-white/10 p-4 space-y-2">
          <h2 className="font-semibold">
            Script · {run.script.wordCount} words · ~
            {run.script.durationEstimateSec}s
          </h2>
          <p className="text-sm">
            <span className="text-white/50">Hook:</span> {run.script.hook}
          </p>
          <p className="text-sm whitespace-pre-wrap">{run.script.body}</p>
          <p className="text-sm">
            <span className="text-white/50">CTA:</span> {run.script.cta}
          </p>
        </section>
      )}

      {run.prediction && (
        <PredictionCard
          prediction={run.prediction}
          actual={analyticsData?.latest ?? null}
        />
      )}

      {run.hookVariants && run.hookVariants.length > 0 && (
        <section className="rounded-md border border-white/10 p-4 space-y-2">
          <h2 className="font-semibold">Hook variants</h2>
          <ul className="space-y-2">
            {run.hookVariants.map((v) => (
              <li
                key={v.id}
                className={`rounded border p-3 ${
                  v.chosen
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-white/10"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm">{v.text}</div>
                  <div className="text-xs tabular-nums text-white/60 shrink-0">
                    {v.score.toFixed(1)}
                    {v.chosen && (
                      <span className="ml-2 text-emerald-400">✓ chosen</span>
                    )}
                  </div>
                </div>
                {v.reasoning && (
                  <div className="text-xs text-white/50 mt-1">
                    {v.reasoning}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.scenes && run.scenes.length > 0 && (
        <section className="rounded-md border border-white/10 p-4 space-y-2">
          <h2 className="font-semibold">
            Scenes · {run.scenes.length}{" "}
            <span className="text-white/50 text-sm font-normal">
              ({run.scenes.filter((s) => s.clipUrl).length} with stock clip)
            </span>
          </h2>
          <ol className="divide-y divide-white/5">
            {run.scenes.map((s) => (
              <li key={s.id} className="py-2 flex gap-3 items-start">
                <div className="text-xs tabular-nums text-white/50 w-20 shrink-0 pt-0.5">
                  {fmtDur(s.startSec)} → {fmtDur(s.endSec)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{s.text}</div>
                  <div className="text-xs text-white/50 mt-0.5">
                    query: <span className="font-mono">{s.query ?? "—"}</span>
                    {s.clipSource && (
                      <span className="ml-2">
                        · {s.clipSource}
                        {s.clipDurationSec != null &&
                          ` (${s.clipDurationSec.toFixed(1)}s)`}
                      </span>
                    )}
                    {!s.clipUrl && (
                      <span className="ml-2 text-yellow-400">
                        · placeholder
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {run.video && (
        <section className="rounded-md border border-white/10 p-4 space-y-3">
          <h2 className="font-semibold">Final video</h2>
          <div className="grid md:grid-cols-[2fr_1fr] gap-4">
            <video
              controls
              className="w-full rounded-md bg-black"
              src={api.mediaUrl(run.video.videoPath)}
            />
            {run.video.thumbnailPath && (
              <div className="space-y-1">
                <div className="text-xs text-white/50">Thumbnail</div>
                <img
                  src={api.mediaUrl(run.video.thumbnailPath)}
                  alt="Thumbnail"
                  className="w-full rounded-md border border-white/10"
                />
              </div>
            )}
          </div>
          {run.video.title && (
            <div>
              <div className="text-xs text-white/50">SEO title</div>
              <div>{run.video.title}</div>
            </div>
          )}
          {run.video.tags && run.video.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {run.video.tags.map((t) => (
                <span
                  key={t}
                  className="text-xs rounded bg-white/10 px-2 py-0.5"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {run.video && run.status === "COMPLETED" && (
        <>
          <AssetActions run={run} />
          <UploadCard runId={run.id} initial={run.upload ?? null} />
        </>
      )}

      {run.upload?.status === "COMPLETED" && (
        <AnalyticsCard runId={run.id} hasUpload={true} />
      )}

      {run.upload?.status === "COMPLETED" && (
        <FeedbackCard runId={run.id} hasUpload={true} />
      )}

      <section className="rounded-md border border-white/10 p-4">
        <h2 className="font-semibold mb-3">Agent log</h2>
        {logs && logs.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-white/50">
              <tr>
                <th className="text-left py-1">Agent</th>
                <th className="text-left py-1">Status</th>
                <th className="text-right py-1">Duration</th>
                <th className="text-left py-1 pl-4">Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-white/5">
                  <td className="py-1">{l.agent}</td>
                  <td
                    className={
                      l.status === "FAILED"
                        ? "text-red-400"
                        : "text-emerald-400"
                    }
                  >
                    {l.status}
                  </td>
                  <td className="text-right tabular-nums">{l.durationMs} ms</td>
                  <td className="pl-4 text-red-300 text-xs">
                    {l.errorMessage ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-white/50 text-sm">No logs yet.</div>
        )}
      </section>
    </div>
  );
}
