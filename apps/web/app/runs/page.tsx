"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { api, PipelineRun } from "../../services/api";

const PAGE_SIZE_OPTIONS = [10, 20, 30, 50] as const;

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

function statusVariant(status: PipelineRun["status"]) {
  if (status === "COMPLETED") return "success" as const;
  if (status === "FAILED") return "warning" as const;
  if (status === "RUNNING") return "default" as const;
  return "secondary" as const;
}

function stageTone(stage: PipelineRun["stage"], status: PipelineRun["status"]) {
  if (status === "FAILED") {
    return "border-red-300/30 bg-red-500/20 text-red-100";
  }
  if (stage === "DONE") {
    return "border-emerald-300/30 bg-emerald-500/20 text-emerald-100";
  }
  return "border-amber-300/30 bg-amber-500/20 text-amber-100";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function visiblePages(page: number, totalPages: number, span = 5): number[] {
  if (totalPages <= span) {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1);
  }

  const half = Math.floor(span / 2);
  const start = Math.max(1, Math.min(page - half, totalPages - span + 1));
  return Array.from({ length: span }, (_, idx) => start + idx);
}

export default function RunsPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["runs", page, pageSize],
    queryFn: () => api.listRunsPaged({ page, pageSize }),
    refetchInterval: 5000,
    placeholderData: (previousData) => previousData,
  });

  useEffect(() => {
    if (!data) return;
    if (data.page !== page) {
      setPage(data.page);
    }
    if (data.pageSize !== pageSize) {
      setPageSize(data.pageSize);
    }
  }, [data, page, pageSize]);

  const runs = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const activePage = data?.page ?? page;
  const activePageSize = data?.pageSize ?? pageSize;
  const pageStart = total === 0 ? 0 : (activePage - 1) * activePageSize + 1;
  const pageEnd =
    total === 0 ? 0 : Math.min(pageStart + runs.length - 1, total);

  let queued = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;

  for (const run of runs) {
    if (run.status === "QUEUED") queued += 1;
    else if (run.status === "RUNNING") running += 1;
    else if (run.status === "COMPLETED") completed += 1;
    else if (run.status === "FAILED") failed += 1;
  }

  const stats = {
    queued,
    running,
    completed,
    failed,
    live: queued + running,
  };

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-44 rounded-lg bg-white/10 animate-pulse" />
        <div className="h-36 rounded-2xl bg-white/5 animate-pulse" />
        <div className="h-24 rounded-xl bg-white/5 animate-pulse" />
        <div className="h-24 rounded-xl bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-red-300/30 bg-red-500/10">
        <CardHeader>
          <CardTitle>Could not load runs</CardTitle>
          <CardDescription className="text-red-100/80">
            {(error as Error).message}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="secondary" onClick={() => void refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const pages = visiblePages(activePage, totalPages, 5);

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.08] via-white/[0.03] to-transparent p-6">
        <div className="absolute -top-12 -right-12 h-36 w-36 rounded-full bg-white/10 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Runs</h1>
            <p className="mt-1 text-sm text-white/60">
              Review pipeline history, monitor active jobs, and jump into any
              run details.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-white/45">
              Showing
            </div>
            <div className="text-sm text-white/85">
              {pageStart}-{pageEnd} of {total}
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-white/50">
              Total runs
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {total}
            </div>
          </div>
          <div className="rounded-xl border border-indigo-300/25 bg-indigo-500/10 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-indigo-100/70">
              Live runs
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-indigo-100">
              {stats.live}
            </div>
          </div>
          <div className="rounded-xl border border-emerald-300/25 bg-emerald-500/10 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-emerald-100/70">
              Completed
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-100">
              {stats.completed}
            </div>
          </div>
          <div className="rounded-xl border border-amber-300/25 bg-amber-500/10 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-amber-100/70">
              Failed
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-amber-100">
              {stats.failed}
            </div>
          </div>
        </div>
      </section>

      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <label
              className="text-xs uppercase tracking-wide text-white/50"
              htmlFor="page-size"
            >
              Rows per page
            </label>
            <select
              id="page-size"
              value={activePageSize}
              onChange={(event) => {
                const next = Number(event.target.value);
                setPageSize(next);
                setPage(1);
              }}
              className="rounded-md border border-white/15 bg-white/10 px-2.5 py-1.5 text-sm text-white outline-none focus:border-white/30"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size} className="bg-slate-900">
                  {size}
                </option>
              ))}
            </select>

            <div className="ml-auto text-xs text-white/50">
              refreshes every 5s
            </div>
          </div>
        </CardContent>
      </Card>

      {runs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <div className="text-sm text-white/70">No runs on this page.</div>
            <div className="mt-1 text-xs text-white/45">
              Start a new run from the home screen to populate this list.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <Link key={run.id} href={`/runs/${run.id}`} className="block">
              <Card className="group transition-all hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.06]">
                <CardContent className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-base font-semibold text-white">
                          {run.niche}
                        </div>
                        <Badge variant={statusVariant(run.status)}>
                          {run.status}
                        </Badge>
                        <div
                          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${stageTone(run.stage, run.status)}`}
                        >
                          {run.stage.replace("_", " ")}
                        </div>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/55">
                        <span>{languageLabel(run.languageCode)}</span>
                        <span>{run.targetDurationSec}s target</span>
                        <span>{formatDate(run.createdAt)}</span>
                        <span className="font-mono text-[11px] text-white/40">
                          {run.id}
                        </span>
                      </div>

                      {run.status === "FAILED" && run.errorMessage && (
                        <div className="mt-2 line-clamp-2 text-xs text-red-100/85">
                          {run.errorMessage}
                        </div>
                      )}
                    </div>

                    <div className="text-xs text-white/35 group-hover:text-white/60 transition-colors">
                      View details {">"}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-white/70">
              Page {activePage} of {totalPages}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={activePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              {pages.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={p === activePage ? "default" : "outline"}
                  onClick={() => setPage(p)}
                >
                  {p}
                </Button>
              ))}
              <Button
                variant="secondary"
                size="sm"
                disabled={activePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
