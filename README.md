# AI YouTube Automation

> An autonomous, self-improving, cost-aware platform for generating, rendering, uploading, and learning from short-form YouTube videos.

[![CI](https://github.com/Automation-Videos-Yt/Automation/actions/workflows/ci.yml/badge.svg)](https://github.com/Automation-Videos-Yt/Automation/actions/workflows/ci.yml)

AI YouTube Automation is a production-oriented monorepo that turns a YouTube niche into a complete short-form video pipeline.

You provide a niche, language, and generation configuration. The platform can then:

- generate a topic and angle
- write and evaluate a script
- generate and score hook variants
- predict expected performance
- select a voice tier and synthesize narration
- create timestamps and readable subtitles
- find and rank stock video clips
- render a vertical video with FFmpeg
- optionally generate a thumbnail
- upload to YouTube
- synchronize channel/video analytics
- learn from performance through topic/hook memory
- analyze AI spend and execute cost/quality optimization actions
- resume failed work from the last useful stage instead of restarting the entire run

The result is a closed-loop content system:

```text
Niche
  │
  ▼
Topic → Script → Hook Variants → Prediction
  │                                  │
  │                                  └──► Voice / Thumbnail tiering
  ▼
Timestamping → Stock Video Selection → FFmpeg Composition
  │
  ▼
Generated Video
  │
  ├──► Optional YouTube Upload
  │
  └──► Analytics Sync
          │
          ▼
      Feedback + Memory
          │
          ▼
   Better Future Runs
```

---

## Table of Contents

- [Why This Project Exists](#why-this-project-exists)
- [Core Capabilities](#core-capabilities)
- [High-Level Architecture](#high-level-architecture)
- [Repository Structure](#repository-structure)
- [End-to-End Pipeline](#end-to-end-pipeline)
- [AI Agent System](#ai-agent-system)
- [AI Provider Routing and Fallbacks](#ai-provider-routing-and-fallbacks)
- [Memory and Self-Improvement](#memory-and-self-improvement)
- [Cost Intelligence and Agentic Optimization](#cost-intelligence-and-agentic-optimization)
- [Background Jobs and Worker Model](#background-jobs-and-worker-model)
- [Media Pipeline](#media-pipeline)
- [YouTube Integration](#youtube-integration)
- [Analytics and Feedback Loop](#analytics-and-feedback-loop)
- [Database](#database)
- [API](#api)
- [Web Dashboard](#web-dashboard)
- [Configuration](#configuration)
- [Local Development](#local-development)
- [Docker Development](#docker-development)
- [Production Deployment](#production-deployment)
- [Observability](#observability)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Scaling](#scaling)
- [Failure Recovery and Reliability](#failure-recovery-and-reliability)
- [Security Notes](#security-notes)
- [Known Limitations](#known-limitations)
- [Project Documentation](#project-documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Why This Project Exists

The goal is not just to automate video generation.

Most content automation systems stop after producing a video. This project is designed around the harder problem:

> **How can the system use production cost, predicted performance, real YouTube analytics, and historical outcomes to make the next run better?**

That is why the architecture contains separate services for:

1. **Content intelligence** — topic, script, hook, prediction, metadata.
2. **Media execution** — voice, subtitles, stock footage, FFmpeg.
3. **Distribution** — YouTube OAuth, uploads, scheduling.
4. **Measurement** — video and channel analytics.
5. **Learning** — feedback extraction and vector-backed topic/hook memory.
6. **Optimization** — cost analysis and LangGraph-driven control actions.

---

## Core Capabilities

### Content generation

- Niche-to-topic generation with a concrete angle and trend score.
- Duration-aware short-form script generation.
- Script evaluation against hook strength, pacing, emotional impact, retention, and CTA quality.
- Multiple hook variants with scoring and optional A/B experiment support.
- SEO-oriented title, description, and tag generation.
- Pre-publication CTR/retention prediction.

### Multi-language generation

The pipeline carries a language code through topic, script, hook, voice, metadata, and subtitle-related stages so a single deployment can support multiple content languages.

### Voice generation

The worker selects a voice tier from prediction signals:

- `elite` — premium ElevenLabs path.
- `premium` — OpenAI HD TTS path.
- `economy` — OpenAI standard TTS path.

The voice implementation is designed to fall back to OpenAI TTS when the premium ElevenLabs path fails so voice generation does not unnecessarily hard-stop a pipeline.

### Intelligent media selection

The video-selection agent combines scene-level narration context with stock-video search. Pexels is integrated as the stock-video source, while the worker handles downloading and clip preparation.

### Automated rendering

The worker uses FFmpeg to:

- normalize portrait media
- prepare scene clips
- concatenate/composite scenes
- burn subtitles when enabled
- produce the final short-form video artifact

The default target is vertical `1080 × 1920`.

### Optional thumbnail generation

Thumbnail generation is feature-flagged because YouTube thumbnail capabilities can depend on channel verification and platform restrictions.

### YouTube distribution

The API/worker stack supports:

- Google OAuth connection
- encrypted YouTube token storage
- upload queueing
- scheduled uploads
- privacy selection (`PRIVATE`, `UNLISTED`, `PUBLIC`)
- channel/video analytics synchronization

### Real-time progress

Pipeline state is persisted in PostgreSQL and exposed through Server-Sent Events (SSE), allowing the web application to show live stage transitions without polling every UI update.

### Resumable execution

Each pipeline stage is designed to persist useful output and reuse cache/artifacts when retrying.

A failed video does not automatically imply that the topic, script, or voice must be regenerated.

---

# High-Level Architecture

```text
                         ┌──────────────────────┐
                         │      Next.js Web      │
                         │       :3000           │
                         └──────────┬───────────┘
                                    │ HTTP / SSE
                                    ▼
                         ┌──────────────────────┐
                         │    Express API       │
                         │       :4000           │
                         └──────┬────────┬──────┘
                                │        │
                    PostgreSQL  │        │ Redis / BullMQ
                                │        │
                                ▼        ▼
                         ┌──────────────────────┐
                         │     Worker(s)        │
                         │ video/upload/        │
                         │ enrichment jobs      │
                         └──────┬───────────────┘
                                │ HTTP
                                ▼
                         ┌──────────────────────┐
                         │    FastAPI AI        │
                         │       :8000           │
                         └──────┬───────────────┘
                                │
                 ┌──────────────┼─────────────────────┐
                 │              │                     │
                 ▼              ▼                     ▼
            LLM Providers   ElevenLabs            Pexels
          Gemini/OpenAI/     / OpenAI TTS        stock video
          Groq/OpenRouter

Supporting infrastructure:

PostgreSQL
Redis
S3-compatible storage
Prometheus
Grafana
OpenTelemetry Collector
Docker / Docker Compose
Terraform / AWS
GitHub Actions
```

### Service responsibilities

| Service | Responsibility |
|---|---|
| `apps/web` | Next.js dashboard, authentication UI, runs, analytics, schedules, payments/cost views |
| `apps/api` | REST API, Prisma, authentication, OAuth, queue producers, SSE, analytics, cost-control orchestration |
| `apps/worker` | BullMQ consumers, pipeline stages, media processing, YouTube upload, enrichment, cron jobs |
| `ai-system` | FastAPI agent runtime, LLM routing, provider fallbacks, embeddings, specialized AI agents |
| `packages/pricing` | Shared pricing/cost calculation logic |
| `infrastructure` | Dockerfiles, Terraform, reverse proxy, Prometheus, Grafana, OpenTelemetry |
| `scripts` | Local bootstrap and smoke testing helpers |

---

# Repository Structure

```text
.
├── apps/
│   ├── api/
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── src/
│   │       ├── automation/
│   │       ├── config/
│   │       ├── controllers/
│   │       ├── db/
│   │       ├── events/
│   │       ├── integrations/
│   │       ├── lib/
│   │       ├── middleware/
│   │       ├── queues/
│   │       ├── repositories/
│   │       ├── routes/
│   │       ├── services/
│   │       ├── utils/
│   │       └── validators/
│   │
│   ├── worker/
│   │   └── src/
│   │       ├── cache/
│   │       ├── clients/
│   │       ├── config/
│   │       ├── cron/
│   │       ├── db/
│   │       ├── enrichment/
│   │       ├── events/
│   │       ├── lib/
│   │       ├── media/
│   │       ├── memory/
│   │       ├── observability/
│   │       ├── queues/
│   │       ├── stages/
│   │       └── upload/
│   │
│   └── web/
│       ├── app/
│       ├── components/
│       ├── lib/
│       └── services/
│
├── ai-system/
│   ├── agents/
│   ├── config/
│   ├── lib/
│   │   └── providers/
│   ├── orchestrator/
│   └── schemas/
│
├── packages/
│   └── pricing/
│
├── infrastructure/
│   ├── caddy/
│   ├── docker/
│   ├── grafana/
│   ├── nginx/
│   ├── otel/
│   ├── prometheus/
│   └── terraform/
│
├── scripts/
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env.example
├── PROJECT_DETAILS.md
├── PROJECT_FLOW.md
└── package.json
```

---

# End-to-End Pipeline

The worker executes the pipeline through an ordered stage registry in:

```text
apps/worker/src/stages/index.ts
```

The main pipeline runner is:

```text
apps/worker/src/pipeline-runner.ts
```

## Stage order

| # | Stage | Main responsibility |
|---:|---|---|
| 1 | `TOPIC` | Generate and validate the topic/angle |
| 2 | `SCRIPT` | Generate the narration script |
| 3 | `HOOK` | Generate and score multiple hooks |
| 4 | `PREDICTION` | Predict CTR/retention before publication |
| 5 | `VOICE` | Select voice tier and synthesize narration |
| 6 | `TIMESTAMP` | Generate word timings and scene/subtitle spans |
| 7 | `VIDEO_SELECTION` | Retrieve and rank stock footage for scenes |
| 8 | `VIDEO` | Prepare clips, metadata, subtitles, and render final video |
| 9 | `THUMBNAIL` | Optional thumbnail generation |
| 10 | `DONE` | Finalize the run and optionally schedule upload |

Each stage owns its own validation, persistence, logging, event emission, and retry/resume behavior where applicable.

### Stage states

The database models pipeline execution using:

```text
QUEUED
TOPIC
SCRIPT
HOOK
PREDICTION
TIMESTAMP
VIDEO_SELECTION
VOICE
VIDEO
THUMBNAIL
DONE
FAILED
```

Run status is tracked independently as:

```text
QUEUED
RUNNING
COMPLETED
FAILED
```

This separation allows the system to answer both:

- **Where is the pipeline?**
- **What is the overall run state?**

---

# AI Agent System

The Python service exposes a registry-based agent runtime.

Main entrypoint:

```text
ai-system/main.py
```

Agent orchestration:

```text
ai-system/orchestrator/agent_runner.py
```

Agents are registered by name and dispatched through:

```http
POST /agents/{agent_name}/run
```

## Implemented agents

| Agent | Responsibility |
|---|---|
| `topic` | Generates a specific, shareable topic and angle |
| `script` | Writes duration-aware Shorts narration |
| `script_eval` | Scores script quality and identifies weaknesses |
| `hook` | Generates high-retention opening hooks |
| `viral_hook` | Generates additional CTR-focused hook ideas |
| `prediction` | Estimates CTR, retention, and overall performance |
| `retention_optimizer` | Rewrites scripts toward stronger retention |
| `voice` | Generates narration audio |
| `timestamp` | Converts narration timing into word/scene spans |
| `video_selection` | Selects stock footage for scenes |
| `video_meta` | Generates SEO-oriented title, description, and tags |
| `thumbnail` | Produces a thumbnail-generation prompt/image workflow |
| `feedback` | Converts analytics into actionable lessons |
| `editor_notes` | Produces editing guidance |
| `embeddings` | Exposed as an AI utility for semantic memory |
| `autocomplete` | Retrieves YouTube search suggestions used by metadata generation |

### AI schemas

Every major agent family has Pydantic input/output schemas under:

```text
ai-system/schemas/
```

This gives the AI layer a structured contract rather than passing arbitrary unvalidated blobs between components.

---

# AI Provider Routing and Fallbacks

The AI layer does not hard-code every task to a single provider.

Provider routing lives under:

```text
ai-system/lib/
ai-system/lib/providers/
```

Supported integrations visible in the current implementation include:

- OpenAI
- Google Gemini
- Groq
- OpenRouter

## Task-aware routing

The router defines provider candidates per task.

For example, content tasks may use a fallback chain similar to:

```text
Gemini → Groq → OpenRouter → OpenAI
```

while embeddings remain OpenAI-backed.

The provider router also tracks provider health and can prefer the healthiest provider among eligible candidates.

### Model-level fallback

Some tasks also have model-level fallback behavior within the same provider.

For example:

```text
OpenAI GPT-4o
      ↓ failure
OpenAI GPT-4o-mini
```

This is separate from cross-provider fallback.

### Why this architecture matters

It improves:

- resilience to provider outages
- latency under provider degradation
- cost control
- portability between model vendors
- operational flexibility

---

# Memory and Self-Improvement

The project implements two explicit performance-memory tables:

```text
TopicMemory
HookMemory
```

Each memory entry can contain:

- niche
- topic/hook text
- historical views
- CTR
- average view percentage
- normalized performance
- embedding vector
- source run

## Retrieval

The worker uses semantic similarity to find historically similar topics/hooks.

This lets future generations be influenced by:

- topics that previously performed well
- hooks that previously produced stronger results
- niche-specific patterns

## Admission

The system does not blindly store every generated result as a successful pattern.

Feedback and analytics are used to decide whether a run is strong enough to contribute learning signal.

## Topic deduplication

New topic generation can compare embeddings against prior topics to reduce repeated or highly similar ideas.

---

# Cost Intelligence and Agentic Optimization

One of the more advanced parts of the system is the cost-control layer.

It combines:

1. **Deterministic cost accounting**
2. **AI/heuristic analysis**
3. **LangGraph execution**

## Cost buckets

The platform tracks major AI-related cost areas such as:

- voice generation
- transcription / Whisper
- thumbnail generation
- LLM usage

Per-run cost records can include:

```text
provider
model
operation
prompt version
input tokens
output tokens
audio characters
audio seconds
cost USD
latency
```

## Cost analysis

The API exposes cost analysis for a run and can identify:

- the main cost driver
- expected performance direction
- recommended actions
- confidence
- iteration/loop state
- learning signal

## Possible control actions

The current control vocabulary includes:

```text
APPROVE_PIPELINE
REGENERATE_HOOK
MODIFY_SCRIPT
CHANGE_VOICE_TIER
SKIP_THUMBNAIL
CHANGE_TOPIC
```

## Agentic execution

The API cost controller builds a LangGraph workflow conceptually shaped like:

```text
loadContext
    ↓
selectAction
    ↓
mapExecution
    ↓
executeAction
```

When an action is executed, the system can reset a run to an appropriate stage and requeue pipeline work instead of manually reconstructing the run.

This is the foundation for a self-optimizing content loop where the platform attempts to improve the expected performance-per-dollar of a run.

---

# Background Jobs and Worker Model

Redis + BullMQ provide asynchronous execution.

The API creates jobs; workers consume them.

## Queues

The current codebase defines queues for:

- `videoQueue`
- `uploadQueue`
- `enrichmentQueue`
- `scheduleQueue`

## Worker roles

Workers can be run as:

```text
all
video
upload
enrichment
```

This allows the same codebase to be deployed as:

### Simple mode

One worker process consumes everything:

```text
WORKER_ROLE=all
```

### Split mode

Independent workers can specialize in:

```text
worker-video
worker-upload
worker-enrichment
```

This is particularly useful when video generation is CPU/network heavy while analytics and uploads have different latency profiles.

## Concurrency controls

Worker environment configuration exposes separate concurrency settings for:

- general worker jobs
- uploads
- enrichment
- video downloads
- clip preparation
- stage retries

---

# Media Pipeline

The media implementation is centered around:

```text
apps/worker/src/media/
```

## Clip preparation

The worker can:

1. download the selected source clip
2. normalize dimensions/orientation
3. trim or prepare the required section
4. store a scene-specific intermediate asset

## Final composition

Final composition is performed with FFmpeg.

The worker combines:

- narration
- scene clips
- subtitles
- video formatting
- metadata-related output

Target orientation:

```text
1080 × 1920
portrait
```

## Subtitle segmentation

When subtitle generation is enabled and word-level timestamps are available, the worker builds readable subtitle segments based on:

1. sentence boundaries
2. significant time gaps
3. word-count limits
4. duration limits

The implementation aims to preserve:

- chronological timestamps
- word order
- one-time word coverage
- non-overlapping subtitle intervals

Subtitle code:

```text
apps/worker/src/media/subtitles.ts
```

---

# YouTube Integration

The API starts the OAuth flow:

```http
GET /auth/youtube
```

and handles the callback:

```http
GET /auth/youtube/callback
```

Connection state:

```http
GET /auth/youtube/status
```

Disconnect:

```http
POST /auth/youtube/disconnect
```

Uploads are queued rather than performed directly inside the HTTP request path.

## Upload lifecycle

```text
Generated Video
      ↓
Upload Request
      ↓
uploadQueue
      ↓
Upload Worker
      ↓
YouTube Data API
      ↓
YouTube Video ID / URL
      ↓
Analytics Enrichment
```

Supported privacy values:

```text
PRIVATE
UNLISTED
PUBLIC
```

Uploads can also be scheduled.

## Token security

YouTube tokens are intended to be stored encrypted using an AES-256-GCM compatible 32-byte key represented as either:

- 64-character hex
- base64 encoding of 32 bytes

See:

```text
apps/api/src/lib/secret-crypto.ts
apps/worker/src/lib/secret-crypto.ts
```

---

# Analytics and Feedback Loop

After upload, the system can synchronize analytics.

The data model stores metrics including:

- views
- likes
- comments
- shares
- impressions
- CTR
- average view duration
- average view percentage
- watch time
- subscribers gained

These metrics feed the feedback agent.

## Feedback output

The feedback subsystem produces:

- `whatWorked`
- `whatDidnt`
- `suggestions`
- `performanceTag`

Those insights can then be used to improve future topic/hook memory.

This creates the full feedback loop:

```text
Generate
   ↓
Publish
   ↓
Observe
   ↓
Analyze
   ↓
Store learning signal
   ↓
Retrieve similar successful patterns
   ↓
Generate better next run
```

---

# Database

The backend uses PostgreSQL with Prisma.

Schema:

```text
apps/api/prisma/schema.prisma
```

## Main models

| Model | Purpose |
|---|---|
| `PipelineRun` | Central run state and pipeline lifecycle |
| `Topic` | Generated topic and embedding |
| `Script` | Final narration script |
| `HookVariant` | Alternative hook variants and scores |
| `VoiceAsset` | Generated audio metadata |
| `Scene` | Scene timeline and clip information |
| `Video` | Final rendered video metadata |
| `AgentLog` | Agent-level execution history |
| `AiCostRecord` | AI provider/model cost accounting |
| `AiCache` | Cached AI outputs |
| `YouTubeAccount` | Connected YouTube channel tokens/state |
| `YouTubeUpload` | Upload lifecycle |
| `VideoAnalytics` | Per-video analytics snapshots |
| `PerformancePrediction` | Pre-publication prediction |
| `FeedbackInsight` | Post-publication feedback |
| `TopicMemory` | Long-term topic memory |
| `HookMemory` | Long-term hook memory |
| `PipelineSchedule` | Scheduled pipeline generation |
| `User` | Application user |
| `Otp` | Email OTP verification |
| `CreditPackage` | Monetization packages |
| `CreditTransaction` | Credit ledger |
| `Payment` | Stripe/Razorpay payment records |

### Enums

The schema also models explicit states for:

- pipeline stages
- run status
- agent log status
- upload status
- upload privacy
- transaction type
- payment provider
- payment status

---

# API

The Express API is split into routes, controllers, services, repositories, queues, validators, and integrations.

Base URL in local Docker development:

```text
http://localhost:4000
```

## Pipeline endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/pipeline/run` | Create a pipeline run |
| `POST` | `/pipeline/batch` | Create multiple runs |
| `GET` | `/pipeline` | List runs |
| `GET` | `/pipeline/:id` | Run details |
| `GET` | `/pipeline/:id/logs` | Agent logs |
| `GET` | `/pipeline/:id/experiment` | Hook experiment state |
| `POST` | `/pipeline/:id/retry` | Retry a failed run |
| `POST` | `/pipeline/:id/cancel` | Cancel a run |
| `GET` | `/pipeline/:id/stream` | SSE run updates |

The list endpoint supports pagination with:

```text
?page=1&pageSize=20
```

## Upload endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/pipeline/:id/upload` | Queue upload |
| `GET` | `/pipeline/:id/upload` | Upload status |

## Analytics endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/pipeline/:id/analytics` | Run analytics + feedback |
| `POST` | `/pipeline/:id/analytics/sync` | Queue enrichment for one run |
| `POST` | `/analytics/sync` | Queue enrichment for uploaded runs |
| `GET` | `/analytics/channel?days=7` | Channel analytics |

The channel dashboard supports common windows such as:

```text
7
28
90
365
```

## Cost endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/cost/run/:id` | Current cost + analysis |
| `GET` | `/cost/run/:id/history` | Cost timeline + latest analysis |
| `POST` | `/cost/run/:id/execute` | Execute a cost-control action |
| `GET` | `/cost/cache/stats` | Cost-analysis cache stats |

Useful query parameters include:

```text
refreshAnalysis=true
limit=100
```

## Schedule endpoints

The schedule service supports creation, listing, reading, and deletion of recurring pipeline schedules.

## AI service endpoints

Health:

```http
GET /health
```

Embeddings:

```http
POST /embeddings
```

Generic agent execution:

```http
POST /agents/{agent_name}/run
```

---

# Web Dashboard

The frontend is a Next.js 14 application using React 18, React Query, and Tailwind CSS.

Main areas include:

```text
/login
/
/runs
/analytics
/schedules
/pricing
/payment
```

The dashboard contains components for:

- run status
- upload actions
- analytics
- prediction
- hook experiments
- cost analysis
- feedback
- asset actions

The UI consumes the Express API rather than talking directly to the AI service.

---

# Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Never commit `.env`.

## Core infrastructure

```dotenv
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
AI_SERVICE_URL=http://ai:8000
API_PORT=4000
STORAGE_PATH=/storage
PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

## LLM providers

The AI system can consume credentials for:

```dotenv
OPENAI_API_KEY=...
GOOGLE_API_KEY=...
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
```

The root `.env.example` also contains cost-analysis controls such as:

```dotenv
OPENAI_MODEL_COST_ANALYSIS=gpt-4o-mini
ENABLE_LANGCHAIN_COST_ANALYSIS=true
ENABLE_AGENTIC_COST_AUTOPILOT=true
```

## Voice

```dotenv
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

## Stock video

```dotenv
PEXELS_API_KEY=...
```

## YouTube

```dotenv
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REDIRECT_URI=http://localhost:4000/auth/youtube/callback
YOUTUBE_TOKEN_ENCRYPTION_KEY=...
```

## Payments

The application also contains Stripe and Razorpay integrations:

```dotenv
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...

RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

## SMTP / OTP

```dotenv
SMTP_HOST=smtp.zoho.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
```

## Feature flags

Examples from the current environment contract:

```dotenv
ENABLE_THUMBNAIL_AGENT=false

ENABLE_HOOK_AB_TESTING=true
HOOK_AB_VARIANTS=3
HOOK_AB_AUTO_UPLOAD=true
HOOK_AB_UPLOAD_PRIVACY=PRIVATE

AUTO_UPLOAD_ON_PIPELINE_DONE=false
AUTO_UPLOAD_PRIVACY=PUBLIC
AUTO_UPLOAD_DELAY_MINUTES=0
```

The worker environment additionally supports provider/cache/retry flags and worker-role controls.

---

# Local Development

## Prerequisites

Recommended:

- Node.js `>= 20`
- npm
- Python `3.12` for the AI service
- PostgreSQL
- Redis
- FFmpeg
- Docker + Docker Compose

Optional/required depending on the features you use:

- OpenAI credentials
- Gemini/Groq/OpenRouter credentials
- ElevenLabs credentials
- Pexels credentials
- YouTube OAuth credentials
- Stripe/Razorpay credentials
- SMTP credentials

## Install Node dependencies

From the repository root:

```bash
npm install
```

## Install Python dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r ai-system/requirements.txt
```

On Windows:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r ai-system/requirements.txt
```

## Generate Prisma client

```bash
npm run prisma:generate
```

## Apply local schema

For normal Prisma development:

```bash
npm run prisma:migrate
```

The Docker development stack currently uses:

```bash
npx prisma db push
```

inside the API container to synchronize a local database quickly.

---

# Start Services Manually

Run each service from the monorepo root.

### API

```bash
npm run dev:api
```

### Worker

```bash
npm run dev:worker
```

### Web

```bash
npm run dev:web
```

### AI service

```bash
cd ai-system
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Then open:

```text
http://localhost:3000
```

---

# Docker Development

The simplest fully integrated path is Docker Compose.

## Bootstrap

```bash
./scripts/bootstrap.sh
```

or manually:

```bash
cp .env.example .env
docker compose up --build
```

## Local service ports

| Service | Port |
|---|---:|
| Web | `3000` |
| API | `4000` |
| AI | `8000` |
| PostgreSQL | `5432` |
| Redis | `6379` |
| Prometheus | `9090` |
| Grafana | `3001` |
| OTLP gRPC | `4317` |
| OTLP HTTP | `4318` |

## Split-worker mode

The Compose file contains optional specialized worker services.

Start them with:

```bash
docker compose --profile split-workers up -d
```

In split mode, run the required specialized workers instead of the default all-in-one worker.

---

# Production Deployment

The project includes production-oriented Docker and AWS/Terraform assets.

## Infrastructure

Terraform configuration covers components such as:

- VPC/networking
- EC2
- security groups
- IAM
- S3
- backend/state configuration

Key files:

```text
infrastructure/terraform/
```

## Production Compose

The repository contains:

```text
docker-compose.prod.yml
```

The production composition includes:

- application services
- PostgreSQL
- Redis
- storage
- reverse proxy
- Prometheus
- Grafana
- OpenTelemetry Collector
- database backup service
- Watchtower-based image refresh

## Deployment flow

The CD workflow runs after successful CI and uses AWS Systems Manager (SSM) to update the EC2 deployment.

High-level flow:

```text
Git push
   ↓
CI
   ├── Node checks
   ├── Prisma validation
   ├── Python checks
   └── Docker image build/push
              ↓
           CI success
              ↓
           CD workflow
              ↓
        AWS SSM command
              ↓
        Pull new images
              ↓
     docker compose up -d
```

---

# Observability

The project includes a real observability stack.

## OpenTelemetry

Instrumentation is present across the Node and Python services.

The collector accepts:

```text
4317  OTLP gRPC
4318  OTLP HTTP
```

Configuration:

```text
infrastructure/otel/otel-collector-config.yaml
```

## Prometheus

Prometheus scrapes metrics from:

- OpenTelemetry Collector
- PostgreSQL exporter
- Node exporter
- cAdvisor

Configuration:

```text
infrastructure/prometheus/prometheus.yml
```

## Grafana

Grafana is included for dashboarding and operational inspection.

---

# Testing

The project contains automated tests for important backend/worker behavior.

### API tests

Located under:

```text
apps/api/tests/
```

Examples include:

- upload service behavior
- pipeline service behavior

Run:

```bash
npm run test:api
```

### Worker tests

Located under:

```text
apps/worker/tests/
```

Examples include:

- pipeline runner
- script stage
- subtitle/media behavior

Run:

```bash
npm run test:worker
```

### AI/static checks

The CI workflow performs:

- Ruff checks
- Python compilation
- dependency installation
- Pydantic schema import validation

---

# CI/CD

GitHub Actions configuration lives under:

```text
.github/workflows/
```

## CI workflow

The CI pipeline currently checks:

### Node side

- npm workspace installation
- Prisma generation
- API typecheck
- worker typecheck
- web lint
- web build

### Prisma side

- schema validation
- Prisma formatting

### Python side

- Ruff critical checks
- full Python compilation
- dependency installation
- schema imports

### Docker

On successful main-branch CI, the workflow builds/pushes images for:

```text
automation-api
automation-web
automation-worker
automation-ai
```

to GitHub Container Registry.

## CD workflow

The deployment workflow:

- waits for successful CI
- authenticates to AWS
- invokes SSM on EC2
- pulls the latest images
- restarts the production Compose stack

---

# Scaling

The architecture intentionally separates:

```text
HTTP API
Background computation
AI inference
Uploads
Analytics
Storage
```

This enables independent scaling.

## Example scaling strategies

### Scale video generation

Increase the number of:

```text
WORKER_ROLE=video
```

workers.

### Scale uploads

Run dedicated:

```text
WORKER_ROLE=upload
```

workers with independent concurrency.

### Scale enrichment

Run:

```text
WORKER_ROLE=enrichment
```

workers separately, especially when analytics sync workloads become large.

### Scale AI

The FastAPI service can be horizontally replicated behind a load balancer while provider routing handles model selection and fallback.

### Scale storage

Use S3-compatible storage instead of local disk for durable generated artifacts.

The codebase already contains S3 integration helpers in the API/worker layers.

---

# Failure Recovery and Reliability

Reliability is built around asynchronous jobs, persisted stage state, and controlled retries.

## Stage-aware retries

Workers track stage failure state and retry counts.

The database stores:

```text
stageRetryCounts
failedStage
stageFailureReason
stageFailureMeta
```

This allows failures to be diagnosed at the exact pipeline stage.

## Resume behavior

Generated stage artifacts are persisted and can be reused instead of recomputing all previous work.

## Non-fatal optimizations

Some stages intentionally fail soft.

Examples:

- prediction can fall back to neutral/advisory values
- thumbnail generation is non-fatal
- premium voice generation can fall back to OpenAI TTS

This prevents optional enhancements from unnecessarily destroying an otherwise valid video run.

## Cancellation

Users can cancel queued/running work through:

```http
POST /pipeline/:id/cancel
```

Workers check cancellation state before continuing expensive work.

---

# Security Notes

### Secrets

Keep all secrets in environment variables or your production secret-management system.

Never commit:

```text
.env
private keys
OAuth credentials
provider API keys
payment secrets
```

### YouTube tokens

YouTube tokens are intended to be encrypted at rest.

When YouTube OAuth is configured, the application requires:

```text
YOUTUBE_TOKEN_ENCRYPTION_KEY
```

to be a valid 32-byte value encoded as hex or base64.

### Authentication

The application contains:

- JWT-based application authentication helpers
- email OTP support
- protected API middleware
- OAuth state handling for YouTube

### Production hardening

Before public deployment, replace development defaults such as the development JWT secret and review CORS, rate limits, reverse-proxy configuration, payment webhooks, and cloud IAM permissions.

---

# Known Limitations

These are important when evaluating or extending the current repository.

### YouTube thumbnail restrictions

The thumbnail stage is feature-flagged by default because YouTube custom-thumbnail behavior can depend on channel verification.

```dotenv
ENABLE_THUMBNAIL_AGENT=false
```

### Local media storage

Local development mounts:

```text
./storage:/storage
```

Production deployments should prefer durable object storage for generated assets and backups.

### Provider credentials are external dependencies

The system can route/fallback across providers, but the underlying providers still require valid credentials and sufficient quota.

### Automated uploads are intentionally configurable

The repository exposes:

```dotenv
AUTO_UPLOAD_ON_PIPELINE_DONE=false
```

by default, reducing the chance that a development run unexpectedly publishes publicly.

### License

The current project documentation describes the repository as an internal project. Add an explicit open-source license before public redistribution.

---

# Project Documentation

The repository already contains detailed engineering documentation in addition to this README.

### `PROJECT_DETAILS.md`

High-level engineering overview covering:

- architecture
- tech stack
- pipeline
- database
- agents
- cost/self-improvement
- scaling considerations

### `PROJECT_FLOW.md`

Detailed runtime/code map covering:

- service boot flow
- run creation
- queue topology
- event topology
- full pipeline lifecycle
- upload flow
- analytics/memory loop
- file-by-file responsibilities

These files are especially useful when onboarding contributors who need to understand why the repository is divided into multiple services.

---

# Common Development Commands

From the repository root:

```bash
# Install
npm install

# Start API
npm run dev:api

# Start worker
npm run dev:worker

# Start web
npm run dev:web

# Build all workspaces
npm run build

# API tests
npm run test:api

# Worker tests
npm run test:worker

# Prisma client
npm run prisma:generate

# Prisma migrations
npm run prisma:migrate
```

## Smoke test

After the API and worker are running:

```bash
./scripts/smoke.sh
```

You can provide a niche:

```bash
./scripts/smoke.sh "productivity hacks"
```

The smoke script:

1. creates a pipeline run
2. polls its status
3. waits for `COMPLETED` or `FAILED`
4. prints the final generated video path

---

# Example Runtime Flow

A typical run looks like this:

```text
1. User enters:
   niche = "productivity"
   language = "en"
   duration = ~75 sec

2. API:
   creates PipelineRun
   charges/records credits when applicable
   queues video work

3. Worker:
   TOPIC
      ↓
   SCRIPT
      ↓
   HOOK
      ↓
   PREDICTION
      ↓
   VOICE
      ↓
   TIMESTAMP
      ↓
   VIDEO_SELECTION
      ↓
   VIDEO
      ↓
   THUMBNAIL (optional)

4. Worker:
   persists final video

5. Optional:
   upload to YouTube

6. Later:
   analytics synchronization

7. Feedback:
   analytics → feedback agent → memory

8. Future runs:
   topic/hook retrieval influences generation

9. Cost controller:
   evaluates expected value vs. cost
   and may request a targeted regeneration/action
```

---

# Design Principles

The current architecture follows a few strong principles:

### 1. Keep expensive work asynchronous

Video generation, uploads, enrichment, and scheduled execution use queues instead of blocking HTTP requests.

### 2. Persist intermediate state

The system records stage state, artifacts, agent logs, and cost data so work can be inspected and resumed.

### 3. Keep AI behind contracts

Pydantic schemas and TypeScript validators prevent the AI layer from becoming an unstructured black box.

### 4. Make provider failure survivable

AI tasks can use provider/model fallback strategies rather than depending entirely on a single vendor.

### 5. Separate generation from learning

A generated video is one event. The long-term intelligence comes from analytics, feedback, memory admission, and retrieval.

### 6. Optimize cost and quality together

The system does not treat lower cost as automatically better. Its controller considers expected CTR/retention alongside normalized spend.

---

# Contributing

When adding a new pipeline capability, prefer the existing architectural boundaries.

For example:

```text
New AI capability
    ↓
ai-system/agents/<name>
ai-system/schemas/<name>_schema.py
    ↓
Register in orchestrator/agent_runner.py
    ↓
Call from worker stage
    ↓
Persist output in Prisma where appropriate
    ↓
Expose through API/UI only when necessary
```

For a new worker stage:

```text
apps/worker/src/stages/<name>.stage.ts
```

and add it to:

```text
apps/worker/src/stages/index.ts
```

For new HTTP functionality:

```text
route
  ↓
controller
  ↓
service
  ↓
repository/integration
```

This keeps the service boundaries consistent with the existing codebase.

---

# License

The repository currently describes itself as an internal project.

Before publishing or redistributing it as open source, add a concrete license file such as:

```text
LICENSE
```

and document any third-party asset/API usage requirements.

---

## Built With

**Frontend**

- Next.js 14
- React 18
- Tailwind CSS
- TanStack React Query

**Backend**

- Node.js 20+
- TypeScript
- Express
- Prisma
- PostgreSQL
- Redis
- BullMQ

**AI**

- FastAPI
- Pydantic
- OpenAI
- Google Gemini
- Groq
- OpenRouter
- LangChain / LangGraph

**Media**

- FFmpeg
- ElevenLabs
- Pexels

**Distribution**

- YouTube Data API / OAuth

**Payments**

- Stripe
- Razorpay

**Infrastructure**

- Docker Compose
- Terraform
- AWS EC2
- AWS S3
- GitHub Actions
- Prometheus
- Grafana
- OpenTelemetry

---

## Repository

[Automation-Videos-Yt/Automation](https://github.com/Automation-Videos-Yt/Automation)
