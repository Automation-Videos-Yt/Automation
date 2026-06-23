"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, PipelineSchedule } from "../../services/api";

const PRESET_CRON_OPTIONS = [
  { label: "Every Hour", value: "0 * * * *" },
  { label: "Every 6 Hours", value: "0 */6 * * *" },
  { label: "Every 12 Hours", value: "0 */12 * * *" },
  { label: "Daily (Midnight)", value: "0 0 * * *" },
  { label: "Weekly (Sunday)", value: "0 0 * * 0" },
];

export default function SchedulesPage() {
  const queryClient = useQueryClient();
  const [niche, setNiche] = useState("");
  const [cronExpression, setCronExpression] = useState(PRESET_CRON_OPTIONS[1].value);
  const [customCron, setCustomCron] = useState(false);

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.getSchedules(),
    refetchInterval: 10000, // Refresh every 10s
  });

  const createSchedule = useMutation({
    mutationFn: (v: { niche: string; cronExpression: string }) =>
      api.createSchedule(v.niche, v.cronExpression),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setNiche("");
    },
  });

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });

  const isPending = createSchedule.isPending;

  return (
    <div className="space-y-12 relative">
      <div className="absolute top-[-20%] right-[-10%] w-[50%] h-[50%] bg-indigo-500/10 blur-[120px] pointer-events-none rounded-full" />

      <div className="relative z-10 space-y-4">
        <h1 className="text-4xl font-bold tracking-tight text-white drop-shadow-sm">Schedules</h1>
        <p className="text-white/60 text-lg max-w-2xl leading-relaxed">
          Configure automated cron jobs to automatically run the video creation pipeline for specific niches at recurring intervals.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 relative z-10">
        <div className="lg:col-span-1 space-y-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = niche.trim();
              if (trimmed.length < 3) return;
              createSchedule.mutate({ niche: trimmed, cronExpression });
            }}
            className="space-y-6 bg-white/[0.03] backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-2xl shadow-2xl"
          >
            <h2 className="text-xl font-semibold text-white/90">Create Schedule</h2>
            
            <div className="space-y-4">
              <div>
                <label className="text-xs uppercase tracking-wider text-white/50 mb-2 block">Niche / Topic</label>
                <input
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  placeholder="e.g. stoicism quotes"
                  className="w-full rounded-xl bg-black/20 border border-white/10 px-4 py-3 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all shadow-inner text-base"
                  minLength={3}
                  maxLength={120}
                  required
                />
              </div>

              <div>
                <label className="text-xs uppercase tracking-wider text-white/50 mb-2 block">Frequency</label>
                <div className="flex flex-col gap-2">
                  {PRESET_CRON_OPTIONS.map((preset) => {
                    const active = !customCron && cronExpression === preset.value;
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => {
                          setCronExpression(preset.value);
                          setCustomCron(false);
                        }}
                        className={`text-left text-sm rounded-lg border px-4 py-3 font-medium transition-all ${
                          active
                            ? "bg-indigo-500/20 text-indigo-200 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.15)]"
                            : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        {preset.label}
                        <span className="block text-xs font-normal text-white/40 mt-0.5">{preset.value}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setCustomCron(true)}
                    className={`text-left text-sm rounded-lg border px-4 py-3 font-medium transition-all ${
                      customCron
                        ? "bg-indigo-500/20 text-indigo-200 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.15)]"
                        : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    Custom Cron
                  </button>
                </div>
              </div>

              {customCron && (
                <div>
                  <input
                    type="text"
                    value={cronExpression}
                    onChange={(e) => setCronExpression(e.target.value)}
                    placeholder="* * * * *"
                    className="w-full rounded-xl bg-black/20 border border-white/10 px-4 py-3 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all shadow-inner text-base font-mono"
                    required
                  />
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white px-6 py-3 font-semibold shadow-lg hover:shadow-indigo-500/25 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
            >
              {isPending ? "Saving..." : "Add Schedule"}
            </button>
            {createSchedule.error && (
              <p className="text-red-400 text-sm mt-2">Failed to create schedule.</p>
            )}
          </form>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white/[0.03] backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-2xl shadow-2xl min-h-[400px]">
            <h2 className="text-xl font-semibold text-white/90 mb-6">Active Schedules</h2>
            
            {isLoading ? (
              <div className="animate-pulse flex space-x-4">
                <div className="flex-1 space-y-4 py-1">
                  <div className="h-4 bg-white/10 rounded w-3/4"></div>
                  <div className="h-4 bg-white/10 rounded"></div>
                  <div className="h-4 bg-white/10 rounded w-5/6"></div>
                </div>
              </div>
            ) : schedules.length === 0 ? (
              <div className="text-white/40 text-center py-12">
                No active schedules found. Create one to get started.
              </div>
            ) : (
              <div className="space-y-4">
                {schedules.map((schedule) => (
                  <div key={schedule.id} className="group flex items-center justify-between bg-black/20 border border-white/5 p-4 rounded-xl hover:border-white/20 hover:bg-white/5 transition-all">
                    <div>
                      <div className="font-medium text-white/90 text-lg">{schedule.niche}</div>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="font-mono text-xs bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded border border-indigo-500/30">
                          {schedule.cronExpression}
                        </span>
                        <span className="text-xs text-white/40">
                          Created {new Date(schedule.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (confirm(`Are you sure you want to delete the schedule for "${schedule.niche}"?`)) {
                          deleteSchedule.mutate(schedule.id);
                        }
                      }}
                      disabled={deleteSchedule.isPending}
                      className="text-white/40 hover:text-red-400 p-2 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="Delete Schedule"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18"></path>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
