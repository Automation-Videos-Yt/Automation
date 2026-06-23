# AI Automation - Folder and File Structure Guide

This document breaks down the monorepo structure, explaining the responsibility of each directory and key file so you can confidently explain the codebase during technical interviews.

## 1. The Root Directory (Infrastructure & Config)
* **Responsibility**: Orchestration and shared tooling.
* `docker-compose.yml`: Spins up 6 containers: Postgres (Database), Redis (Queues & Events), API (Express), Worker (Node.js), Web (Next.js), and AI-System (FastAPI). Shows you understand containerization.
* `package.json`: Contains the `workspaces` array linking `apps/api`, `apps/worker`, and `apps/web`. Proves you know how to manage Monorepos.

## 2. `apps/api` (The Traffic Controller)
* **Responsibility**: The central nervous system. It never does heavy lifting itself; it simply validates requests, writes to Postgres, and pushes jobs to Redis.
* `src/index.ts` & `src/app.ts`: The Express server setup. Initializes the REST routes and the Server-Sent Events (SSE) bus.
* `prisma/schema.prisma`: **Crucial File.** Defines the Postgres database. The `PipelineRun` is the main hub table, and everything else (Topics, Scripts, Videos, AgentLogs) has a relationship pointing back to it.
* `src/routes/` & `src/controllers/`: Maps incoming HTTP requests to controller logic. 
* `src/services/pipeline.service.ts`: Handles the business logic of creating a run. Saves state to DB and pushes a job to the `videoQueue`.
* `src/services/cost-agent.service.ts`: The LangGraph integration. Contains a state machine that analyzes pipeline costs and dynamically alters execution paths to save money.
* `src/events/bus.ts`: Subscribes to Redis events coming from the workers and pipes them to the frontend via Server-Sent Events (SSE).

## 3. `apps/worker` (The Heavy Lifter)
* **Responsibility**: Processes heavy jobs asynchronously to prevent the main API from timing out.
* `src/index.ts`: Connects to Redis and starts listening to the `videoQueue`, `uploadQueue`, and `enrichmentQueue`.
* `src/pipeline-runner.ts`: **The Core Execution Loop.** Iterates through the 9 stages of making a video (`TOPIC` -> `SCRIPT` -> `HOOK` -> `VOICE` -> etc). It relies on a `StageContext` cache for fault tolerance.
* `src/stages/`: Contains individual, isolated files for every pipeline step (e.g., `script.stage.ts`, `video.stage.ts`). This modular design allows swapping out implementations (like changing thumbnail generators) without breaking the whole pipeline.
* `src/media/`: Contains the FFmpeg logic (`clipDownload.ts` and `compose.ts`). Spawns child processes to download clips, cut them to Whisper timestamps, burn subtitles, and merge audio.
* `src/memory/vectorStore.ts`: Calculates Cosine Similarity between successful past videos and the current prompt to feed the AI context.

## 4. `ai-system` (The Brain)
* **Responsibility**: A Python FastAPI microservice that handles all complex AI, LLM, and math operations, leveraging Python's superior AI ecosystem.
* `main.py`: The FastAPI server entry point.
* `agents/`: Contains specialized sub-folders for each AI task:
  * `timestamp/agent.py`: Uses OpenAI's Whisper to get exact millisecond timings for every spoken word.
  * `hook/agent.py`: Generates multiple hook variants and scores them.
  * `prediction/agent.py`: Analyzes the script and predicts the CTR and retention.
* `lib/embeddings.py`: Converts text into number vectors (`text-embedding-3-small`) so the system can perform semantic searches.

## 5. `apps/web` (The User Interface)
* **Responsibility**: A Next.js 14 React app providing a real-time dashboard for the user.
* `app/page.tsx`: The main input form for niche and duration.
* `app/runs/[id]/page.tsx`: The detailed view of a single video generation run. This page listens to the SSE stream from `apps/api` to instantly update the UI as the worker moves through pipeline stages.
* `components/`: Reusable UI elements like `UploadCard` (triggers YouTube upload API) and `AnalyticsCard` (shows views/CTR fetched from YouTube).
