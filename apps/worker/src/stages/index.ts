import { hookStage } from "./hook.stage";
import { predictionStage } from "./prediction.stage";
import { scriptStage } from "./script.stage";
import { thumbnailStage } from "./thumbnail.stage";
import { timestampStage } from "./timestamp.stage";
import { topicStage } from "./topic.stage";
import { videoSelectionStage } from "./videoSelection.stage";
import { videoStage } from "./video.stage";
import { voiceStage } from "./voice.stage";
import type { PipelineStage } from "./types";

export * from "./types";

export const PIPELINE_STAGES: PipelineStage[] = [
  topicStage,
  scriptStage,
  hookStage,
  predictionStage,
  voiceStage,
  timestampStage,
  videoSelectionStage,
  videoStage,
  thumbnailStage,
];
