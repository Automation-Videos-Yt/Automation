# AI YouTube Automation

Autonomous, self-improving, cost-aware pipeline for short-form YouTube content.

Input a niche, generate videos automatically, upload to YouTube, sync analytics, and feed performance back into memory so future runs improve over time.

## What This System Does

Main pipeline:

`Topic -> Script -> Hook -> Prediction -> Voice -> Timestamp -> Video Selection -> Video -> (Optional Thumbnail) -> Upload -> Analytics -> Feedback -> Memory`

Highlights:

- Multi-language run generation and batch creation
- Hook variants with optional A/B experiment flows
- Prediction-driven voice and thumbnail tiering
- Resume-from-last-success retries using cached artifacts
- Real-time run updates via SSE
- YouTube OAuth, upload, and analytics sync
- Topic and hook memory retrieval/admission with embeddings
- Cost breakdown + LangChain optimization analysis (API + frontend)

## Architecture

```text
Next.js Web (3000)
   |
Express API (4000)  <---->  PostgreSQL
   |
Redis (queues + pub/sub)
   |
Worker(s): video / upload / enrichment
   |
Python AI service (8000) + OpenAI + ElevenLabs + Pexels + YouTube APIs
```

Core services:

- `apps/web`: Next.js 14 dashboard (React Query)
- `apps/api`: Express API, Prisma, queue producers, OAuth, SSE relay
- `apps/worker`: BullMQ consumers, media pipeline, upload, enrichment, cron
- `ai-system`: FastAPI AI service exposing agent execution and embeddings

## Monorepo Layout

```text
apps/
  api/      Express + Prisma + queues + OAuth + SSE
  web/      Next.js dashboard
  worker/   BullMQ workers (video/upload/enrichment)
ai-system/  FastAPI agent runtime
infrastructure/docker/
scripts/
storage/
```

## Requirements

- Node.js >= 20
- Docker + Docker Compose (recommended path)
- OpenAI API key
- Pexels API key
- YouTube OAuth app credentials (for upload/analytics)
- Optional: ElevenLabs API key

## Quick Start (Docker)

```bash
cp .env.example .env
# Fill required keys in .env

# First-run helper (creates .env if missing and exits)
./scripts/bootstrap.sh

# Start full stack
docker compose up --build
```

Open: `http://localhost:3000`

### First Actions

1. Connect YouTube from the UI.
2. Create a run (or batch).
3. Watch live stage updates.
4. Upload completed video.
5. Sync analytics and inspect feedback/memory effects.

## Local Dev Commands (Workspace)

From repo root:

```bash
npm install
npm run dev:api
npm run dev:worker
npm run dev:web
```

Build all workspaces:

```bash
npm run build
```

Targeted builds:

```bash
npm run -w apps/api build
npm run -w apps/worker build
npm run -w apps/web build
```

## Pipeline Details

| Stage             | Agent / Logic         | Notes                                                      |
| ----------------- | --------------------- | ---------------------------------------------------------- |
| `TOPIC`           | `topic`               | Uses past topic memory and duplicate-topic retries         |
| `SCRIPT`          | `script`              | Duration-aware script generation                           |
| `HOOK`            | `hook`                | Variants + scoring + chosen hook                           |
| `PREDICTION`      | `prediction`          | Predicts CTR/retention score; advisory fallback on failure |
| `VOICE`           | `voice`               | Tier chosen from prediction score                          |
| `TIMESTAMP`       | `timestamp`           | Whisper word timings + scene segmentation                  |
| `VIDEO_SELECTION` | `video_selection`     | Scene-intelligence + Pexels candidate ranking              |
| `VIDEO`           | `video_meta` + ffmpeg | SEO metadata + clip download/prep + final composition      |
| `THUMBNAIL`       | `thumbnail`           | Feature-flagged image generation                           |
| `DONE`            | pipeline completion   | Optional auto-upload scheduling                            |

Notes:

- Stage outputs are persisted and reused on retry.
- Prediction can fail without blocking pipeline completion (neutral fallback values used).
- Thumbnail failure is non-fatal.

## Memory and Dedup

Memory stores:

- `TopicMemory`
- `HookMemory`

Behavior:

- Retrieval uses embeddings + cosine similarity thresholds.
- Admission requires minimum performance thresholds.
- Topic dedup checks generated topic embeddings against prior run topics.
- New runs bias prompts toward historically strong patterns.

## Cost Analysis

The system exposes two layers of cost intelligence:

1. Deterministic cost breakdown
   - Voice
   - Whisper
   - Thumbnail
   - Flat LLM estimate
2. Optional LangChain analysis
   - Summary
   - Dominant cost driver
   - Optimization actions
   - Estimated savings

LangChain analysis is controlled by env flags and degrades gracefully to raw numeric breakdown when disabled or unavailable.

### Cost in Frontend

Run detail page includes a dedicated Cost Analysis card with:

- Bucket visualization (voice/whisper/thumbnail/llm)
- AI optimization advice
- Cost timeline events
- Cache health metrics
- Manual refresh button (`refreshAnalysis=true`)

## API Endpoints

### Pipeline

| Method | Path                       | Purpose                   |
| ------ | -------------------------- | ------------------------- |
| `POST` | `/pipeline/run`            | Create one run            |
| `POST` | `/pipeline/batch`          | Create batch runs         |
| `GET`  | `/pipeline`                | List runs                 |
| `GET`  | `/pipeline/:id`            | Run detail                |
| `GET`  | `/pipeline/:id/logs`       | Agent logs                |
| `GET`  | `/pipeline/:id/experiment` | Hook experiment status    |
| `POST` | `/pipeline/:id/retry`      | Retry failed run          |
| `POST` | `/pipeline/:id/cancel`     | Cancel queued/running run |
| `GET`  | `/pipeline/:id/stream`     | SSE events                |

### Upload

| Method | Path                   | Purpose                                          |
| ------ | ---------------------- | ------------------------------------------------ |
| `POST` | `/pipeline/:id/upload` | Queue upload (`privacy`, optional `scheduledAt`) |
| `GET`  | `/pipeline/:id/upload` | Upload status                                    |

### Analytics

| Method | Path                           | Purpose                                |
| ------ | ------------------------------ | -------------------------------------- | --- | ---- | ---------------------- |
| `GET`  | `/pipeline/:id/analytics`      | Per-run analytics + feedback           |
| `POST` | `/pipeline/:id/analytics/sync` | Queue enrichment for run               |
| `POST` | `/analytics/sync`              | Queue enrichment for all uploaded runs |
| `GET`  | `/analytics/channel?days=7     | 28                                     | 90  | 365` | Channel dashboard data |

### Cost

| Method | Path                    | Purpose                                           |
| ------ | ----------------------- | ------------------------------------------------- |
| `GET`  | `/cost/run/:id`         | Current run cost + optional LangChain analysis    |
| `GET`  | `/cost/run/:id/history` | Cost timeline events (`limit`, `refreshAnalysis`) |
| `GET`  | `/cost/cache/stats`     | In-memory cost analysis cache stats               |

### YouTube Auth

| Method | Path                       | Purpose            |
| ------ | -------------------------- | ------------------ |
| `GET`  | `/auth/youtube`            | Start OAuth        |
| `GET`  | `/auth/youtube/callback`   | OAuth callback     |
| `GET`  | `/auth/youtube/status`     | Connection status  |
| `POST` | `/auth/youtube/disconnect` | Disconnect account |

### Media

| Method | Path       | Purpose                                 |
| ------ | ---------- | --------------------------------------- |
| `GET`  | `/media/*` | Serve generated files from storage path |

## Run and Batch Request Shapes

Create run (`POST /pipeline/run`):

```json
{
  "niche": "automation tools",
  "durationSec": 75,
  "languageCode": "en",
  "features": {
    "enableTimestamp": true,
    "enableSubtitles": true,
    "enableThumbnail": true,
    "enableHookVariants": true
  }
}
```

Create batch (`POST /pipeline/batch`):

```json
{
  "niche": "productivity",
  "count": 3,
  "durationSec": 75,
  "languageCodes": ["en", "es"],
  "features": {
    "enableHookVariants": true
  }
}
```

Upload (`POST /pipeline/:id/upload`):

```json
{
  "privacy": "PUBLIC",
  "scheduledAt": "2026-04-18T12:00:00.000Z"
}
```

## Environment Variables

### Core Runtime

- `DATABASE_URL`
- `REDIS_URL`
- `AI_SERVICE_URL`
- `STORAGE_PATH`
- `API_PORT`
- `PUBLIC_API_URL`
- `NEXT_PUBLIC_API_URL`

### Providers

- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `PEXELS_API_KEY`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REDIRECT_URI`

### Worker Behavior

- `WORKER_ROLE` (`all|video|upload|enrichment`)
- `WORKER_CONCURRENCY`
- `UPLOAD_WORKER_CONCURRENCY`
- `ENRICHMENT_WORKER_CONCURRENCY`
- `ENABLE_ANALYTICS_CRON`
- `ANALYTICS_SYNC_CRON`

### Feature Flags

- `ENABLE_THUMBNAIL_AGENT`
- `ENABLE_HOOK_AB_TESTING`
- `HOOK_AB_VARIANTS`
- `HOOK_AB_AUTO_UPLOAD`
- `HOOK_AB_UPLOAD_PRIVACY`
- `AUTO_UPLOAD_ON_PIPELINE_DONE`
- `AUTO_UPLOAD_PRIVACY`
- `AUTO_UPLOAD_DELAY_MINUTES`

### Cost Analysis (API)

- `ENABLE_LANGCHAIN_COST_ANALYSIS`
- `OPENAI_MODEL_COST_ANALYSIS`

## Worker Role Modes

`WORKER_ROLE=all` starts all queue consumers in one process.

For split mode, start dedicated workers with docker profiles:

```bash
docker compose --profile split-workers up -d worker-video worker-upload worker-enrichment
```

Scale heavy generation separately:

```bash
docker compose --profile split-workers up -d --scale worker-video=2 worker-video worker-upload worker-enrichment
```

## Reliability Notes

- API client and AI calls include retry strategies where appropriate.
- Queue jobs use attempts + exponential backoff.
- SSE keeps frontend in sync with worker state transitions.
- Cancellation is cooperative and updates DB + queue state.
- Retry uses persisted artifacts to avoid recomputing completed stages.

## YouTube Prerequisites

- Enable YouTube Data API v3 and YouTube Analytics API v2 in your Google Cloud project.
- Configure OAuth redirect URI: `http://localhost:4000/auth/youtube/callback`
- Use scopes needed by upload and analytics flows.
- For custom thumbnails, YouTube channel verification is required.

## Useful Scripts

Smoke test API run flow:

```bash
./scripts/smoke.sh "productivity hacks"
```

## Known Build Warnings

Current web build may report `@next/next/no-img-element` warnings in existing pages. These are non-blocking but can be migrated to `next/image` for stricter optimization compliance.

## License

Internal project. Add your preferred license before public distribution.
