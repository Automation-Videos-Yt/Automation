"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api, PipelineRun } from "../../services/api";

function stageColor(stage: PipelineRun["stage"], status: PipelineRun["status"]) {
  if (status === "FAILED") return "text-red-400";
  if (stage === "DONE") return "text-emerald-400";
  return "text-yellow-400";
}

export default function RunsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns(),
    refetchInterval: 3000,
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div className="text-red-400">{(error as Error).message}</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold">Runs</h1>
      <div className="divide-y divide-white/10 rounded-md border border-white/10 overflow-hidden">
        {data?.map((r) => (
          <Link
            key={r.id}
            href={`/runs/${r.id}`}
            className="flex items-center justify-between px-4 py-3 hover:bg-white/5"
          >
            <div>
              <div className="font-medium">{r.niche}</div>
              <div className="text-xs text-white/50">
                {new Date(r.createdAt).toLocaleString()} · {r.id}
              </div>
            </div>
            <div className={`text-sm ${stageColor(r.stage, r.status)}`}>
              {r.status} · {r.stage}
            </div>
          </Link>
        ))}
        {(!data || data.length === 0) && (
          <div className="px-4 py-6 text-white/50 text-sm">No runs yet.</div>
        )}
      </div>
    </div>
  );
}
