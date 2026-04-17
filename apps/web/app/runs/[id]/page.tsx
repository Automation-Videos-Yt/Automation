"use client";

import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs";
import { api, PipelineRun } from "../../../services/api";
import { UploadCard } from "../../../components/UploadCard";
import { AnalyticsCard } from "../../../components/AnalyticsCard";
import { FeedbackCard } from "../../../components/FeedbackCard";
import { PredictionCard } from "../../../components/PredictionCard";
import { AssetActions } from "../../../components/AssetActions";
import { HookExperimentCard } from "../../../components/HookExperimentCard";
import { CostAnalysisCard } from "../../../components/CostAnalysisCard";

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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusVariant(status: PipelineRun["status"]) {
  if (status === "COMPLETED") return "success" as const;
  if (status === "FAILED") return "warning" as const;
  if (status === "RUNNING") return "default" as const;
  return "secondary" as const;
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
  const progress =
    run.status === "COMPLETED"
      ? 100
      : currentIdx < 0
        ? 0
        : Math.round(((currentIdx + 1) / STAGES.length) * 100);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-white/55">
        <span>Pipeline progress</span>
        <span className="tabular-nums">{progress}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full transition-all ${
            run.status === "FAILED" ? "bg-red-400" : "bg-indigo-400"
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <ol className="flex gap-2 flex-wrap">
        {STAGES.map((s, i) => {
          const done = i < currentIdx || run.stage === "DONE";
          const active = i === currentIdx && run.status === "RUNNING";
          const failed = run.status === "FAILED" && i === currentIdx;
          const cls = failed
            ? "bg-red-500/20 text-red-200 border-red-500/40"
            : done
              ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40"
              : active
                ? "bg-indigo-500/20 text-indigo-100 border-indigo-400/40 animate-pulse"
                : "bg-white/5 text-white/50 border-white/10";

          return (
            <li
              key={s}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium ${cls}`}
            >
              {s.replace("_", " ")}
            </li>
          );
        })}
      </ol>
    </div>
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

function StatTile({
  label,
  value,
  accent = "default",
}: {
  label: string;
  value: string;
  accent?: "default" | "success" | "warning" | "info";
}) {
  const accentClass =
    accent === "success"
      ? "border-emerald-300/25 bg-emerald-500/10"
      : accent === "warning"
        ? "border-amber-300/25 bg-amber-500/10"
        : accent === "info"
          ? "border-indigo-300/25 bg-indigo-500/10"
          : "border-white/10 bg-white/[0.03]";

  return (
    <div className={`rounded-xl border px-3.5 py-3 ${accentClass}`}>
      <div className="text-[11px] uppercase tracking-wide text-white/55">
        {label}
      </div>
      <div className="mt-1 text-base font-semibold text-white">{value}</div>
    </div>
  );
}

function EmptyPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
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
    qc.invalidateQueries({ queryKey: ["run-experiment", id] });
    qc.invalidateQueries({ queryKey: ["run-cost", id] });
    qc.invalidateQueries({ queryKey: ["run-cost-history", id] });
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

  const cancel = useMutation({
    mutationFn: () => api.cancelRun(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["run", id] });
      qc.invalidateQueries({ queryKey: ["run-logs", id] });
      qc.invalidateQueries({ queryKey: ["upload", id] });
    },
  });

  const { data: analyticsData } = useQuery({
    queryKey: ["run-analytics", id],
    queryFn: () => api.getRunAnalytics(id),
    enabled: run?.upload?.status === "COMPLETED",
  });

  const { data: experiment } = useQuery({
    queryKey: ["run-experiment", id],
    queryFn: () => api.getExperiment(id),
    enabled: !!run?.experimentId,
    refetchInterval: (q) => {
      const exp = q.state.data;
      if (!exp) return 10_000;
      return exp.canPickWinner ? 30_000 : 10_000;
    },
  });

  const logSummary = useMemo(() => {
    const entries = logs ?? [];
    let successCount = 0;
    let failedCount = 0;
    let totalDurationMs = 0;

    for (const entry of entries) {
      totalDurationMs += entry.durationMs;
      if (entry.status === "SUCCESS") successCount += 1;
      else failedCount += 1;
    }

    return {
      total: entries.length,
      successCount,
      failedCount,
      totalDurationMs,
    };
  }, [logs]);

  if (!run) {
    return (
      <div className="space-y-4">
        <div className="h-40 rounded-2xl bg-white/5 animate-pulse" />
        <div className="h-10 rounded-lg bg-white/5 animate-pulse" />
        <div className="h-64 rounded-2xl bg-white/5 animate-pulse" />
      </div>
    );
  }

  const canCancel = run.status === "QUEUED" || run.status === "RUNNING";
  const canRetry = run.status === "FAILED";
  const hasVideo = Boolean(run.video?.videoPath);
  const uploadCompleted = run.upload?.status === "COMPLETED";
  const estimatedSpend = run.cost ? `$${run.cost.totalUsd.toFixed(3)}` : "—";

  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden border-white/15 bg-gradient-to-br from-white/[0.08] via-white/[0.03] to-transparent">
        <div className="absolute -top-20 -right-12 h-44 w-44 rounded-full bg-indigo-500/15 blur-3xl" />
        <CardHeader className="relative pb-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-white/45">
                Run
              </div>
              <CardTitle className="mt-1 text-2xl tracking-tight">
                {run.niche}
              </CardTitle>
              <CardDescription className="mt-2 font-mono text-[11px] text-white/45">
                {run.id}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
              <Badge variant="secondary">{run.stage.replace("_", " ")}</Badge>
              {run.currentAgent && (
                <Badge variant="secondary">agent: {run.currentAgent}</Badge>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="relative space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Language"
              value={languageLabel(run.languageCode)}
            />
            <StatTile
              label="Target Duration"
              value={`${run.targetDurationSec}s`}
              accent="info"
            />
            <StatTile
              label="Estimated Spend"
              value={estimatedSpend}
              accent="warning"
            />
            <StatTile
              label="Created"
              value={formatDateTime(run.createdAt)}
              accent={run.status === "COMPLETED" ? "success" : "default"}
            />
          </div>

          <StageTimeline run={run} />

          <div className="flex flex-wrap items-center gap-2">
            {canCancel && (
              <Button
                variant="secondary"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
                className="border-amber-300/30 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"
              >
                {cancel.isPending ? "Canceling..." : "Cancel run"}
              </Button>
            )}

            {canRetry && (
              <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
                {retry.isPending ? "Re-queuing..." : "Retry from last success"}
              </Button>
            )}

            {run.upload?.videoUrl && (
              <a
                href={run.upload.videoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center whitespace-nowrap rounded-md border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white/90 hover:bg-white/20"
              >
                Open on YouTube
              </a>
            )}

            <div className="ml-auto text-xs text-white/50">
              updated {formatDateTime(run.updatedAt)}
            </div>
          </div>

          {run.status === "FAILED" && run.errorMessage && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
              {run.errorMessage}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="overview" className="space-y-3">
        <TabsList className="h-auto w-full justify-start gap-1 flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <CostAnalysisCard runId={run.id} initialCost={run.cost ?? null} />

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Current output snapshot
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>
                  <div className="text-xs text-white/50">Topic</div>
                  <div className="mt-0.5 text-white/90">
                    {run.topic?.title ?? "Not generated yet"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-white/50">Hook</div>
                  <div className="mt-0.5 text-white/90">
                    {run.script?.hook ?? "Not generated yet"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-white/50">Voice provider</div>
                  <div className="mt-0.5 text-white/90">
                    {run.cost?.source.voiceProvider ?? "Pending"}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Pipeline health</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Log events</span>
                  <span className="tabular-nums">{logSummary.total}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Succeeded</span>
                  <span className="tabular-nums text-emerald-300">
                    {logSummary.successCount}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Failed</span>
                  <span className="tabular-nums text-red-300">
                    {logSummary.failedCount}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Total stage time</span>
                  <span className="tabular-nums">
                    {(logSummary.totalDurationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Publish status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Upload status</span>
                  <span>{run.upload?.status ?? "Not started"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Analytics</span>
                  <span>
                    {uploadCompleted ? "Available" : "Pending upload"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Assets ready</span>
                  <span>{hasVideo ? "Yes" : "No"}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="content" className="space-y-4">
          {run.topic ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Topic</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="font-medium text-white">{run.topic.title}</div>
                <div className="text-white/70">Angle: {run.topic.angle}</div>
                <div className="text-white/60">{run.topic.rationale}</div>
              </CardContent>
            </Card>
          ) : (
            <EmptyPanel
              title="Topic not available"
              description="The topic stage has not completed yet."
            />
          )}

          {run.script ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Script · {run.script.wordCount} words · ~
                  {run.script.durationEstimateSec}s
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>
                  <span className="text-white/50">Hook:</span> {run.script.hook}
                </p>
                <p className="whitespace-pre-wrap text-white/90">
                  {run.script.body}
                </p>
                <p>
                  <span className="text-white/50">CTA:</span> {run.script.cta}
                </p>
              </CardContent>
            </Card>
          ) : (
            <EmptyPanel
              title="Script not available"
              description="The script stage has not completed yet."
            />
          )}

          {run.hookVariants && run.hookVariants.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Hook variants</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <ul className="space-y-2">
                  {run.hookVariants.map((variant) => (
                    <li
                      key={variant.id}
                      className={`rounded border p-3 ${
                        variant.chosen
                          ? "border-emerald-500/40 bg-emerald-500/10"
                          : "border-white/10 bg-white/[0.03]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-white/90">
                          {variant.text}
                        </div>
                        <div className="text-xs tabular-nums text-white/60 shrink-0">
                          {variant.score.toFixed(1)}
                          {variant.chosen && (
                            <span className="ml-2 text-emerald-300">
                              chosen
                            </span>
                          )}
                        </div>
                      </div>
                      {variant.reasoning && (
                        <div className="mt-1 text-xs text-white/55">
                          {variant.reasoning}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : (
            <EmptyPanel
              title="Hook variants not available"
              description="No hook variants were produced for this run."
            />
          )}
        </TabsContent>

        <TabsContent value="media" className="space-y-4">
          {run.video ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Final video</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
                  <video
                    controls
                    className="w-full rounded-md bg-black"
                    src={api.mediaUrl(run.video.videoPath)}
                  />
                  {run.video.thumbnailPath ? (
                    <div className="space-y-1">
                      <div className="text-xs text-white/50">Thumbnail</div>
                      <img
                        src={api.mediaUrl(run.video.thumbnailPath)}
                        alt="Thumbnail"
                        className="w-full rounded-md border border-white/10"
                      />
                    </div>
                  ) : (
                    <div className="rounded-md border border-white/10 bg-white/[0.03] p-3 text-sm text-white/60">
                      Thumbnail not generated.
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
                    {run.video.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs rounded bg-white/10 px-2 py-0.5"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <EmptyPanel
              title="Video not available"
              description="The video stage has not completed yet."
            />
          )}

          {run.scenes && run.scenes.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Scenes · {run.scenes.length}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="divide-y divide-white/5">
                  {run.scenes.map((scene) => (
                    <li
                      key={scene.id}
                      className="py-2.5 flex gap-3 items-start"
                    >
                      <div className="text-xs tabular-nums text-white/50 w-20 shrink-0 pt-0.5">
                        {fmtDur(scene.startSec)} {"->"} {fmtDur(scene.endSec)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white/90">
                          {scene.text}
                        </div>
                        <div className="text-xs text-white/50 mt-0.5">
                          query:{" "}
                          <span className="font-mono">
                            {scene.query ?? "—"}
                          </span>
                          {scene.clipSource && (
                            <span className="ml-2">
                              · {scene.clipSource}
                              {scene.clipDurationSec != null &&
                                ` (${scene.clipDurationSec.toFixed(1)}s)`}
                            </span>
                          )}
                          {!scene.clipUrl && (
                            <span className="ml-2 text-amber-300">
                              · placeholder
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : (
            <EmptyPanel
              title="Scene timeline not available"
              description="Scene metadata appears once the video selection stage completes."
            />
          )}

          {hasVideo && <AssetActions run={run} />}
          {hasVideo && run.status === "COMPLETED" && (
            <UploadCard runId={run.id} initial={run.upload ?? null} />
          )}
        </TabsContent>

        <TabsContent value="insights" className="space-y-4">
          {run.prediction ? (
            <PredictionCard
              prediction={run.prediction}
              actual={analyticsData?.latest ?? null}
            />
          ) : (
            <EmptyPanel
              title="Prediction unavailable"
              description="Prediction data appears after the prediction stage finishes."
            />
          )}

          {experiment && experiment.runs.length > 1 ? (
            <HookExperimentCard experiment={experiment} currentRunId={run.id} />
          ) : (
            <EmptyPanel
              title="Hook experiment unavailable"
              description="A/B experiment insight appears when the run belongs to a multi-variant experiment."
            />
          )}

          {uploadCompleted ? (
            <>
              <AnalyticsCard runId={run.id} hasUpload={true} />
              <FeedbackCard runId={run.id} hasUpload={true} />
            </>
          ) : (
            <EmptyPanel
              title="Analytics and feedback pending"
              description="Upload the video to YouTube and sync analytics to unlock feedback insights."
            />
          )}
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Agent log</CardTitle>
              <CardDescription>
                {logSummary.total} events · {logSummary.successCount} success ·{" "}
                {logSummary.failedCount} failed
              </CardDescription>
            </CardHeader>
            <CardContent>
              {logs && logs.length > 0 ? (
                <div className="overflow-x-auto">
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
                      {logs.map((entry) => (
                        <tr key={entry.id} className="border-t border-white/5">
                          <td className="py-1.5">{entry.agent}</td>
                          <td
                            className={
                              entry.status === "FAILED"
                                ? "text-red-300"
                                : "text-emerald-300"
                            }
                          >
                            {entry.status}
                          </td>
                          <td className="text-right tabular-nums">
                            {entry.durationMs} ms
                          </td>
                          <td className="pl-4 text-red-200/90 text-xs">
                            {entry.errorMessage ?? ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-sm text-white/60">No logs yet.</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
