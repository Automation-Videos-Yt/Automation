# Project Flow and Detailed Code Map

## 1. Project Purpose

This repository is a monorepo for an automated YouTube short-video pipeline.

High-level objective:

1. User provides a niche.
2. System generates topic, script, hook variants, prediction, voiceover, timestamps, stock clips, final video, and optional thumbnail.
3. User uploads to YouTube.
4. System fetches analytics, generates feedback, and stores memories.
5. Future runs use those memories to improve topic/hook quality.

The project is split into 4 runtime services:

1. `apps/web` (Next.js UI)
2. `apps/api` (Express API, queue producers, OAuth, SSE)
3. `apps/worker` (BullMQ consumers, media pipeline, upload, enrichment)
4. `ai-system` (FastAPI microservice with LLM/TTS/thumbnail agents)

Supporting infra:

1. PostgreSQL for persistent state (Prisma schema)
2. Redis for BullMQ + pub/sub events
3. Docker Compose for local orchestration

## 2. Runtime Architecture (How the System Carries Out Work)

## 2.1 Service Topology

1. Browser talks to API (`/pipeline`, `/auth/youtube`, `/analytics`).
2. API writes DB records and enqueues jobs to Redis queues.
3. Worker consumes jobs and does heavy work (agents, ffmpeg, upload, analytics).
4. Worker publishes run events to Redis channel `pipeline:events`.
5. API subscribes to Redis events and forwards them over SSE to browser.
6. AI service executes agent-specific logic on HTTP calls from worker.

## 2.2 Queue Topology

1. `videoQueue`: main generation pipeline (`runPipeline`).
2. `uploadQueue`: YouTube upload (`runUpload`).
3. `enrichmentQueue`: analytics + feedback + memory (`runEnrichment`).

## 2.3 Event Topology

Redis channel: `pipeline:events`

Event kinds:

1. `stage`
2. `upload`
3. `analytics`
4. `feedback`
5. `memory`

Frontend consumes via: `GET /pipeline/:id/stream` (SSE).

## 3. End-to-End Flow (Complete Lifecycle)

## 3.1 Boot Flow

1. `scripts/bootstrap.sh` ensures `.env` exists (copies from `.env.example` if missing).
2. `docker compose up --build` starts `postgres`, `redis`, `api`, `worker`, `ai`, `web`.
3. API startup:
   1. creates Express app
   2. starts Redis event bus subscriber
   3. listens on `API_PORT`.
4. Worker startup:
   1. opens Redis connection
   2. starts 3 BullMQ workers for video/upload/enrichment.
5. AI startup:
   1. FastAPI app boot
   2. `/agents/{name}/run` and `/embeddings` endpoints ready.
6. Web startup:
   1. Next.js app ready on port 3000.

## 3.2 Run Creation Flow

1. User enters niche + duration in `apps/web/app/page.tsx`.
2. Web calls `api.createRun(niche, durationSec)`.
3. API route `POST /pipeline/run` validates input.
4. `createPipelineRun`:
   1. inserts `PipelineRun` with `stage=QUEUED`, `status=QUEUED`
   2. enqueues `videoQueue` job (`attempts=3`, exponential backoff).
5. Web navigates to `/runs/:id` and opens SSE stream.

## 3.3 Video Pipeline Flow (`apps/worker/src/pipeline-runner.ts` + `apps/worker/src/stages/*`)

`runPipeline(runId)` is now an orchestration shell, not a monolithic stage implementation.

Execution model:

1. loads the run and normalizes feature flags
2. builds a shared `StageContext`
3. emits `QUEUED -> STARTED`
4. iterates `PIPELINE_STAGES`
5. for each stage:
   1. optionally skips via `shouldSkip`
   2. emits `STARTED`
   3. executes stage-local cache/persist/agent/media logic
   4. emits `COMPLETED` or `FAILED`
6. marks run `DONE` or `FAILED`
7. optionally auto-enqueues upload.

`PIPELINE_STAGES` order:

1. `TOPIC`
2. `SCRIPT`
3. `HOOK`
4. `PREDICTION`
5. `VOICE`
6. `TIMESTAMP`
7. `VIDEO_SELECTION`
8. `VIDEO`
9. `THUMBNAIL` (feature-flagged)
10. `DONE`

If any fatal error occurs: pipeline marks run `FAILED`.

Core behavior details:

1. The runner is stage-registry driven (`apps/worker/src/stages/index.ts`).
2. Every stage transition updates DB and publishes `stage` events with `STARTED`, `COMPLETED`, or `FAILED`.
3. Every agent call is wrapped with `withAgentLog` to persist input/output/duration/status.
4. Resume cache is used aggressively (`apps/worker/src/cache/cache-resume.ts`).
5. Stage outputs are shared through `StageContext.cache` so downstream stages do not reread or recompute unnecessarily.
6. Stage failures are isolated; completed stage artifacts remain available for retry.

Worker stage module layout:

1. `apps/worker/src/stages/types.ts`
   1. `PipelineStage`, `StageContext`, `StageResult`, shared output types.
2. `apps/worker/src/stages/helpers.ts`
   1. cancellation guards
   2. run/cache loaders
   3. stage event helpers
   4. shared agent-log wrapper
   5. A/B hook seed helper.
3. `apps/worker/src/stages/topic.stage.ts`
4. `apps/worker/src/stages/script.stage.ts`
5. `apps/worker/src/stages/hook.stage.ts`
6. `apps/worker/src/stages/prediction.stage.ts`
7. `apps/worker/src/stages/voice.stage.ts`
8. `apps/worker/src/stages/timestamp.stage.ts`
9. `apps/worker/src/stages/videoSelection.stage.ts`
10. `apps/worker/src/stages/video.stage.ts`
11. `apps/worker/src/stages/thumbnail.stage.ts`

Stage-by-stage:

1. TOPIC
   1. pulls past topic memory (`retrievePastTopics`)
   2. calls AI `topic` agent
   3. persists `Topic`.
2. SCRIPT
   1. calls AI `script` agent
   2. persists `Script`.
3. HOOK
   1. pulls past hook memory (`retrievePastHooks`)
   2. calls AI `hook` agent (variants + chosen)
   3. persists `HookVariant[]`
   4. updates `Script.hook` to chosen hook.
4. PREDICTION
   1. calls AI `prediction` agent using niche/topic/script + past performance
   2. persists `PerformancePrediction`
   3. if prediction fails: falls back to neutral default score (`score=5`) and continues.
5. VOICE
   1. chooses tier by score (`premium` if >=7.5 else `economy`)
   2. calls AI `voice` agent
   3. persists `VoiceAsset`.
6. TIMESTAMP
   1. if timestamps are disabled or run language is non-English, builds fallback narration scenes
   2. otherwise calls AI `timestamp` agent (Whisper word timings)
   3. dynamic scene target (`4s` if short run else `7.5s`).
7. VIDEO_SELECTION
   1. calls AI `video_selection` agent (query generation + Pexels lookup)
   2. persists `Scene[]`.
8. VIDEO
   1. runs `video_meta` agent (SEO title/description/tags; uses autocomplete)
   2. downloads clips (parallel with `pLimit(6)`)
   3. prepares clips with ffmpeg (parallel with `pLimit(2)`)
   4. generates SRT from words
   5. composes final MP4 (`composeFinalVideo`)
   6. upserts `Video`.
9. THUMBNAIL (only if `ENABLE_THUMBNAIL_AGENT=true`)
   1. chooses size/quality from prediction score
   2. calls AI `thumbnail` agent
   3. updates `Video.thumbnailPath`
   4. if thumbnail fails, pipeline continues.
10. DONE
11. marks run `status=COMPLETED`, `stage=DONE`
12. publishes completion event.

Per-stage execution contract:

1. `startStage(...)`
   1. verifies run not cancelled
   2. updates `PipelineRun.stage`
   3. sets `currentAgent`
   4. logs `Stage started`
   5. emits `STARTED`.
2. Stage `execute(...)`
   1. checks cache or filesystem where applicable
   2. runs the stage-specific logic only if needed
   3. persists outputs
   4. stores normalized output into `StageContext.cache`.
3. `completeStage(...)`
   1. logs completion
   2. emits `COMPLETED`.
4. `onError(...)`
   1. logs failure
   2. emits `FAILED`
   3. leaves prior stage artifacts intact for retry.

## 3.4 Upload Flow

1. User triggers upload from `UploadCard`.
2. Web calls `POST /pipeline/:id/upload` with privacy.
3. API service `enqueueUpload` checks:
   1. run exists and is completed with rendered video
   2. YouTube account connected.
4. API creates/resets `YouTubeUpload` and enqueues `uploadQueue` job.
5. Worker `runUpload(uploadId)`:
   1. sets upload status `RUNNING`
   2. calls `uploadToYouTube`
   3. persists `youtubeVideoId` and `videoUrl` on success
   4. marks `FAILED` with error on failure.

`youtubeClient.ts` details:

1. loads OAuth tokens from `YouTubeAccount` singleton (`id=default`)
2. auto-persist refresh token rotations
3. sanitizes tags to YouTube limits
4. uploads video via `youtube.videos.insert`
5. sets thumbnail if available (`thumbnails.set`, non-fatal on failure).

## 3.5 Analytics + Feedback + Memory Flow

1. Trigger from UI (`Sync now`) or all-runs sync endpoint.
2. API enqueues enrichment jobs (`enrichmentQueue`).
3. Worker `runEnrichment(runId)`:
   1. fetches YouTube analytics snapshot (`fetchVideoAnalytics`)
   2. stores `VideoAnalytics` row
   3. calls AI `feedback` agent and upserts `FeedbackInsight`
   4. attempts memory admission:
      1. `maybeAdmitToMemory` for topic
      2. `maybeAdmitHookToMemory` for hook.

Memory admission rules (`vectorStore.ts`):

1. `views >= 10`
2. `ctr >= 0.02` (2%)

Retrieval rules:

1. embeddings computed by AI `/embeddings`
2. cosine similarity + minimum floor `0.15`
3. sort by similarity then performance
4. top 3 returned as context to topic/hook stages.

## 3.6 Self-Improving Loop

1. Completed uploaded videos become analytics snapshots.
2. Strong-enough runs enter `TopicMemory` and `HookMemory`.
3. New runs in similar niches pull those memories.
4. Topic/hook prompts explicitly bias toward strong patterns and away from weak ones.
5. Over time, generated ideas and hooks converge toward historically better patterns.

## 4. Detailed Folder and File Responsibilities

This section maps every project-owned file (excluding dependency/runtime artifacts in `node_modules` and `storage`).

## 4.1 Root Files

| File                 | Responsibility                                                     |
| -------------------- | ------------------------------------------------------------------ |
| `.env`               | Local runtime secrets and env values for all services.             |
| `.env.example`       | Non-secret template of required env keys.                          |
| `.gitignore`         | Ignores env files, build output, and generated storage assets.     |
| `README.md`          | Product description, architecture summary, and phase notes.        |
| `docker-compose.yml` | Defines postgres, redis, api, worker, ai, web services and wiring. |
| `package.json`       | Monorepo workspace config and root scripts.                        |
| `package-lock.json`  | Exact npm dependency lock for reproducible installs.               |
| `PROJECT_FLOW.md`    | This detailed flow and structure document.                         |

## 4.2 Scripts

| File                   | Responsibility                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| `scripts/bootstrap.sh` | First-run helper: ensure `.env`, then `docker compose up --build`. |
| `scripts/smoke.sh`     | Lightweight integration smoke test for run creation/polling.       |

## 4.3 Infrastructure Dockerfiles

| File                                      | Responsibility                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `infrastructure/docker/Dockerfile.ai`     | Builds Python AI service image and runs uvicorn.                        |
| `infrastructure/docker/Dockerfile.api`    | Builds Node API image, installs workspaces, runs prisma generate + tsx. |
| `infrastructure/docker/Dockerfile.worker` | Builds worker image with ffmpeg/fontconfig + prisma client generation.  |
| `infrastructure/docker/Dockerfile.web`    | Builds web image and runs Next dev server.                              |

## 4.4 AI Service (`ai-system`)

### 4.4.1 Core and Config

| File                                     | Responsibility                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ai-system/main.py`                      | FastAPI app, request logging middleware, health, embeddings endpoint, agent dispatch endpoint. |
| `ai-system/config/__init__.py`           | Loads env and exposes `settings`.                                                              |
| `ai-system/lib/log.py`                   | Structured logging with request-id context + timing helper.                                    |
| `ai-system/lib/llm.py`                   | OpenAI chat helper with transient retry + model fallback.                                      |
| `ai-system/lib/embeddings.py`            | Embedding helper (`text-embedding-3-small`).                                                   |
| `ai-system/orchestrator/agent_runner.py` | Agent registry and dispatch (`topic`, `script`, `hook`, etc).                                  |
| `ai-system/requirements.txt`             | Python dependency list.                                                                        |
| `ai-system/lib/__init__.py`              | Package marker (no runtime logic).                                                             |
| `ai-system/orchestrator/__init__.py`     | Package marker (no runtime logic).                                                             |

### 4.4.2 Agents

| File                                          | Responsibility                                                |
| --------------------------------------------- | ------------------------------------------------------------- |
| `ai-system/agents/topic/agent.py`             | Memory-aware topic generation.                                |
| `ai-system/agents/script/agent.py`            | Script generation with word-count normalization.              |
| `ai-system/agents/hook/agent.py`              | Hook variants generation + scoring + chosen hook sanity.      |
| `ai-system/agents/prediction/agent.py`        | Pre-upload CTR/retention/score prediction.                    |
| `ai-system/agents/voice/agent.py`             | Tiered TTS (ElevenLabs/OpenAI with fallback).                 |
| `ai-system/agents/timestamp/agent.py`         | Whisper transcription + word timings + scene segmentation.    |
| `ai-system/agents/video_selection/agent.py`   | Visual query generation + scene clip matching.                |
| `ai-system/agents/video_selection/pexels.py`  | Pexels API client and clip selection heuristics.              |
| `ai-system/agents/video_meta/agent.py`        | SEO metadata generation using autocomplete phrases.           |
| `ai-system/agents/video_meta/autocomplete.py` | YouTube suggestion retrieval via suggest endpoint.            |
| `ai-system/agents/thumbnail/agent.py`         | Thumbnail prompt crafting + image generation (`gpt-image-1`). |
| `ai-system/agents/feedback/agent.py`          | Post-analytics feedback synthesis and performance tag.        |

### 4.4.3 Agent package initializers

All `ai-system/agents/*/__init__.py` files re-export `run` for registry import convenience.

Files:

1. `ai-system/agents/__init__.py`
2. `ai-system/agents/topic/__init__.py`
3. `ai-system/agents/script/__init__.py`
4. `ai-system/agents/hook/__init__.py`
5. `ai-system/agents/prediction/__init__.py`
6. `ai-system/agents/voice/__init__.py`
7. `ai-system/agents/timestamp/__init__.py`
8. `ai-system/agents/video_selection/__init__.py`
9. `ai-system/agents/video_meta/__init__.py`
10. `ai-system/agents/thumbnail/__init__.py`
11. `ai-system/agents/feedback/__init__.py`

### 4.4.4 Schemas

| File                                     | Responsibility                            |
| ---------------------------------------- | ----------------------------------------- |
| `ai-system/schemas/__init__.py`          | Central schema exports.                   |
| `ai-system/schemas/topic_schema.py`      | Topic input/output contracts.             |
| `ai-system/schemas/script_schema.py`     | Script input/output contracts.            |
| `ai-system/schemas/hook_schema.py`       | Hook variants/chosen output contract.     |
| `ai-system/schemas/prediction_schema.py` | Prediction contract.                      |
| `ai-system/schemas/voice_schema.py`      | Voice generation contract + tier options. |
| `ai-system/schemas/timestamp_schema.py`  | Word and scene timing contracts.          |
| `ai-system/schemas/scene_schema.py`      | Video selection scene contracts.          |
| `ai-system/schemas/video_schema.py`      | Video metadata output contract.           |
| `ai-system/schemas/thumbnail_schema.py`  | Thumbnail generation contract.            |
| `ai-system/schemas/feedback_schema.py`   | Feedback input/output and metrics schema. |

## 4.5 API Service (`apps/api`)

### 4.5.1 Package and ORM

| File                            | Responsibility                           |
| ------------------------------- | ---------------------------------------- |
| `apps/api/package.json`         | API scripts and dependencies.            |
| `apps/api/tsconfig.json`        | TypeScript compilation settings for API. |
| `apps/api/prisma/schema.prisma` | Full DB schema, enums, and relations.    |

### 4.5.2 API runtime files

| File                               | Responsibility                                          |
| ---------------------------------- | ------------------------------------------------------- |
| `apps/api/src/index.ts`            | API bootstrap, starts event bus, listens on port.       |
| `apps/api/src/app.ts`              | Express middleware + route wiring + static media route. |
| `apps/api/src/config/env.ts`       | zod env validation for API process.                     |
| `apps/api/src/db/prisma.ts`        | Prisma client singleton.                                |
| `apps/api/src/lib/logger.ts`       | Pino logger setup and scoped children.                  |
| `apps/api/src/middleware/error.ts` | Global error formatter (zod + generic errors).          |

### 4.5.3 API routes and controllers

| File                                               | Responsibility                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/api/src/routes/pipeline.ts`                  | Pipeline route map (`run`, `retry`, `stream`, `upload`, analytics per run). |
| `apps/api/src/routes/youtube.ts`                   | OAuth route map (`youtube`, callback, status, disconnect).                  |
| `apps/api/src/routes/analytics.ts`                 | Global analytics sync route map.                                            |
| `apps/api/src/controllers/pipeline.controller.ts`  | Run CRUD/retry handlers.                                                    |
| `apps/api/src/controllers/events.controller.ts`    | SSE stream endpoint and keepalive handling.                                 |
| `apps/api/src/controllers/upload.controller.ts`    | Upload enqueue/status handlers.                                             |
| `apps/api/src/controllers/analytics.controller.ts` | Analytics sync + retrieval handlers.                                        |
| `apps/api/src/controllers/youtube.controller.ts`   | OAuth flow and account persistence handlers.                                |

### 4.5.4 API business services

| File                                         | Responsibility                                                    |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `apps/api/src/services/pipeline.service.ts`  | Create/list/get runs, logs, retry behavior, `videoQueue` enqueue. |
| `apps/api/src/services/upload.service.ts`    | Upload eligibility checks + `uploadQueue` enqueue logic.          |
| `apps/api/src/services/analytics.service.ts` | Enrichment queue enqueue + analytics aggregation fetch.           |

### 4.5.5 API queues and events

| File                                         | Responsibility                                         |
| -------------------------------------------- | ------------------------------------------------------ |
| `apps/api/src/queues/videoQueue.ts`          | BullMQ queue handle for video jobs.                    |
| `apps/api/src/queues/uploadQueue.ts`         | BullMQ queue handle for upload jobs.                   |
| `apps/api/src/queues/enrichmentQueue.ts`     | BullMQ queue handle for enrichment jobs.               |
| `apps/api/src/events/bus.ts`                 | Redis subscriber and in-process event fan-out for SSE. |
| `apps/api/src/integrations/youtube/oauth.ts` | OAuth2 client/scopes/auth URL generation.              |

### 4.5.6 API validators

| File                                         | Responsibility                   |
| -------------------------------------------- | -------------------------------- |
| `apps/api/src/validators/pipeline.schema.ts` | Input schema for run creation.   |
| `apps/api/src/validators/upload.schema.ts`   | Input schema for upload request. |

## 4.6 Worker Service (`apps/worker`)

### 4.6.1 Package and startup

| File                            | Responsibility                                     |
| ------------------------------- | -------------------------------------------------- |
| `apps/worker/package.json`      | Worker scripts and dependencies.                   |
| `apps/worker/tsconfig.json`     | TypeScript settings for worker.                    |
| `apps/worker/src/config/env.ts` | Worker env validation and feature flags.           |
| `apps/worker/src/db/prisma.ts`  | Worker Prisma client.                              |
| `apps/worker/src/index.ts`      | Starts BullMQ workers and graceful shutdown hooks. |

### 4.6.2 Pipeline core and support

| File                                    | Responsibility                                          |
| --------------------------------------- | ------------------------------------------------------- |
| `apps/worker/src/pipeline-runner.ts`    | Pipeline orchestrator over modular stage registry.      |
| `apps/worker/src/cache/cache-resume.ts` | Stage cache loaders (DB + filesystem existence checks). |
| `apps/worker/src/clients/aiClient.ts`   | HTTP client to AI service with retry policy.            |
| `apps/worker/src/lib/concurrency.ts`    | Local pLimit implementation.                            |
| `apps/worker/src/lib/logger.ts`         | Worker logger and run-scoped log tags.                  |
| `apps/worker/src/events/publisher.ts`   | Redis event publisher for run events.                   |

### 4.6.3 Pipeline stage system

| File                                              | Responsibility                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/worker/src/stages/types.ts`                 | Shared stage contracts, context type, and stage output shapes.   |
| `apps/worker/src/stages/helpers.ts`               | Shared stage helpers for cache loading, events, logging, cancel. |
| `apps/worker/src/stages/index.ts`                 | Ordered `PIPELINE_STAGES` registry.                              |
| `apps/worker/src/stages/topic.stage.ts`           | Topic generation + duplicate-topic retry + persistence.          |
| `apps/worker/src/stages/script.stage.ts`          | Script generation + persistence.                                 |
| `apps/worker/src/stages/hook.stage.ts`            | Hook variants, chosen hook persistence, A/B child-run seeding.   |
| `apps/worker/src/stages/prediction.stage.ts`      | Prediction generation with advisory fallback.                    |
| `apps/worker/src/stages/voice.stage.ts`           | Voice tier selection, TTS generation, audio persistence.         |
| `apps/worker/src/stages/timestamp.stage.ts`       | Whisper timestamps or fallback scene construction.               |
| `apps/worker/src/stages/videoSelection.stage.ts`  | Scene selection + clip metadata persistence.                     |
| `apps/worker/src/stages/video.stage.ts`           | SEO meta, clip pipeline, subtitle generation, final composition. |
| `apps/worker/src/stages/thumbnail.stage.ts`       | Optional thumbnail generation and DB update.                     |

### 4.6.4 Media processing

| File                                    | Responsibility                                    |
| --------------------------------------- | ------------------------------------------------- |
| `apps/worker/src/media/clipDownload.ts` | Downloads stock clip files.                       |
| `apps/worker/src/media/clipPrep.ts`     | ffmpeg normalization/placeholder scene rendering. |
| `apps/worker/src/media/subtitles.ts`    | SRT generation (word-based and fallback).         |
| `apps/worker/src/media/compose.ts`      | Final ffmpeg concat + audio/subtitle mux.         |

### 4.6.5 Upload + analytics + enrichment

| File                                              | Responsibility                                                |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `apps/worker/src/upload/upload-runner.ts`         | Upload job orchestration and status updates.                  |
| `apps/worker/src/upload/youtubeClient.ts`         | YouTube video upload + thumbnail set + token persistence.     |
| `apps/worker/src/upload/youtubeAnalytics.ts`      | YouTube Analytics snapshot fetcher.                           |
| `apps/worker/src/enrichment/enrichment-runner.ts` | Analytics persistence + feedback + memory admission workflow. |

### 4.6.6 Memory subsystem

| File                                    | Responsibility                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/worker/src/memory/vectorStore.ts` | Embedding computation, cosine retrieval, admission rules for Topic/Hook memory. |

## 4.7 Web App (`apps/web`)

### 4.7.1 Package and config

| File                          | Responsibility                       |
| ----------------------------- | ------------------------------------ |
| `apps/web/package.json`       | Web scripts/dependencies.            |
| `apps/web/tsconfig.json`      | TypeScript and alias config for web. |
| `apps/web/next.config.mjs`    | Next config (`reactStrictMode`).     |
| `apps/web/postcss.config.mjs` | Tailwind + autoprefixer setup.       |
| `apps/web/tailwind.config.ts` | Tailwind content scanning config.    |
| `apps/web/next-env.d.ts`      | Next TypeScript declarations.        |

### 4.7.2 App routes

| File                              | Responsibility                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/web/app/globals.css`        | Global styling.                                                                         |
| `apps/web/app/layout.tsx`         | Shared layout/nav and provider wrapper.                                                 |
| `apps/web/app/providers.tsx`      | React Query provider setup.                                                             |
| `apps/web/app/page.tsx`           | Run creation form (niche + duration presets).                                           |
| `apps/web/app/runs/page.tsx`      | Runs list page with status/stage indicators.                                            |
| `apps/web/app/runs/[id]/page.tsx` | Full run detail, timeline, SSE-driven updates, retry, upload/analytics/feedback panels. |

### 4.7.3 Components and API client

| File                                     | Responsibility                                            |
| ---------------------------------------- | --------------------------------------------------------- |
| `apps/web/components/UploadCard.tsx`     | Upload controls/status UI.                                |
| `apps/web/components/AnalyticsCard.tsx`  | Analytics snapshot UI + sync trigger.                     |
| `apps/web/components/FeedbackCard.tsx`   | Feedback insight panel.                                   |
| `apps/web/components/PredictionCard.tsx` | Predicted vs actual performance card.                     |
| `apps/web/components/YouTubeBadge.tsx`   | Connect/disconnect YouTube status badge.                  |
| `apps/web/services/api.ts`               | Typed fetch wrappers and shared domain types for web app. |

## 5. Database Model Flow (Prisma)

Main run object:

1. `PipelineRun` (hub record)

Generated content objects:

1. `Topic` (1:1)
2. `Script` (1:1)
3. `HookVariant` (1:N)
4. `VoiceAsset` (1:1)
5. `Scene` (1:N)
6. `Video` (1:1)
7. `PerformancePrediction` (1:1)
8. `AgentLog` (1:N)

Publish + growth objects:

1. `YouTubeAccount` (singleton auth store)
2. `YouTubeUpload` (1:1 per run)
3. `VideoAnalytics` (time snapshots)
4. `FeedbackInsight` (1:1)
5. `TopicMemory` (learning store)
6. `HookMemory` (learning store)

State progression of a run:

1. `QUEUED`
2. `RUNNING` through stages
3. `COMPLETED` at `DONE`
4. or `FAILED` with `errorMessage`.

Retry behavior:

1. API retry resets status back to queued.
2. Worker cache resumes from persisted assets instead of rerunning everything.

## 6. Reliability and Cost Controls Already Implemented

1. Agent HTTP retries for transient AI service failures.
2. LLM fallback from quality model to fast model in selected agents.
3. Queue attempts with exponential backoff.
4. Voice provider fallback (ElevenLabs to OpenAI for elite path).
5. Prediction is advisory and non-blocking.
6. Thumbnail generation is feature-flagged and non-fatal.
7. Stage-based execution preserves partial outputs for resume and retry.
8. Download/prep parallelization with bounded concurrency.
9. SSE push updates + fallback polling in UI.

## 7. Environment and Secrets Handling Notes

1. `.env` contains sensitive credentials and should never be shared or committed.
2. `.env.example` is the safe template for required keys.
3. API, worker, and AI services all validate key env values at startup.
4. Storage paths are mounted to `/storage` and exposed to web through API `/media` static route.

## 8. Practical "What Happens When" Summary

When you click Start Run:

1. API creates `PipelineRun` and queue job.
2. Worker builds `StageContext` and runs the registered stages with cache-aware resume.
3. AI service executes specialized agent tasks.
4. Worker emits stage events.
5. UI updates live via SSE.
6. On completion, final MP4 and metadata are available.

When you click Upload:

1. API validates readiness + YouTube account connection.
2. Worker uploads video and optional thumbnail.
3. Upload status updates flow back to UI in real time.

When you click Sync Analytics:

1. Worker fetches YouTube analytics.
2. Feedback agent generates what worked/what did not/suggestions.
3. Eligible runs are admitted to memory.
4. Next runs become memory-informed and progressively smarter.

## 9. Current Pipeline Scope in One Line

This project is a full closed-loop system: idea generation -> automated production -> publishing -> performance learning -> memory-guided future generation.
