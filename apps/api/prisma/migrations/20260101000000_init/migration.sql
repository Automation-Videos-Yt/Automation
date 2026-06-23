-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('QUEUED', 'TOPIC', 'SCRIPT', 'HOOK', 'PREDICTION', 'TIMESTAMP', 'VIDEO_SELECTION', 'VOICE', 'VIDEO', 'THUMBNAIL', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentLogStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "UploadPrivacy" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT,
    "niche" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "targetDurationSec" INTEGER NOT NULL DEFAULT 75,
    "stage" "PipelineStage" NOT NULL DEFAULT 'QUEUED',
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "currentAgent" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedStage" "PipelineStage",
    "stageFailureReason" TEXT,
    "stageFailureMeta" JSONB,
    "stageRetryCounts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "trendScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "titleEmbedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "durationEstimateSec" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HookVariant" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HookVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceAsset" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "audioPath" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "voiceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scene" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "query" TEXT,
    "clipUrl" TEXT,
    "clipSource" TEXT,
    "clipPath" TEXT,
    "clipDurationSec" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "videoPath" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "title" TEXT,
    "description" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "inputJson" JSONB NOT NULL,
    "outputJson" JSONB,
    "durationMs" INTEGER NOT NULL,
    "status" "AgentLogStatus" NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCostRecord" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "promptVersion" TEXT,
    "tokensInput" INTEGER,
    "tokensOutput" INTEGER,
    "audioChars" INTEGER,
    "audioSeconds" DOUBLE PRECISION,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCostRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCache" (
    "id" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeAccount" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "channelId" TEXT,
    "channelTitle" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeUpload" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "privacy" "UploadPrivacy" NOT NULL DEFAULT 'PRIVATE',
    "youtubeVideoId" TEXT,
    "videoUrl" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAnalytics" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER,
    "impressions" INTEGER,
    "ctr" DOUBLE PRECISION,
    "avgViewDurationSec" DOUBLE PRECISION,
    "avgViewPercentage" DOUBLE PRECISION,
    "watchTimeMinutes" DOUBLE PRECISION,
    "subsGained" INTEGER,

    CONSTRAINT "VideoAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformancePrediction" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "predictedCtr" DOUBLE PRECISION NOT NULL,
    "predictedRetention" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformancePrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackInsight" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "whatWorked" TEXT NOT NULL,
    "whatDidnt" TEXT NOT NULL,
    "suggestions" TEXT NOT NULL,
    "performanceTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicMemory" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "niche" TEXT NOT NULL,
    "topicTitle" TEXT NOT NULL,
    "topicAngle" TEXT NOT NULL,
    "ctr" DOUBLE PRECISION,
    "views" INTEGER,
    "avgViewPct" DOUBLE PRECISION,
    "performance" DOUBLE PRECISION NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HookMemory" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "niche" TEXT NOT NULL,
    "topicTitle" TEXT NOT NULL,
    "hookText" TEXT NOT NULL,
    "ctr" DOUBLE PRECISION,
    "views" INTEGER,
    "avgViewPct" DOUBLE PRECISION,
    "performance" DOUBLE PRECISION NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HookMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineSchedule" (
    "id" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "cronExpression" TEXT NOT NULL,
    "repeatJobKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineRun_status_stage_idx" ON "PipelineRun"("status", "stage");

-- CreateIndex
CREATE INDEX "PipelineRun_experimentId_idx" ON "PipelineRun"("experimentId");

-- CreateIndex
CREATE INDEX "PipelineRun_createdAt_idx" ON "PipelineRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_runId_key" ON "Topic"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Script_runId_key" ON "Script"("runId");

-- CreateIndex
CREATE INDEX "HookVariant_runId_index_idx" ON "HookVariant"("runId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceAsset_runId_key" ON "VoiceAsset"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Scene_runId_index_key" ON "Scene"("runId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Video_runId_key" ON "Video"("runId");

-- CreateIndex
CREATE INDEX "AgentLog_runId_createdAt_idx" ON "AgentLog"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostRecord_runId_idx" ON "AiCostRecord"("runId");

-- CreateIndex
CREATE INDEX "AiCostRecord_provider_model_idx" ON "AiCostRecord"("provider", "model");

-- CreateIndex
CREATE UNIQUE INDEX "AiCache_taskType_inputHash_key" ON "AiCache"("taskType", "inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeUpload_runId_key" ON "YouTubeUpload"("runId");

-- CreateIndex
CREATE INDEX "YouTubeUpload_status_createdAt_idx" ON "YouTubeUpload"("status", "createdAt");

-- CreateIndex
CREATE INDEX "VideoAnalytics_runId_snapshotAt_idx" ON "VideoAnalytics"("runId", "snapshotAt");

-- CreateIndex
CREATE UNIQUE INDEX "PerformancePrediction_runId_key" ON "PerformancePrediction"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackInsight_runId_key" ON "FeedbackInsight"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicMemory_runId_key" ON "TopicMemory"("runId");

-- CreateIndex
CREATE INDEX "TopicMemory_niche_idx" ON "TopicMemory"("niche");

-- CreateIndex
CREATE UNIQUE INDEX "HookMemory_runId_key" ON "HookMemory"("runId");

-- CreateIndex
CREATE INDEX "HookMemory_niche_idx" ON "HookMemory"("niche");

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HookVariant" ADD CONSTRAINT "HookVariant_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceAsset" ADD CONSTRAINT "VoiceAsset_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentLog" ADD CONSTRAINT "AgentLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCostRecord" ADD CONSTRAINT "AiCostRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeUpload" ADD CONSTRAINT "YouTubeUpload_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAnalytics" ADD CONSTRAINT "VideoAnalytics_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformancePrediction" ADD CONSTRAINT "PerformancePrediction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackInsight" ADD CONSTRAINT "FeedbackInsight_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

