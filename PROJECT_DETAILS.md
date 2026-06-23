# AI YouTube Automation - Comprehensive Project Overview

## 1. Executive Summary
This project is an autonomous, self-improving, and cost-aware pipeline for generating short-form YouTube content. The system takes a niche as input, generates all necessary assets (topic, script, hook, voiceover, stock footage, timestamps), compiles them into a final video using FFmpeg, and automatically uploads it to YouTube. Crucially, the system features a self-improving memory loop: it fetches post-upload YouTube analytics, evaluates performance, and stores strong hooks and topics in a vector database to continuously improve future generations.

## 2. System Architecture & Tech Stack
The project is built as a monorepo consisting of four primary services orchestrated via Docker Compose, backed by PostgreSQL and Redis.

### Technologies:
- **Frontend**: Next.js 14, React Query, TailwindCSS
- **Backend API**: Node.js, Express, Prisma ORM
- **Queue System**: BullMQ (Redis)
- **AI Microservice**: Python, FastAPI, LangChain, LangGraph
- **Media Processing**: FFmpeg
- **External APIs**: OpenAI, ElevenLabs, Pexels, YouTube Data/Analytics APIs

### Service Topology:
1. **`apps/web` (Port 3000)**: A React/Next.js dashboard for creating runs, tracking live pipeline progress via Server-Sent Events (SSE), and viewing cost and performance analytics.
2. **`apps/api` (Port 4000)**: The central Express REST API. Handles run creation, writes to PostgreSQL, queues jobs in BullMQ, and streams real-time Redis events to the frontend via SSE.
3. **`apps/worker`**: Background node processes consuming BullMQ queues (`videoQueue`, `uploadQueue`, `enrichmentQueue`). Executes the heavy lifting: downloading clips, running FFmpeg, and uploading to YouTube.
4. **`ai-system` (Port 8000)**: A Python FastAPI service that hosts specific AI agents for text generation, embeddings, audio, and decision-making logic.

## 3. Monorepo Structure

```text
ai_automation_videos/
├── apps/
│   ├── api/          # Express REST API, Prisma schema, queue producers, SSE streaming
│   ├── web/          # Next.js user interface and dashboards
│   └── worker/       # BullMQ consumers, stage-based generation pipeline, FFmpeg media processing
├── ai-system/        # Python FastAPI microservice hosting specialized AI agents
├── infrastructure/   # Dockerfiles for all services
├── scripts/          # Bash scripts for bootstrapping and smoke testing
├── storage/          # Local file storage for intermediate clips, audio, and final MP4s
├── docker-compose.yml# Main orchestration configuration
└── package.json      # Monorepo workspaces definition
```

## 4. Pipeline Stages & End-to-End Flow
The core video generation occurs in the `worker` service through a sequential pipeline. The pipeline uses aggressive caching (`StageContext.cache`), meaning if a stage fails, the system can resume from the exact point of failure on the next retry.

**Stage Execution Order:**
1. **`TOPIC`**: Queries AI for a topic idea based on past successful memories.
2. **`SCRIPT`**: Generates a duration-aware script.
3. **`HOOK`**: Generates multiple hook variants and A/B tests them, picking the highest scorer.
4. **`PREDICTION`**: Predicts the expected CTR and retention score of the script.
5. **`VOICE`**: Generates Text-to-Speech (TTS). Uses premium voices for high-score predictions and economy voices for lower scores.
6. **`TIMESTAMP`**: Uses Whisper AI to generate word-level timestamps and group them into subtitle segments.
7. **`VIDEO_SELECTION`**: Translates script scenes into visual queries and fetches matching stock clips from Pexels.
8. **`VIDEO`**: The FFmpeg stage. Downloads clips, resizes/crops them, applies subtitles, merges the TTS audio, and renders the final MP4.
9. **`THUMBNAIL`**: Feature-flagged AI image generation for custom YouTube thumbnails.

## 5. Database Schema & Data Models
The system uses PostgreSQL, modeled via Prisma (`apps/api/prisma/schema.prisma`).

**Core Models:**
- `PipelineRun`: The central hub record that tracks status (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`).
- **Asset Models (1-to-1/1-to-N with PipelineRun)**: `Topic`, `Script`, `HookVariant`, `VoiceAsset`, `Scene`, `Video`, `AgentLog`.
- **Publishing Models**: `YouTubeAccount` (singleton OAuth store), `YouTubeUpload` (status of API upload).
- **Analytics & Learning Models**:
  - `VideoAnalytics`: Snapshots of YouTube performance (views, CTR, watch time).
  - `PerformancePrediction`: Pre-upload AI expectation scores.
  - `FeedbackInsight`: Post-upload AI analysis (what worked, what didn't).
  - `TopicMemory` & `HookMemory`: Vector-embedded records of successful runs used to bias future generations.

## 6. AI Agents & Intelligent Subsystems (`ai-system/agents/`)
The Python backend isolates specific tasks into discrete "agents":
- `topic`, `script`, `hook`: Text generation agents.
- `prediction`: Estimates CTR/retention.
- `voice`: Interfaces with ElevenLabs/OpenAI TTS.
- `timestamp`: Interfaces with Whisper for precise subtitle timings.
- `video_selection` & `video_meta`: Scene logic and SEO generation.
- `feedback`: Synthesizes analytics into actionable tags ("strong", "mid", "weak").
- `retention_optimizer`: Refines scripts for audience retention.

## 7. Cost Analysis & Self-Improving Memory
The system is built to minimize API burn and maximize video performance:
- **Cost Autopilot**: Evaluates pipeline outputs and run-level costs. If expected ROI is low, it executes a LangGraph workflow to autonomously requeue and regenerate specific parts of the pipeline (e.g., rewriting the hook or changing the voice tier).
- **Vector Memory**: Once a video hits 10+ views and 2%+ CTR, it is admitted to memory. New runs embed their niche, query the vector database via Cosine Similarity, and inject the top 3 historical successes into the LLM context prompt.

## 8. Areas for Improvement & Scaling Strategies
As the project grows, several architectural and feature enhancements can be made:

1. **Storage Decoupling**: Move away from local `/storage` Docker volumes to Amazon S3 or Cloudflare R2. This allows worker nodes to be distributed across multiple physical servers.
2. **Kubernetes Auto-Scaling**: Video rendering is CPU-heavy. Moving from Docker Compose to K8s allows spinning up FFmpeg worker pods dynamically based on queue depth.
3. **Cost Reduction via Local Inference**: Run Whisper (e.g., `faster-whisper`) and TTS locally on the worker nodes instead of paying per-minute API fees to OpenAI/ElevenLabs.
4. **Multi-Platform Uploads**: Extend `uploadQueue` to target TikTok, Instagram Reels, and Pinterest automatically.
5. **Interactive Editor**: Add a "Human-in-the-Loop" pause feature in the Next.js UI, allowing users to manually tweak scripts or swap Pexels clips before FFmpeg locks the final render.
6. **Unique B-Roll Generation**: Integrate APIs like Runway Gen-2 or Luma to generate 100% custom AI video instead of relying on generic Pexels stock footage.
7. **Multi-Tenant SaaS Architecture**: Implement Clerk/NextAuth and assign `YouTubeAccount` records to specific User IDs to transition this from a personal tool to a B2B SaaS.
