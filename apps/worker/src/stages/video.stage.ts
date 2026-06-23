import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { runAgent } from "../clients/aiClient";
import { fileExists, loadFinalVideoPath, loadVideoMeta } from "../cache/cache-resume";
import { pLimit } from "../lib/concurrency";
import { downloadClip } from "../media/clipDownload";
import { prepareSceneClip } from "../media/clipPrep";
import { composeFinalVideo } from "../media/compose";
import { generateSrtFromWords } from "../media/subtitles";
import { uploadFileToS3 } from "../lib/s3";
import {
  completeStage,
  createStageErrorHandler,
  getNarration,
  getRun,
  getScript,
  getTimestamp,
  getTopic,
  getVideoSelection,
  getVoice,
  isEnglishLanguage,
  setCurrentAgent,
  startStage,
  TARGET_HEIGHT,
  TARGET_WIDTH,
  withAgentLog,
} from "./helpers";
import type { PipelineStage, SelectedClipOut, VideoMetaOutput } from "./types";

const STAGE = "VIDEO" as const;
const AGENT = "video_meta";

export const videoStage: PipelineStage = {
  name: STAGE,
  async execute(context) {
    await startStage(context, STAGE, AGENT);

    const cachedFinalVideoPath = await loadFinalVideoPath(context.runId);
    if (cachedFinalVideoPath) {
      context.cache.finalVideoPath = cachedFinalVideoPath;
      const meta = await loadVideoMeta(context.runId);
      if (meta) {
        context.cache.videoMeta = meta;
      }
      await completeStage(context, STAGE, AGENT, { cached: true });
      return { success: true, data: { videoPath: cachedFinalVideoPath, meta } };
    }

    const run = await getRun(context);
    const topic = await getTopic(context);
    const script = await getScript(context);
    const voice = await getVoice(context);
    const timestamp = await getTimestamp(context);
    const selection = await getVideoSelection(context);
    const narration = await getNarration(context);

    const tempDir = path.join(env.STORAGE_PATH, "temp", context.runId);
    const videoDir = path.join(env.STORAGE_PATH, "videos");
    await mkdir(tempDir, { recursive: true });
    await mkdir(videoDir, { recursive: true });

    const videoPath = path.join(videoDir, `${context.runId}.mp4`);
    const metaInput = {
      title: topic.title,
      angle: topic.angle,
      script_body: script.body,
      language_code: run.languageCode,
    };

    const cachedMeta = await loadVideoMeta(context.runId);
    const downloadLimit = pLimit(context.config.VIDEO_DOWNLOAD_CONCURRENCY);
    const prepLimit = pLimit(context.config.CLIP_PREP_CONCURRENCY);
    const sortedScenes = [...selection.scenes].sort((left, right) => left.index - right.index);

    async function processScene(scene: SelectedClipOut): Promise<string> {
      const sceneDuration = scene.end - scene.start;
      const srcPath = path.join(tempDir, `src_${scene.index}.mp4`);
      const outPath = path.join(tempDir, `scene_${scene.index}.mp4`);
      let sourcePath: string | null = null;

      if (scene.clip_url) {
        if (await fileExists(srcPath)) {
          sourcePath = srcPath;
        } else {
          try {
            await downloadLimit(() => downloadClip(scene.clip_url as string, srcPath));
            sourcePath = srcPath;
            await context.prisma.scene.update({
              where: { runId_index: { runId: context.runId, index: scene.index } },
              data: { clipPath: srcPath },
            });
          } catch (error) {
            context.logger.error(
              { stage: STAGE, runId: context.runId, scene: scene.index, err: error },
              "Clip download failed, using placeholder",
            );
          }
        }
      }

      if (await fileExists(outPath)) {
        return outPath;
      }

      await prepLimit(() =>
        prepareSceneClip({
          sourcePath,
          outputPath: outPath,
          durationSec: sceneDuration,
          width: TARGET_WIDTH,
          height: TARGET_HEIGHT,
          sourceDurationSec: scene.clip_duration_sec ?? undefined,
        }),
      );

      return outPath;
    }

    await setCurrentAgent(context, "clip_pipeline");
    const metaPromise: Promise<VideoMetaOutput> = cachedMeta
      ? Promise.resolve(cachedMeta)
      : withAgentLog(context.prisma, context.runId, AGENT, metaInput, () =>
          runAgent<typeof metaInput, VideoMetaOutput>(AGENT, metaInput, {
            runId: context.runId,
          }),
        );

    const [meta, sceneClipPaths] = await Promise.all([
      metaPromise,
      Promise.all(sortedScenes.map(processScene)),
    ]);

    let subtitlePath = "";
    if (
      context.cache.features.enableSubtitles &&
      isEnglishLanguage(run.languageCode) &&
      timestamp.words.length > 0
    ) {
      subtitlePath = path.join(tempDir, "subs.srt");
      await generateSrtFromWords({
        words: timestamp.words,
        outputPath: subtitlePath,
        transcriptText: narration,
      });
    }

    await setCurrentAgent(context, "ffmpeg_compose");
    await composeFinalVideo({
      sceneClipPaths,
      audioPath: voice.audio_path,
      subtitlePath,
      outputPath: videoPath,
      tempDir,
      runId: context.runId,
    });

    let finalVideoPath = videoPath;
    if (env.APP_S3_BUCKET) {
      try {
        context.logger.info({ stage: STAGE, runId: context.runId }, "Uploading final video to S3...");
        const s3Key = `videos/${context.runId}.mp4`;
        finalVideoPath = await uploadFileToS3(videoPath, s3Key);
        context.logger.info({ stage: STAGE, runId: context.runId, s3Url: finalVideoPath }, "S3 upload complete");
      } catch (error) {
        context.logger.error({ stage: STAGE, runId: context.runId, err: error }, "Failed to upload video to S3");
      }
    }

    await context.prisma.video.upsert({
      where: { runId: context.runId },
      create: {
        runId: context.runId,
        videoPath: finalVideoPath,
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
      },
      update: {
        videoPath: finalVideoPath,
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
      },
    });

    context.cache.videoMeta = meta;
    context.cache.finalVideoPath = finalVideoPath;
    await completeStage(context, STAGE, AGENT, {
      sceneCount: sceneClipPaths.length,
      metaCached: Boolean(cachedMeta),
      subtitleEnabled: Boolean(subtitlePath),
      videoPath: finalVideoPath,
    });
    return { success: true, data: { videoPath: finalVideoPath, meta } };
  },
  onError: createStageErrorHandler(STAGE, AGENT),
};
