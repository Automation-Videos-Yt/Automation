import { prisma } from "../db/prisma";
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
    { views: snapshot.views, ctr: snapshot.ctr, avp: snapshot.avgViewPercentage },
    "analytics snapshot persisted"
  );
  publishRunEvent(runId, "analytics", { views: snapshot.views, ctr: snapshot.ctr });

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
      { runId }
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
  if (run.script?.hook) {
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
