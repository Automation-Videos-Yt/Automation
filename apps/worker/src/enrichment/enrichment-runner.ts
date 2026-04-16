import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { runAgent } from "../clients/aiClient";
import { fetchVideoAnalytics } from "../upload/youtubeAnalytics";
import {
  maybeAdmitHookToMemory,
  maybeAdmitToMemory,
} from "../memory/vectorStore";
import { publishRunEvent } from "../events/publisher";
import { scoped } from "../lib/logger";

type FeedbackOutput = {
  what_worked: string;
  what_didnt: string;
  suggestions: string;
  performance_tag: string;
};

type HookExperimentCandidate = {
  runId: string;
  hookText: string;
  views: number;
  ctr: number | null;
  avgViewPercentage: number | null;
  watchTimeMinutes: number | null;
};

function replayRateFromAvgViewPct(avgViewPercentage: number | null): number {
  if (avgViewPercentage == null) return 0;
  return Math.max(0, avgViewPercentage - 100) / 100;
}

function hookExperimentScore(
  candidate: HookExperimentCandidate,
  maxWatchTimeMinutes: number,
): number {
  const retentionNorm = Math.max(0, (candidate.avgViewPercentage ?? 0) / 100);
  const watchNorm =
    maxWatchTimeMinutes > 0
      ? Math.max(0, (candidate.watchTimeMinutes ?? 0) / maxWatchTimeMinutes)
      : 0;
  const replayNorm = Math.min(
    1,
    replayRateFromAvgViewPct(candidate.avgViewPercentage),
  );

  return retentionNorm * 0.45 + watchNorm * 0.35 + replayNorm * 0.2;
}

async function maybeAdmitWinningHookFromExperiment(params: {
  runId: string;
  experimentId: string;
  niche: string;
  topicTitle: string;
  topicAngle: string;
  expectedVariants: number;
}): Promise<void> {
  const candidates = await prisma.pipelineRun.findMany({
    where: {
      experimentId: params.experimentId,
      upload: {
        is: {
          status: "COMPLETED",
          youtubeVideoId: { not: null },
        },
      },
    },
    include: {
      script: { select: { hook: true } },
      analytics: {
        orderBy: { snapshotAt: "desc" },
        take: 1,
        select: {
          views: true,
          ctr: true,
          avgViewPercentage: true,
          watchTimeMinutes: true,
        },
      },
    },
  });

  const normalized: HookExperimentCandidate[] = candidates.flatMap((c) => {
    const latest = c.analytics[0];
    if (!latest || !c.script?.hook) return [];
    return [
      {
        runId: c.id,
        hookText: c.script.hook,
        views: latest.views,
        ctr: latest.ctr,
        avgViewPercentage: latest.avgViewPercentage,
        watchTimeMinutes: latest.watchTimeMinutes,
      },
    ];
  });

  const uniqueHooks = new Set(
    normalized.map((n) => n.hookText.trim().toLowerCase()),
  );
  if (uniqueHooks.size < 2) return;

  if (normalized.length < params.expectedVariants) {
    return;
  }

  const maxWatchTimeMinutes = normalized.reduce(
    (max, n) => Math.max(max, n.watchTimeMinutes ?? 0),
    0,
  );

  const ranked = normalized
    .map((n) => ({
      ...n,
      replayRate: replayRateFromAvgViewPct(n.avgViewPercentage),
      score: hookExperimentScore(n, maxWatchTimeMinutes),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.avgViewPercentage ?? 0) - (a.avgViewPercentage ?? 0);
    });

  const winner = ranked[0];
  if (!winner) return;

  await maybeAdmitHookToMemory({
    runId: winner.runId,
    niche: params.niche,
    topicTitle: params.topicTitle,
    topicAngle: params.topicAngle,
    hookText: winner.hookText,
    forceAdmission: true,
    replayRate: winner.replayRate,
    metrics: {
      views: winner.views,
      ctr: winner.ctr,
      avgViewPercentage: winner.avgViewPercentage,
    },
  });

  publishRunEvent(params.runId, "memory", {
    winnerRunId: winner.runId,
    winnerHook: winner.hookText,
    comparedVariants: ranked.length,
    retention: winner.avgViewPercentage,
    watchTimeMinutes: winner.watchTimeMinutes,
    replayRate: winner.replayRate,
    score: Number(winner.score.toFixed(4)),
  });
}

export async function runEnrichment(runId: string): Promise<void> {
  const log = scoped("enrichment", runId);
  const run = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    include: {
      topic: true,
      script: true,
      video: true,
      upload: true,
      hookVariants: { orderBy: { index: "asc" } },
    },
  });
  if (!run) throw new Error(`run ${runId} not found`);
  if (!run.upload || !run.upload.youtubeVideoId) {
    log.info("skip enrichment — run is not uploaded");
    return;
  }

  const youtubeVideoId = run.upload.youtubeVideoId;
  const uploadedAt =
    run.upload.completedAt ?? run.upload.startedAt ?? run.upload.createdAt;

  log.info({ youtubeVideoId }, "enrichment start");

  // ---- 1. Analytics snapshot ----
  let snapshot;
  try {
    snapshot = await fetchVideoAnalytics(youtubeVideoId, uploadedAt);
  } catch (err) {
    log.error({ err }, "analytics fetch failed");
    throw err;
  }

  await prisma.videoAnalytics.create({
    data: {
      runId,
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
      shares: snapshot.shares,
      impressions: snapshot.impressions,
      ctr: snapshot.ctr,
      avgViewDurationSec: snapshot.avgViewDurationSec,
      avgViewPercentage: snapshot.avgViewPercentage,
      watchTimeMinutes: snapshot.watchTimeMinutes,
      subsGained: snapshot.subsGained,
    },
  });
  log.info(
    {
      views: snapshot.views,
      ctr: snapshot.ctr,
      avp: snapshot.avgViewPercentage,
    },
    "analytics snapshot persisted",
  );
  publishRunEvent(runId, "analytics", {
    views: snapshot.views,
    ctr: snapshot.ctr,
  });

  // ---- 2. Feedback agent ----
  if (!run.topic || !run.script) {
    log.warn("missing topic/script — skipping feedback");
    return;
  }

  const feedbackInput = {
    niche: run.niche,
    topic_title: run.topic.title,
    topic_angle: run.topic.angle,
    script_hook: run.script.hook,
    hook_variants: run.hookVariants.map((v) => ({
      text: v.text,
      score: v.score,
      chosen: v.chosen,
    })),
    tags: run.video?.tags ?? [],
    metrics: {
      views: snapshot.views,
      impressions: snapshot.impressions,
      ctr: snapshot.ctr,
      avg_view_duration_sec: snapshot.avgViewDurationSec,
      avg_view_percentage: snapshot.avgViewPercentage,
      watch_time_minutes: snapshot.watchTimeMinutes,
      likes: snapshot.likes,
      comments: snapshot.comments,
    },
  };

  let feedback: FeedbackOutput;
  try {
    feedback = await runAgent<typeof feedbackInput, FeedbackOutput>(
      "feedback",
      feedbackInput,
      { runId },
    );
  } catch (err) {
    log.error({ err }, "feedback agent failed");
    throw err;
  }

  await prisma.feedbackInsight.upsert({
    where: { runId },
    create: {
      runId,
      whatWorked: feedback.what_worked,
      whatDidnt: feedback.what_didnt,
      suggestions: feedback.suggestions,
      performanceTag: feedback.performance_tag,
    },
    update: {
      whatWorked: feedback.what_worked,
      whatDidnt: feedback.what_didnt,
      suggestions: feedback.suggestions,
      performanceTag: feedback.performance_tag,
    },
  });
  log.info({ tag: feedback.performance_tag }, "feedback persisted");
  publishRunEvent(runId, "feedback", { tag: feedback.performance_tag });

  // ---- 3. Maybe admit to TopicMemory + HookMemory ----
  const admissionMetrics = {
    views: snapshot.views,
    ctr: snapshot.ctr,
    avgViewPercentage: snapshot.avgViewPercentage,
  };
  await maybeAdmitToMemory({
    runId,
    niche: run.niche,
    topicTitle: run.topic.title,
    topicAngle: run.topic.angle,
    metrics: admissionMetrics,
  });

  if (env.ENABLE_HOOK_AB_TESTING) {
    await maybeAdmitWinningHookFromExperiment({
      runId,
      experimentId: run.experimentId ?? run.id,
      niche: run.niche,
      topicTitle: run.topic.title,
      topicAngle: run.topic.angle,
      expectedVariants: env.HOOK_AB_VARIANTS,
    });
  } else if (run.script?.hook) {
    await maybeAdmitHookToMemory({
      runId,
      niche: run.niche,
      topicTitle: run.topic.title,
      topicAngle: run.topic.angle,
      hookText: run.script.hook,
      metrics: admissionMetrics,
    });
  }

  log.info("enrichment complete");
}
