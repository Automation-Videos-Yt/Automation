import type { PipelineRun, PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { WorkerConfig } from "../config/env";
import type { PastHook, PastTopic } from "../memory/vectorStore";
import type {
  RunControlOverrides as QueueRunControlOverrides,
  RunFeatures as QueueRunFeatures,
} from "../queues/videoQueue";

export type TopicOutput = {
  title: string;
  angle: string;
  rationale: string;
  trend_score: number;
};

export type ScriptOutput = {
  hook: string;
  body: string;
  cta: string;
  word_count: number;
  duration_estimate_sec: number;
};

export type ScriptEvalOutput = {
  score: number;
  passed: boolean;
  feedback: string[];
};

export type HookOutput = {
  winning_hook: string;
  hook_score: number;
  generation_count: number;
};

export type PredictionOutput = {
  predicted_ctr: number;
  predicted_retention: number;
  score: number;
  reasoning: string;
};

export type VoiceOutput = {
  audio_path: string;
  duration_sec: number;
  voice_id: string;
  provider?: string;
  word_timestamps?: {
    word: string;
    start: number;
    end: number;
  }[];
};

export type WordSpanOut = {
  word: string;
  start: number;
  end: number;
};

export type SceneSpanOut = {
  index: number;
  start: number;
  end: number;
  text: string;
};

export type TimestampOutput = {
  total_duration_sec: number;
  words: WordSpanOut[];
  scenes: SceneSpanOut[];
};

export type SelectedClipOut = {
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

export type VideoSelectionOutput = {
  scenes: SelectedClipOut[];
};

export type VideoMetaOutput = {
  title: string;
  description: string;
  tags: string[];
};

export type ThumbnailOutput = {
  image_path: string;
  prompt: string;
  width: number;
  height: number;
  quality: string;
};

export type StageName =
  | "TOPIC"
  | "SCRIPT"
  | "HOOK"
  | "PREDICTION"
  | "VOICE"
  | "TIMESTAMP"
  | "VIDEO_SELECTION"
  | "VIDEO"
  | "THUMBNAIL";

export type StageEvent = {
  runId: string;
  stage: StageName | "QUEUED" | "DONE" | "FAILED";
  status: "STARTED" | "COMPLETED" | "FAILED";
  agent?: string | null;
  error?: string;
  meta?: Record<string, unknown>;
};

export interface StageCache {
  run?: PipelineRun;
  experimentId?: string;
  features: QueueRunFeatures;
  control?: QueueRunControlOverrides;
  stageRetryCounts?: Partial<Record<StageName, number>>;
  pastTopics?: PastTopic[];
  pastHooks?: PastHook[];
  topic?: TopicOutput;
  topicEmbedding?: number[];
  script?: ScriptOutput;
  hook?: HookOutput;
  prediction?: PredictionOutput;
  voice?: VoiceOutput;
  narration?: string;
  timestamp?: TimestampOutput;
  videoSelection?: VideoSelectionOutput;
  videoMeta?: VideoMetaOutput;
  finalVideoPath?: string;
  thumbnail?: ThumbnailOutput | null;
}

export interface StageContext {
  runId: string;
  prisma: PrismaClient;
  logger: Logger;
  emit: (event: StageEvent) => Promise<void>;
  cache: StageCache;
  config: WorkerConfig;
}

export interface StageResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PipelineStage {
  name: StageName;
  execute(input: StageContext): Promise<StageResult>;
  shouldSkip?(context: StageContext): Promise<boolean>;
  onError?(error: unknown, context: StageContext): Promise<void>;
}

export type RunFeatures = QueueRunFeatures;
export type RunControlOverrides = QueueRunControlOverrides;
