import { prisma } from "../db/prisma";
import { getRunCost } from "../services/cost.service";
import {
  PipelineServiceError,
  requeuePipelineRunFromStage,
  type RunControlOverrides,
  type StageResetPoint,
} from "../services/pipeline.service";

export async function getCostAgentRunCost(
  runId: string,
  forceReanalyze: boolean,
) {
  return getRunCost(runId, { forceReanalyze });
}

export async function requeueCostAgentRun(
  runId: string,
  fromStage: StageResetPoint,
  control?: RunControlOverrides,
) {
  return requeuePipelineRunFromStage(runId, fromStage, control);
}

export async function forkAndRequeueCostAgentRun(
  runId: string,
  fromStage: StageResetPoint,
  control?: RunControlOverrides,
): Promise<{ runId: string }> {
  const source = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      experimentId: true,
      niche: true,
      languageCode: true,
      targetDurationSec: true,
      topic: {
        select: {
          title: true,
          angle: true,
          rationale: true,
          trendScore: true,
          titleEmbedding: true,
        },
      },
      script: {
        select: {
          hook: true,
          body: true,
          cta: true,
          wordCount: true,
          durationEstimateSec: true,
        },
      },
      hookVariants: {
        orderBy: { index: "asc" },
        select: {
          index: true,
          text: true,
          score: true,
          reasoning: true,
          chosen: true,
        },
      },
      prediction: {
        select: {
          predictedCtr: true,
          predictedRetention: true,
          score: true,
          reasoning: true,
        },
      },
      voiceAsset: {
        select: {
          audioPath: true,
          durationSec: true,
          voiceId: true,
        },
      },
      scenes: {
        orderBy: { index: "asc" },
        select: {
          index: true,
          startSec: true,
          endSec: true,
          text: true,
          query: true,
          clipUrl: true,
          clipSource: true,
          clipPath: true,
          clipDurationSec: true,
        },
      },
      video: {
        select: {
          videoPath: true,
          thumbnailPath: true,
          title: true,
          description: true,
          tags: true,
        },
      },
    },
  });

  if (!source) {
    throw new PipelineServiceError("NOT_FOUND", "run not found");
  }

  const fork = await prisma.$transaction(async (tx) => {
    const created = await tx.pipelineRun.create({
      data: {
        niche: source.niche,
        languageCode: source.languageCode,
        targetDurationSec: source.targetDurationSec,
        experimentId: source.experimentId ?? source.id,
        stage: "DONE",
        status: "COMPLETED",
      },
    });

    if (source.topic) {
      await tx.topic.create({
        data: {
          runId: created.id,
          title: source.topic.title,
          angle: source.topic.angle,
          rationale: source.topic.rationale,
          trendScore: source.topic.trendScore,
          titleEmbedding: source.topic.titleEmbedding,
        },
      });
    }

    if (source.script) {
      await tx.script.create({
        data: {
          runId: created.id,
          hook: source.script.hook,
          body: source.script.body,
          cta: source.script.cta,
          wordCount: source.script.wordCount,
          durationEstimateSec: source.script.durationEstimateSec,
        },
      });
    }

    if (source.hookVariants.length > 0) {
      await tx.hookVariant.createMany({
        data: source.hookVariants.map((variant) => ({
          runId: created.id,
          index: variant.index,
          text: variant.text,
          score: variant.score,
          reasoning: variant.reasoning,
          chosen: variant.chosen,
        })),
      });
    }

    if (source.prediction) {
      await tx.performancePrediction.create({
        data: {
          runId: created.id,
          predictedCtr: source.prediction.predictedCtr,
          predictedRetention: source.prediction.predictedRetention,
          score: source.prediction.score,
          reasoning: source.prediction.reasoning,
        },
      });
    }

    if (source.voiceAsset) {
      await tx.voiceAsset.create({
        data: {
          runId: created.id,
          audioPath: source.voiceAsset.audioPath,
          durationSec: source.voiceAsset.durationSec,
          voiceId: source.voiceAsset.voiceId,
        },
      });
    }

    if (source.scenes.length > 0) {
      await tx.scene.createMany({
        data: source.scenes.map((scene) => ({
          runId: created.id,
          index: scene.index,
          startSec: scene.startSec,
          endSec: scene.endSec,
          text: scene.text,
          query: scene.query,
          clipUrl: scene.clipUrl,
          clipSource: scene.clipSource,
          clipPath: scene.clipPath,
          clipDurationSec: scene.clipDurationSec,
        })),
      });
    }

    if (source.video) {
      await tx.video.create({
        data: {
          runId: created.id,
          videoPath: source.video.videoPath,
          thumbnailPath: source.video.thumbnailPath,
          title: source.video.title,
          description: source.video.description,
          tags: source.video.tags,
        },
      });
    }

    return created;
  });

  await requeuePipelineRunFromStage(fork.id, fromStage, control);

  return { runId: fork.id };
}
