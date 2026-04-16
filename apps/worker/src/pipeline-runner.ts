import path from "node:path";
import { mkdir } from "node:fs/promises";
import { prisma } from "./db/prisma";
import { env } from "./config/env";
import { runAgent } from "./clients/aiClient";
import { generateSrtFromWords } from "./media/subtitles";
import { downloadClip } from "./media/clipDownload";
import { prepareSceneClip } from "./media/clipPrep";
import { composeFinalVideo } from "./media/compose";
import {
  embedTopicForDedup,
  findDuplicateTopic,
  retrievePastHooks,
  retrievePastTopics,
} from "./memory/vectorStore";
import {
  fileExists,
  loadFinalVideoPath,
  loadHook,
  loadPrediction,
  loadScript,
  loadTimestamp,
  loadTopic,
  loadVideoMeta,
  loadVideoSelection,
  loadVoice,
} from "./cache/cache-resume";
import { pLimit } from "./lib/concurrency";
import { publishRunEvent } from "./events/publisher";
import { scoped } from "./lib/logger";
import { videoQueue } from "./queues/videoQueue";
import { enqueueAutoUploadForRun } from "./upload/auto-upload";

// Portrait 9:16 (YouTube Shorts / TikTok / Reels).
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const TARGET_ORIENTATION = "portrait";

type TopicOutput = {
  title: string;
  angle: string;
  rationale: string;
  trend_score: number;
};

type ScriptOutput = {
  hook: string;
  body: string;
  cta: string;
  word_count: number;
  duration_estimate_sec: number;
};

type HookVariantOut = { text: string; score: number; reasoning: string };
type HookOutput = {
  variants: HookVariantOut[];
  chosen_index: number;
  chosen_text: string;
};

type VoiceOutput = {
  audio_path: string;
  duration_sec: number;
  voice_id: string;
};

type WordSpanOut = { word: string; start: number; end: number };
type SceneSpanOut = { index: number; start: number; end: number; text: string };
type TimestampOutput = {
  total_duration_sec: number;
  words: WordSpanOut[];
  scenes: SceneSpanOut[];
};

type SelectedClipOut = {
  index: number;
  start: number;
  end: number;
  text: string;
  query: string;
  clip_url: string | null;
  clip_source: string | null;
  clip_duration_sec: number | null;
  provider_id: string | null;
};
type VideoSelectionOutput = { scenes: SelectedClipOut[] };

type VideoMetaOutput = {
  title: string;
  description: string;
  tags: string[];
};

type PredictionOutput = {
  predicted_ctr: number;
  predicted_retention: number;
  score: number;
  reasoning: string;
};

type ThumbnailOutput = {
  image_path: string;
  prompt: string;
  width: number;
  height: number;
  quality: string;
};

// Thumbnail tiers driven by prediction score. Cost-optimised to keep every
// tier well under its budget; "high" is reserved for a future ELITE tier.
//   strong:  1536x1024 medium (~$0.07)
//   mid:     1024x1024 medium (~$0.04)
//   weak:    1024x1024 low    (~$0.02)
function thumbnailTierFromScore(score: number): {
  size: string;
  quality: "low" | "medium" | "high";
} {
  if (score >= 7.5) return { size: "1536x1024", quality: "medium" };
  if (score >= 5) return { size: "1024x1024", quality: "medium" };
  return { size: "1024x1024", quality: "low" };
}

// Voice tier from prediction score.
//   score >= 7.5 → "premium" (OpenAI tts-1-hd, ~$0.033 / 1k chars)
//   otherwise    → "economy" (OpenAI tts-1,    ~$0.015 / 1k chars)
// ElevenLabs "elite" is not auto-selected — it's opt-in via direct agent call.
function voiceTierFromScore(score: number): "elite" | "premium" | "economy" {
  return score >= 7.5 ? "premium" : "economy";
}

type SeedHookVariantRunsInput = {
  parentRunId: string;
  experimentId: string;
  niche: string;
  languageCode: string;
  targetDurationSec: number;
  topic: TopicOutput;
  topicEmbedding: number[];
  scriptBody: string;
  scriptCta: string;
  scriptWordCount: number;
  scriptDurationEstimateSec: number;
  variants: HookVariantOut[];
  chosenIndex: number;
};

async function maybeSeedHookVariantRuns(
  input: SeedHookVariantRunsInput,
): Promise<string[]> {
  if (!env.ENABLE_HOOK_AB_TESTING) return [];

  const targetVariants = Math.min(env.HOOK_AB_VARIANTS, input.variants.length);
  if (targetVariants < 2) return [];

  const existingSeedLog = await prisma.agentLog.findFirst({
    where: {
      runId: input.parentRunId,
      agent: "hook_ab_seed",
      status: "SUCCESS",
    },
    orderBy: { createdAt: "desc" },
  });
  if (existingSeedLog?.outputJson) {
    const parsed = existingSeedLog.outputJson as { childRunIds?: string[] };
    if (Array.isArray(parsed.childRunIds) && parsed.childRunIds.length > 0) {
      return parsed.childRunIds;
    }
  }

  const seedInput = {
    targetVariants,
    chosenIndex: input.chosenIndex,
    variants: input.variants.map((v, i) => ({
      index: i,
      text: v.text,
      score: v.score,
    })),
  };

  const started = Date.now();
  try {
    const indicesToSpawn = input.variants
      .map((_, i) => i)
      .filter((i) => i !== input.chosenIndex)
      .slice(0, targetVariants - 1);

    const childRunIds: string[] = [];
    for (const variantIndex of indicesToSpawn) {
      const variant = input.variants[variantIndex];

      const childRun = await prisma.$transaction(async (tx) => {
        const child = await tx.pipelineRun.create({
          data: {
            experimentId: input.experimentId,
            niche: input.niche,
            languageCode: input.languageCode,
            targetDurationSec: input.targetDurationSec,
            stage: "QUEUED",
            status: "QUEUED",
            currentAgent: null,
          },
        });

        await tx.topic.create({
          data: {
            runId: child.id,
            title: input.topic.title,
            angle: input.topic.angle,
            rationale: input.topic.rationale,
            trendScore: input.topic.trend_score,
            titleEmbedding: input.topicEmbedding,
          },
        });

        await tx.script.create({
          data: {
            runId: child.id,
            hook: variant.text,
            body: input.scriptBody,
            cta: input.scriptCta,
            wordCount: input.scriptWordCount,
            durationEstimateSec: input.scriptDurationEstimateSec,
          },
        });

        await tx.hookVariant.create({
          data: {
            runId: child.id,
            index: 0,
            text: variant.text,
            score: variant.score,
            reasoning: variant.reasoning,
            chosen: true,
          },
        });

        return child;
      });

      await videoQueue.add(
        "run-pipeline",
        { runId: childRun.id },
        {
          jobId: childRun.id,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 200 },
        },
      );

      childRunIds.push(childRun.id);
    }

    await prisma.agentLog.create({
      data: {
        runId: input.parentRunId,
        agent: "hook_ab_seed",
        inputJson: seedInput,
        outputJson: { childRunIds },
        durationMs: Date.now() - started,
        status: "SUCCESS",
      },
    });

    return childRunIds;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.agentLog.create({
      data: {
        runId: input.parentRunId,
        agent: "hook_ab_seed",
        inputJson: seedInput,
        outputJson: undefined,
        durationMs: Date.now() - started,
        status: "FAILED",
        errorMessage: message,
      },
    });
    throw err;
  }
}

async function withAgentLog<T>(
  runId: string,
  agent: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const output = await fn();
    await prisma.agentLog.create({
      data: {
        runId,
        agent,
        inputJson: input as object,
        outputJson: output as object,
        durationMs: Date.now() - started,
        status: "SUCCESS",
      },
    });
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.agentLog.create({
      data: {
        runId,
        agent,
        inputJson: input as object,
        outputJson: undefined,
        durationMs: Date.now() - started,
        status: "FAILED",
        errorMessage: message,
      },
    });
    throw err;
  }
}

export async function runPipeline(runId: string): Promise<void> {
  const log = scoped("pipeline", runId);
  const run = await prisma.pipelineRun.findUnique({ where: { id: runId } });
  if (!run) {
    log.error("run not found in db");
    throw new Error(`run ${runId} not found`);
  }
  const experimentId = run.experimentId ?? run.id;

  log.info(
    { niche: run.niche, languageCode: run.languageCode },
    "pipeline start",
  );
  const pipelineStart = Date.now();

  await prisma.pipelineRun.update({
    where: { id: runId },
    data: { status: "RUNNING", errorMessage: null, experimentId },
  });
  publishRunEvent(runId, "stage", { stage: "QUEUED", status: "RUNNING" });

  // Single-line helper — every stage transition goes through this so the
  // frontend can react instantly to live changes via SSE.
  async function advanceStage(stage: string, agent: string | null) {
    await prisma.pipelineRun.update({
      where: { id: runId },
      data: { stage: stage as never, currentAgent: agent },
    });
    publishRunEvent(runId, "stage", { stage, agent });
  }

  try {
    // ============================================================
    // Stage 1: TOPIC  (cache: Topic row)
    // ============================================================
    const stageT0 = Date.now();
    await advanceStage("TOPIC", "topic");
    // pastTopics is also used by PREDICTION — compute once, reuse.
    const pastTopics = await retrievePastTopics(run.niche, 3);

    let topic: TopicOutput;
    const cachedTopic = await loadTopic(runId);
    if (cachedTopic) {
      topic = cachedTopic;
      log.info("stage=TOPIC skipped (cached)");
    } else {
      log.info("stage=TOPIC start");
      if (pastTopics.length > 0) {
        log.info(
          { count: pastTopics.length },
          "topic stage augmented with past memory",
        );
      }

      // Duplicate-topic retry loop: generate a topic, check if it's too close
      // to an existing one, and if so regenerate with an explicit exclude list.
      // Cap retries so a pathologically-similar niche still finishes.
      const MAX_TOPIC_ATTEMPTS = 3;
      const excludeTitles: string[] = [];
      let topicEmbedding: number[] = [];
      let generated: TopicOutput | null = null;

      for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
        const topicInput = {
          niche: run.niche,
          language_code: run.languageCode,
          past_topics: pastTopics,
          exclude_titles: excludeTitles,
        };
        generated = await withAgentLog(
          runId,
          excludeTitles.length > 0 ? `topic.retry${attempt - 1}` : "topic",
          topicInput,
          () =>
            runAgent<typeof topicInput, TopicOutput>("topic", topicInput, {
              runId,
            }),
        );
        topicEmbedding = await embedTopicForDedup(
          generated.title,
          generated.angle,
        );
        const dup = await findDuplicateTopic(
          generated.title,
          generated.angle,
          runId,
        );
        if (!dup) break;
        log.warn(
          {
            attempt,
            duplicateOf: dup.title,
            similarity: dup.similarity.toFixed(3),
          },
          "topic too close to a past run — retrying with exclusion",
        );
        excludeTitles.push(generated.title, dup.title);
        if (attempt === MAX_TOPIC_ATTEMPTS) {
          log.warn(
            "max topic retries reached — accepting last generated topic",
          );
        }
      }
      topic = generated!;

      await prisma.topic.create({
        data: {
          runId,
          title: topic.title,
          angle: topic.angle,
          rationale: topic.rationale,
          trendScore: topic.trend_score,
          titleEmbedding: topicEmbedding,
        },
      });
      log.info(
        {
          title: topic.title,
          retriedFrom: excludeTitles.length / 2,
          stageMs: Date.now() - stageT0,
        },
        "stage=TOPIC done",
      );
    }

    // ============================================================
    // Stage 2: SCRIPT  (cache: Script row)
    // ============================================================
    const stageS0 = Date.now();
    await advanceStage("SCRIPT", "script");
    let script: ScriptOutput;
    const cachedScript = await loadScript(runId);
    if (cachedScript) {
      script = cachedScript;
      log.info("stage=SCRIPT skipped (cached)");
    } else {
      log.info("stage=SCRIPT start");
      const scriptInput = {
        topic_title: topic.title,
        topic_angle: topic.angle,
        target_duration_sec: run.targetDurationSec,
        language_code: run.languageCode,
      };
      script = await withAgentLog(runId, "script", scriptInput, () =>
        runAgent<typeof scriptInput, ScriptOutput>("script", scriptInput, {
          runId,
        }),
      );
      await prisma.script.create({
        data: {
          runId,
          hook: script.hook,
          body: script.body,
          cta: script.cta,
          wordCount: script.word_count,
          durationEstimateSec: script.duration_estimate_sec,
        },
      });
      log.info(
        {
          words: script.word_count,
          estSec: script.duration_estimate_sec,
          stageMs: Date.now() - stageS0,
        },
        "stage=SCRIPT done",
      );
    }

    // ============================================================
    // Stage 3: HOOK  (cache: HookVariant rows)
    // ============================================================
    const stageH0 = Date.now();
    await advanceStage("HOOK", "hook");
    let hookVariantsForExperiment: HookVariantOut[] = [];
    let chosenHookIndex = 0;
    const cachedHook = await loadHook(runId);
    if (cachedHook) {
      script.hook = cachedHook.chosen_text;
      hookVariantsForExperiment = cachedHook.variants;
      chosenHookIndex = cachedHook.chosen_index;
      log.info(
        { chosen: cachedHook.chosen_text },
        "stage=HOOK skipped (cached)",
      );
    } else {
      log.info("stage=HOOK start");
      const pastHooks = await retrievePastHooks(topic.title, topic.angle, 3);
      if (pastHooks.length > 0) {
        log.info(
          { count: pastHooks.length },
          "hook stage augmented with past memory",
        );
      }
      const hookInput = {
        topic_title: topic.title,
        topic_angle: topic.angle,
        script_body: script.body,
        original_hook: script.hook,
        language_code: run.languageCode,
        variants: env.ENABLE_HOOK_AB_TESTING ? env.HOOK_AB_VARIANTS : 3,
        past_hooks: pastHooks,
      };
      const hookRes = await withAgentLog(runId, "hook", hookInput, () =>
        runAgent<typeof hookInput, HookOutput>("hook", hookInput, { runId }),
      );

      await prisma.hookVariant.createMany({
        data: hookRes.variants.map((v, i) => ({
          runId,
          index: i,
          text: v.text,
          score: v.score,
          reasoning: v.reasoning,
          chosen: i === hookRes.chosen_index,
        })),
      });
      const chosenHook = hookRes.chosen_text;
      await prisma.script.update({
        where: { runId },
        data: { hook: chosenHook },
      });
      hookVariantsForExperiment = hookRes.variants;
      chosenHookIndex = hookRes.chosen_index;
      script.hook = chosenHook;
      log.info(
        {
          chosenIdx: hookRes.chosen_index,
          chosenHook,
          stageMs: Date.now() - stageH0,
        },
        "stage=HOOK done",
      );
    }

    if (env.ENABLE_HOOK_AB_TESTING && hookVariantsForExperiment.length > 1) {
      const persistedTopic = await prisma.topic.findUnique({
        where: { runId },
        select: { titleEmbedding: true },
      });
      const childRunIds = await maybeSeedHookVariantRuns({
        parentRunId: runId,
        experimentId,
        niche: run.niche,
        languageCode: run.languageCode,
        targetDurationSec: run.targetDurationSec,
        topic,
        topicEmbedding: persistedTopic?.titleEmbedding ?? [],
        scriptBody: script.body,
        scriptCta: script.cta,
        scriptWordCount: script.word_count,
        scriptDurationEstimateSec: script.duration_estimate_sec,
        variants: hookVariantsForExperiment,
        chosenIndex: chosenHookIndex,
      });
      if (childRunIds.length > 0) {
        log.info(
          { childRunIds, variants: hookVariantsForExperiment.length },
          "hook A/B variants seeded",
        );
      }
    }

    // ============================================================
    // Stage 3.5: PREDICTION  (cache: PerformancePrediction row)
    // ============================================================
    const stageP0 = Date.now();
    await advanceStage("PREDICTION", "prediction");
    let prediction: PredictionOutput;
    const cachedPrediction = await loadPrediction(runId);
    if (cachedPrediction) {
      prediction = cachedPrediction;
      log.info("stage=PREDICTION skipped (cached)");
    } else {
      log.info("stage=PREDICTION start");
      const predictionInput = {
        niche: run.niche,
        topic_title: topic.title,
        topic_angle: topic.angle,
        script_hook: script.hook,
        script_body: script.body,
        past_performance: pastTopics.map((t) => ({
          topic_title: t.topic_title,
          hook_text: null,
          ctr: t.ctr,
          avg_view_pct: t.avg_view_pct,
        })),
      };
      try {
        prediction = await withAgentLog(
          runId,
          "prediction",
          predictionInput,
          () =>
            runAgent<typeof predictionInput, PredictionOutput>(
              "prediction",
              predictionInput,
              { runId },
            ),
        );
        await prisma.performancePrediction.upsert({
          where: { runId },
          create: {
            runId,
            predictedCtr: prediction.predicted_ctr,
            predictedRetention: prediction.predicted_retention,
            score: prediction.score,
            reasoning: prediction.reasoning,
          },
          update: {
            predictedCtr: prediction.predicted_ctr,
            predictedRetention: prediction.predicted_retention,
            score: prediction.score,
            reasoning: prediction.reasoning,
          },
        });
        log.info(
          {
            score: prediction.score,
            ctr: prediction.predicted_ctr,
            retention: prediction.predicted_retention,
            stageMs: Date.now() - stageP0,
          },
          "stage=PREDICTION done",
        );
      } catch (err) {
        // Prediction is advisory, not gate-blocking. Default to neutral score so
        // downstream routing (voice tier, thumbnail tier) has a value to read.
        // NOTE: not persisted so retries can try again.
        log.error(
          { err, stageMs: Date.now() - stageP0 },
          "stage=PREDICTION failed — using neutral default score=5",
        );
        prediction = {
          predicted_ctr: 3,
          predicted_retention: 40,
          score: 5,
          reasoning: "prediction unavailable — neutral default",
        };
      }
    }

    // ============================================================
    // Stage 4: VOICE  (cache: VoiceAsset row + mp3 file on disk)
    // ============================================================
    const stageV0 = Date.now();
    await advanceStage("VOICE", "voice");
    const narration = [script.hook, script.body, script.cta]
      .filter(Boolean)
      .join(" ");
    let voice: VoiceOutput;
    const cachedVoice = await loadVoice(runId);
    if (cachedVoice) {
      voice = cachedVoice;
      log.info("stage=VOICE skipped (cached)");
    } else {
      log.info("stage=VOICE start");
      const audioDir = path.join(env.STORAGE_PATH, "audio");
      await mkdir(audioDir, { recursive: true });
      const audioPath = path.join(audioDir, `${runId}.mp3`);
      const voiceTier = voiceTierFromScore(prediction.score);
      log.info(
        { score: prediction.score, tier: voiceTier },
        "voice tier selected from prediction",
      );
      const voiceInput = {
        text: narration,
        output_path: audioPath,
        tier: voiceTier,
        language_code: run.languageCode,
      };
      voice = await withAgentLog(runId, "voice", voiceInput, () =>
        runAgent<typeof voiceInput, VoiceOutput>("voice", voiceInput, {
          runId,
        }),
      );
      await prisma.voiceAsset.create({
        data: {
          runId,
          audioPath: voice.audio_path,
          durationSec: voice.duration_sec,
          voiceId: voice.voice_id,
        },
      });
      log.info(
        { durationSec: voice.duration_sec, stageMs: Date.now() - stageV0 },
        "stage=VOICE done",
      );
    }

    // ============================================================
    // Stage 5: TIMESTAMP  (cache: AgentLog where agent=timestamp, SUCCESS)
    // ============================================================
    const stageA0 = Date.now();
    await advanceStage("TIMESTAMP", "timestamp");
    let ts: TimestampOutput;
    const cachedTs = await loadTimestamp(runId);
    if (cachedTs) {
      ts = cachedTs;
      log.info("stage=TIMESTAMP skipped (cached)");
    } else {
      log.info("stage=TIMESTAMP start");
      // Keep a usable number of scenes on short videos — forcing 7.5s chunks on
      // a 15s video would give only 2 scenes which feels static.
      const targetSceneSec = run.targetDurationSec < 30 ? 4 : 7.5;
      const tsInput = {
        audio_path: voice.audio_path,
        script_text: narration,
        target_scene_sec: targetSceneSec,
      };
      ts = await withAgentLog(runId, "timestamp", tsInput, () =>
        runAgent<typeof tsInput, TimestampOutput>("timestamp", tsInput, {
          runId,
        }),
      );
      log.info(
        {
          scenes: ts.scenes.length,
          words: ts.words.length,
          total: ts.total_duration_sec,
          stageMs: Date.now() - stageA0,
        },
        "stage=TIMESTAMP done",
      );
    }

    // ============================================================
    // Stage 6: VIDEO_SELECTION  (cache: Scene rows)
    // ============================================================
    const stageX0 = Date.now();
    await advanceStage("VIDEO_SELECTION", "video_selection");
    let vs: VideoSelectionOutput;
    const cachedVs = await loadVideoSelection(runId);
    if (cachedVs) {
      vs = cachedVs;
      log.info("stage=VIDEO_SELECTION skipped (cached)");
    } else {
      log.info("stage=VIDEO_SELECTION start");
      const vsInput = {
        topic_title: topic.title,
        topic_angle: topic.angle,
        scenes: ts.scenes,
        orientation: TARGET_ORIENTATION,
      };
      vs = await withAgentLog(runId, "video_selection", vsInput, () =>
        runAgent<typeof vsInput, VideoSelectionOutput>(
          "video_selection",
          vsInput,
          { runId },
        ),
      );

      await prisma.scene.createMany({
        data: vs.scenes.map((s) => ({
          runId,
          index: s.index,
          startSec: s.start,
          endSec: s.end,
          text: s.text,
          query: s.query,
          clipUrl: s.clip_url ?? undefined,
          clipSource: s.clip_source ?? undefined,
          clipDurationSec: s.clip_duration_sec ?? undefined,
        })),
      });
      log.info(
        {
          scenes: vs.scenes.length,
          hits: vs.scenes.filter((s) => s.clip_url).length,
          stageMs: Date.now() - stageX0,
        },
        "stage=VIDEO_SELECTION done",
      );
    }

    // ============================================================
    // Stage 7: VIDEO (download clips, prep, compose, SEO meta)
    // ============================================================
    log.info("stage=VIDEO start");
    const stageR0 = Date.now();
    await advanceStage("VIDEO", "video_meta");

    const tempDir = path.join(env.STORAGE_PATH, "temp", runId);
    const videoDir = path.join(env.STORAGE_PATH, "videos");
    await mkdir(tempDir, { recursive: true });
    await mkdir(videoDir, { recursive: true });

    const videoPath = path.join(videoDir, `${runId}.mp4`);
    const finalCached = await loadFinalVideoPath(runId);

    if (finalCached) {
      // Whole VIDEO stage (meta + clip pipeline + compose) already done.
      log.info("stage=VIDEO skipped (final render cached)");
    } else {
      const metaInput = {
        title: topic.title,
        angle: topic.angle,
        script_body: script.body,
        language_code: run.languageCode,
      };

      // Per-scene: download (I/O) then prep (ffmpeg, CPU). Downloads can run at
      // high concurrency; ffmpeg prep is CPU-bound so we cap it separately.
      // Each sub-step skips automatically if its output file already exists.
      const downloadLimit = pLimit(6);
      const prepLimit = pLimit(2);
      const sortedScenes = [...vs.scenes].sort((a, b) => a.index - b.index);

      async function processScene(scene: SelectedClipOut): Promise<string> {
        const sceneDur = scene.end - scene.start;
        const srcPath = path.join(tempDir, `src_${scene.index}.mp4`);
        const outPath = path.join(tempDir, `scene_${scene.index}.mp4`);
        let sourcePath: string | null = null;

        if (scene.clip_url) {
          if (await fileExists(srcPath)) {
            log.debug({ scene: scene.index }, "clip download cache HIT");
            sourcePath = srcPath;
          } else {
            try {
              await downloadLimit(() =>
                downloadClip(scene.clip_url as string, srcPath),
              );
              sourcePath = srcPath;
              await prisma.scene.update({
                where: { runId_index: { runId, index: scene.index } },
                data: { clipPath: srcPath },
              });
            } catch (err) {
              log.error(
                { err, scene: scene.index },
                "clip download failed — using placeholder",
              );
            }
          }
        }

        if (await fileExists(outPath)) {
          log.debug({ scene: scene.index }, "scene prep cache HIT");
          return outPath;
        }
        await prepLimit(() =>
          prepareSceneClip({
            sourcePath,
            outputPath: outPath,
            durationSec: sceneDur,
            width: TARGET_WIDTH,
            height: TARGET_HEIGHT,
            sourceDurationSec: scene.clip_duration_sec ?? undefined,
          }),
        );
        return outPath;
      }

      await prisma.pipelineRun.update({
        where: { id: runId },
        data: { currentAgent: "clip_pipeline" },
      });

      // meta: reuse cached row if available; otherwise run concurrently with scenes.
      const cachedMeta = await loadVideoMeta(runId);
      const metaPromise: Promise<VideoMetaOutput> = cachedMeta
        ? Promise.resolve(cachedMeta)
        : withAgentLog(runId, "video_meta", metaInput, () =>
            runAgent<typeof metaInput, VideoMetaOutput>(
              "video_meta",
              metaInput,
              { runId },
            ),
          );

      const [meta, sceneClipPaths] = await Promise.all([
        metaPromise,
        Promise.all(sortedScenes.map(processScene)),
      ]);
      log.info(
        {
          scenes: sceneClipPaths.length,
          metaCached: !!cachedMeta,
        },
        "scene pipeline + meta ready",
      );

      // Subtitles regenerate cheaply — just rewrite the SRT.
      const srtPath = path.join(tempDir, "subs.srt");
      await generateSrtFromWords({
        words: ts.words,
        outputPath: srtPath,
        wordsPerCue: 5,
      });
      log.debug({ srtPath, words: ts.words.length }, "subtitles written");

      await prisma.pipelineRun.update({
        where: { id: runId },
        data: { currentAgent: "ffmpeg_compose" },
      });

      await composeFinalVideo({
        sceneClipPaths,
        audioPath: voice.audio_path,
        subtitlePath: srtPath,
        outputPath: videoPath,
        tempDir,
        runId,
      });

      await prisma.video.upsert({
        where: { runId },
        create: {
          runId,
          videoPath,
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
        },
        update: {
          videoPath,
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
        },
      });
      log.info(
        { videoPath, stageMs: Date.now() - stageR0 },
        "stage=VIDEO done",
      );
    }

    // ============================================================
    // Stage 8: THUMBNAIL (gpt-image-1 16:9 tile) — feature-flagged
    // ============================================================
    if (!env.ENABLE_THUMBNAIL_AGENT) {
      log.info("stage=THUMBNAIL skipped (ENABLE_THUMBNAIL_AGENT=false)");
    } else {
      const stageT8 = Date.now();
      await advanceStage("THUMBNAIL", "thumbnail");

      const thumbDir = path.join(env.STORAGE_PATH, "thumbnails");
      await mkdir(thumbDir, { recursive: true });
      const thumbPath = path.join(thumbDir, `${runId}.png`);

      if (await fileExists(thumbPath)) {
        log.info("stage=THUMBNAIL skipped (file cached)");
        // Make sure DB points at the cached file.
        await prisma.video.update({
          where: { runId },
          data: { thumbnailPath: thumbPath },
        });
      } else {
        log.info("stage=THUMBNAIL start");
        const tier = thumbnailTierFromScore(prediction.score);
        log.info(
          { score: prediction.score, tier: tier.quality, size: tier.size },
          "thumbnail tier selected from prediction",
        );
        const thumbInput = {
          topic_title: topic.title,
          topic_angle: topic.angle,
          script_hook: script.hook,
          output_path: thumbPath,
          size: tier.size,
          quality: tier.quality,
        };
        try {
          const thumb = await withAgentLog(runId, "thumbnail", thumbInput, () =>
            runAgent<typeof thumbInput, ThumbnailOutput>(
              "thumbnail",
              thumbInput,
              { runId },
            ),
          );
          await prisma.video.update({
            where: { runId },
            data: { thumbnailPath: thumb.image_path },
          });
          log.info(
            { thumbPath: thumb.image_path, stageMs: Date.now() - stageT8 },
            "stage=THUMBNAIL done",
          );
        } catch (err) {
          log.error(
            { err, stageMs: Date.now() - stageT8 },
            "stage=THUMBNAIL failed — continuing without thumbnail",
          );
        }
      }
    }

    await prisma.pipelineRun.update({
      where: { id: runId },
      data: { stage: "DONE", status: "COMPLETED", currentAgent: null },
    });
    publishRunEvent(runId, "stage", { stage: "DONE", status: "COMPLETED" });

    if (env.ENABLE_HOOK_AB_TESTING && env.HOOK_AB_AUTO_UPLOAD) {
      try {
        await enqueueAutoUploadForRun(runId, env.HOOK_AB_UPLOAD_PRIVACY);
      } catch (err) {
        log.error({ err }, "auto-upload enqueue failed");
      }
    }

    log.info({ totalMs: Date.now() - pipelineStart }, "pipeline complete");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err: message, totalMs: Date.now() - pipelineStart },
      "pipeline failed",
    );
    await prisma.pipelineRun.update({
      where: { id: runId },
      data: { stage: "FAILED", status: "FAILED", errorMessage: message },
    });
    publishRunEvent(runId, "stage", { stage: "FAILED", status: "FAILED" });
    throw err;
  }
}
