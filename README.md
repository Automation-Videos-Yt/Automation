# AI YouTube Automation

Autonomous, self-improving, cost-aware content pipeline. Niche in → Shorts-ready video out → YouTube upload → analytics back into memory → next run is better.

**Current pipeline:**
`Topic (memory + dedup) → Script → Hook (memory, variants + self-rank) → Prediction → Voice (smart-tiered) → Timestamp (Whisper) → Video Selection (Pexels) → Video (autocomplete SEO, parallel render) → [Thumbnail, off by default] → [Upload (manual or scheduled)] → [Analytics → Feedback → Memory]`

## Architecture

```
Next.js ─► Node API ─► BullMQ (Redis) ─► 3 Workers ─► Python AI / Pexels / OpenAI / YouTube
   ▲  ▲          │     videoQueue          │
   │  │          │     uploadQueue         ├─► FFmpeg, ElevenLabs/OpenAI TTS, gpt-image-1
   │  │          │     enrichmentQueue     │
   │  │          └────► Postgres ◄─────────┘
   │  │                 (runs, analytics, feedback,
   │  │                  TopicMemory + HookMemory,
   │  │                  PerformancePrediction,
   │  │                  titleEmbedding for dedup)
   │  │
   │  └──── Redis pub/sub: pipeline:events
   │           ▲
   └──── SSE: GET /pipeline/:id/stream (live, no polling)

    + node-cron in worker: auto-sync analytics on a schedule
```

- `apps/web` — Next.js 14 dashboard, React Query + SSE
- `apps/api` — Express + Prisma, BullMQ producers, OAuth, SSE, analytics endpoints
- `apps/worker` — 3 workers (video pipeline, YouTube upload, analytics enrichment) + cron scheduler
- `ai-system` — FastAPI host for 10 agents + `/embeddings`

## Quick start

```bash
cp .env.example .env
# fill OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, PEXELS_API_KEY,
# YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET
docker compose up --build
open http://localhost:3000
```

1. **Connect YouTube** (top right) — needs `youtube.upload` + `youtube.readonly` + `yt-analytics.readonly`.
2. Enter a niche, pick duration, select one or more output languages, and choose batch size (1/3/5/10) → watch stages light up **in real time** (SSE push).
3. Preview video → pick privacy → **Upload**.
4. **Analytics** tab (new) — channel-level dashboard: subs, views, watch time, top videos, time-series charts over 7/28/90/365 days.
5. Per-run analytics: **Sync now** on the run page (or let the cron handle it) → metrics, AI feedback, memory admission.
6. Future runs auto-retrieve similar past topics + hooks and bias toward what performed.

### Run split workers (optional)

By default, one `worker` process consumes all queues. For better throughput and tighter control, run dedicated worker roles:

```bash
# start only dedicated split workers
docker compose --profile split-workers up -d worker-video worker-upload worker-enrichment

# scale heavy video workers independently
docker compose --profile split-workers up -d --scale worker-video=2 worker-video worker-upload worker-enrichment
```

Worker roles are selected via `WORKER_ROLE=all|video|upload|enrichment`.

## Pipeline stages

| Stage             | Agent                  | Cache source                          | Notes                                                                                                                                                   |
| ----------------- | ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOPIC`           | topic (memory + dedup) | `Topic` row                           | top-3 `TopicMemory` as `past_topics`; retries up to 3× with `exclude_titles` if generated title cosine-matches a past `Topic.titleEmbedding` above 0.85 |
| `SCRIPT`          | script                 | `Script` row                          | model fallback `gpt-4o → gpt-4o-mini`; duration-aware (10–180s)                                                                                         |
| `HOOK`            | hook (memory)          | `HookVariant[]` rows                  | top-3 `HookMemory` as `past_hooks` + N variants, self-ranked                                                                                            |
| `PREDICTION`      | prediction             | `PerformancePrediction` row           | drives voice + thumbnail tiering; neutral default on failure                                                                                            |
| `VOICE`           | voice                  | `VoiceAsset` + mp3 file               | tier: `premium` (tts-1-hd), `economy` (tts-1), or `elite` (ElevenLabs, opt-in)                                                                          |
| `TIMESTAMP`       | timestamp              | last SUCCESS `AgentLog`               | Whisper word-level alignment                                                                                                                            |
| `VIDEO_SELECTION` | video_selection        | `Scene[]` rows                        | LLM queries → Pexels portrait clips                                                                                                                     |
| `VIDEO`           | video_meta + worker    | file checks on every clip + final mp4 | autocomplete SEO + concurrent render                                                                                                                    |
| `THUMBNAIL`       | thumbnail              | png file on disk                      | **off by default** (see flag below)                                                                                                                     |

Short videos (`target_duration_sec < 30`) automatically use 4s scene chunks instead of 7.5s so the cut cadence stays lively.

## Cost per video

Tier driven by `prediction.score` (0–10):

| Tier               | Voice            | Thumbnail (when enabled) | Video + metadata | **Total**   |
| ------------------ | ---------------- | ------------------------ | ---------------- | ----------- |
| **Strong** (≥ 7.5) | tts-1-hd ~$0.033 | 1536×1024 medium ~$0.07  | ~$0.02           | **~$0.13**  |
| Mid (5 – 7.5)      | tts-1 ~$0.015    | 1024×1024 medium ~$0.04  | ~$0.02           | **~$0.075** |
| Weak (< 5)         | tts-1 ~$0.015    | 1024×1024 low ~$0.02     | ~$0.02           | **~$0.055** |

With thumbnails off (default): **~$0.06 strong / ~$0.04 mid / ~$0.035 weak** per run.

The per-run estimate lives on the run header — hover for the voice / whisper / thumbnail / llm breakdown. Source: [apps/api/src/services/cost.service.ts](apps/api/src/services/cost.service.ts).

When `ENABLE_LANGCHAIN_COST_ANALYSIS=true` and `OPENAI_API_KEY` is set, the API also attaches a lightweight AI optimization analysis (`cost.analysis`) generated via LangChain using `OPENAI_MODEL_COST_ANALYSIS`.

`elite` tier (ElevenLabs) is wired in but not auto-selected — opt in via direct agent call when you want premium narration.

## Self-improving feedback loop

```
Upload → YouTube Analytics snapshot ─► Feedback agent ─► TopicMemory
                                              │          HookMemory
                                              ▼
                                     Next run: Topic + Hook
                                     agents retrieve top-3
                                     similar past runs and
                                     bias toward "strong" tags
```

- **Embeddings:** `text-embedding-3-small` (1536d) as `Float[]` on the row, app-side cosine similarity. Fine up to ~10k rows.
- **Admission thresholds** (`vectorStore.ts`): `views ≥ 10 AND ctr ≥ 2%`.
- **Similarity floors:** retrieval `> 0.15`, dedup `≥ 0.85`.
- **Performance score:** `0.6 × (ctr/10) + 0.4 × (avp/100)`, clipped to [0,1]. CTR is stored in percent form (0–100) across the whole codebase — normalized from YouTube's 0–1 decimal at ingestion.

## Duplicate-topic guard

Before committing a run's topic:

1. Topic agent generates `{title, angle, ...}`.
2. Worker embeds `"title. angle"` and cosine-compares against every past `Topic.titleEmbedding`.
3. If any match ≥ 0.85, the agent re-runs with an explicit `exclude_titles` list. Up to 3 attempts, then the last output is accepted.
4. The embedding is persisted on the new `Topic` row for the next run to check against.

This naturally spreads batch runs (`×5`, `×10`) apart: each new run sees the just-created siblings and is steered elsewhere.

## Live events (SSE)

Worker publishes to Redis `pipeline:events` on:

- every stage transition (via `advanceStage()` helper)
- pipeline DONE / FAILED
- upload RUNNING / COMPLETED / FAILED
- analytics snapshot persisted, feedback insight persisted

API runs one Redis subscriber, fans into an in-process EventEmitter, and exposes **`GET /pipeline/:id/stream`** as SSE. Frontend `useRunEvents` invalidates the relevant React Query caches on every push. Polling demoted to a 10s fallback.

## Resume-from-last-success

Every stage output is persisted (DB row and/or file on disk). On any failure, run stays `FAILED` with a red **Retry from last success** button. Clicking it re-enters the pipeline; cached stages log `stage=X skipped (cached)` and only the broken step plus anything downstream re-runs.

Saves:

- Pexels downloads (per-scene file check)
- FFmpeg per-scene prep + final concat
- Whisper transcription
- LLM calls (Topic, Script, Hook, Prediction, Video Meta, Thumbnail prompt)
- ElevenLabs / OpenAI TTS

Prediction failures deliberately stay _uncached_ so a retry can try again.

## Cron auto-sync

`apps/worker/src/cron/analytics-sync.ts` runs on `ANALYTICS_SYNC_CRON` (default `0 */6 * * *` — every 6 hours). On each tick it enqueues an enrichment job for every `COMPLETED` upload, so analytics → feedback → memory keeps flowing without manual clicks. Set the env var to `""` to disable.

## Upload scheduler and cancel

- Manual upload supports scheduling: `POST /pipeline/:id/upload` accepts `{ privacy, scheduledAt? }`, where `scheduledAt` is an ISO datetime.
- If `scheduledAt` is omitted (or not in the future), upload is queued immediately.
- Automatic scheduling after pipeline completion is controlled by `AUTO_UPLOAD_ON_PIPELINE_DONE` + `AUTO_UPLOAD_DELAY_MINUTES`.
- Run cancellation is supported via `POST /pipeline/:id/cancel`.
- Cancel behavior:
  - queued/delayed pipeline and upload jobs for that run are removed from BullMQ;
  - active pipeline execution stops cooperatively at stage boundaries;
  - pending/running upload state is marked failed with `cancelled by user`.

## Batch generation

`POST /pipeline/batch` body: `{ niche, count (1-10), durationSec, languageCodes? }`.

- `count` = runs per language
- `languageCodes` defaults to `['en']`
- total enqueued runs = `count × languageCodes.length`

Example: `count=3` and `languageCodes=['en','es','hi']` queues `9` runs.

## Channel analytics dashboard

`/analytics` in the dashboard — channel-level overview via YouTube Data v3 + Analytics v2:

- Channel overview: subs, total views, total videos, custom URL, thumbnail
- Summary across selected range: views, watch time, net subs, likes/comments/shares, impressions, **CTR (percent form)**
- Daily time-series mini-charts (pure SVG, no deps): views, watch time, subs gained, likes
- Top videos table (sorted by views) with thumbnails linking to YouTube
- Range picker: 7 / 28 / 90 / 365 days

The OAuth helper + `parseAnalyticsCell` are shared (one copy per app in `integrations/youtube/`).

## Reliability baseline

- **aiClient** retries 5xx / network errors with exponential backoff (3 attempts), skips 4xx (schema bugs aren't retry-able).
- **BullMQ** `attempts: 3` on all queues with exponential backoff.
- **LLM model fallback** — `script`, `hook`, `feedback`, `prediction` auto-downgrade `gpt-4o → gpt-4o-mini` on sustained failure.
- **Voice fallback** — ElevenLabs failure → OpenAI `tts-1-hd`; pipeline never hard-stops on TTS.
- **Thumbnail non-fatal** — failure only logs; video still publishes.
- **Tag sanitization** — strip `<`/`>`, drop empties, dedupe, enforce 500-char total budget before `videos.insert`.
- **Typed API errors** — frontend's `ApiError` exposes `.status`; React Query retry predicates skip 4xx.

## Feature flags (`.env`)

| Flag                            | Default       | Effect                                                                                                                                                                                    |
| ------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_THUMBNAIL_AGENT`        | `false`       | Run the THUMBNAIL stage. Default off because YouTube rejects custom thumbnails from unverified channels. Verify at [youtube.com/verify](https://youtube.com/verify), then flip to `true`. |
| `WORKER_ROLE`                   | `all`         | Worker role selector: `all`, `video`, `upload`, `enrichment`. Use dedicated roles when splitting workers.                                                                                 |
| `ANALYTICS_SYNC_CRON`           | `0 */6 * * *` | node-cron expression for auto-enrichment. Empty string disables.                                                                                                                          |
| `ENABLE_ANALYTICS_CRON`         | `true`        | Enables cron scheduler in this worker process. Set `false` on non-enrichment roles.                                                                                                       |
| `HOOK_AB_AUTO_UPLOAD`           | `true`        | Auto-enqueues upload for each hook A/B variant run when it reaches `DONE`.                                                                                                                |
| `HOOK_AB_UPLOAD_PRIVACY`        | `PRIVATE`     | Privacy status used for A/B auto-upload when pipeline-wide auto-upload is disabled.                                                                                                       |
| `AUTO_UPLOAD_ON_PIPELINE_DONE`  | `false`       | When `true`, the worker auto-enqueues YouTube upload as soon as a run reaches `DONE` (applies to normal runs, not just hook A/B).                                                         |
| `AUTO_UPLOAD_PRIVACY`           | `PUBLIC`      | Privacy status used by pipeline-completion auto-upload (`PRIVATE`, `UNLISTED`, `PUBLIC`).                                                                                                 |
| `AUTO_UPLOAD_DELAY_MINUTES`     | `0`           | Scheduler delay after pipeline completion before upload job starts. `0` uploads immediately; values > 0 delay by N minutes.                                                               |
| `LOG_LEVEL`                     | `info`        | `debug` exposes BullMQ events + aiClient input summaries + cache HIT lines.                                                                                                               |
| `WORKER_CONCURRENCY`            | `1`           | Parallel pipeline runs per worker. Watch FFmpeg CPU if you bump it.                                                                                                                       |
| `UPLOAD_WORKER_CONCURRENCY`     | `1`           | Parallel uploads per upload-role worker. Increase carefully to avoid API quota spikes.                                                                                                    |
| `ENRICHMENT_WORKER_CONCURRENCY` | `2`           | Parallel enrichment jobs per enrichment-role worker.                                                                                                                                      |

## YouTube prereqs

- Google Cloud project with **YouTube Data API v3** + **YouTube Analytics API v2** enabled
- OAuth 2.0 Client (Web app), redirect URI `http://localhost:4000/auth/youtube/callback`
- Scopes requested: `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`
- **Custom thumbnails:** channel must be phone-verified ([youtube.com/verify](https://youtube.com/verify))
- App stays in "Testing" mode — add each Google account at [OAuth consent → Audience](https://console.cloud.google.com/apis/credentials/consent) (up to 100 test users)

## Data model

```
PipelineRun
├─ Topic                  (+ titleEmbedding Float[] for dedup)
├─ Script
├─ HookVariant[]
├─ PerformancePrediction  (pre-upload forecast)
├─ VoiceAsset
├─ Scene[]                (from Timestamp + Video Selection)
├─ Video                  (videoPath, thumbnailPath, SEO meta)
├─ YouTubeUpload          (privacy, youtubeVideoId, videoUrl)
├─ VideoAnalytics[]       (time-series snapshots, CTR in percent)
├─ FeedbackInsight        (1:1, latest wins)
└─ AgentLog[]

TopicMemory      (runId, niche, title, angle, embedding, performance)
HookMemory       (runId, niche, topicTitle, hookText, embedding, performance)
YouTubeAccount   (singleton id="default": accessToken, refreshToken, channelId)
```

## Endpoints

| Method | Path                                     | Purpose                                                                                          |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST` | `/pipeline/run`                          | start one run (body: `{ niche, durationSec?, languageCode? }`)                                   |
| `POST` | `/pipeline/batch`                        | start multilingual batches (body: `{ niche, count (1-10), durationSec?, languageCodes? }`)       |
| `GET`  | `/pipeline`                              | list recent runs                                                                                 |
| `GET`  | `/pipeline/:id`                          | full run detail + cost breakdown                                                                 |
| `GET`  | `/pipeline/:id/logs`                     | per-stage agent logs                                                                             |
| `GET`  | `/pipeline/:id/stream`                   | **SSE** — live events for this run                                                               |
| `POST` | `/pipeline/:id/retry`                    | resume FAILED run from last success                                                              |
| `POST` | `/pipeline/:id/cancel`                   | cancel a queued/running run; removes queued jobs and cooperatively halts active pipeline work    |
| `POST` | `/pipeline/:id/upload`                   | upload completed video to YouTube now or later (body: `{ privacy, scheduledAt? }`, ISO datetime) |
| `GET`  | `/pipeline/:id/upload`                   | upload status                                                                                    |
| `POST` | `/pipeline/:id/analytics/sync`           | queue analytics refresh for this run                                                             |
| `GET`  | `/pipeline/:id/analytics`                | latest snapshot + history + feedback                                                             |
| `POST` | `/analytics/sync`                        | queue refresh for all uploads                                                                    |
| `GET`  | `/analytics/channel?days=7\|28\|90\|365` | channel-level dashboard data                                                                     |
| `GET`  | `/auth/youtube`                          | start OAuth flow                                                                                 |
| `GET`  | `/auth/youtube/callback`                 | OAuth return URL                                                                                 |
| `GET`  | `/auth/youtube/status`                   | connected? channel info                                                                          |
| `POST` | `/auth/youtube/disconnect`               | drop stored tokens                                                                               |
| `GET`  | `/media/*`                               | static-serve generated audio / video / thumbnail / subs                                          |

## Project layout

```
apps/web
  app/
    page.tsx                 # trigger form (niche + duration + batch size)
    analytics/page.tsx       # channel-level dashboard
    runs/[id]/page.tsx       # live-updating run detail (SSE)
  components/
    UploadCard, AnalyticsCard, FeedbackCard, PredictionCard,
    AssetActions, YouTubeBadge
apps/api
  src/
    events/bus.ts            # Redis sub + in-process EventEmitter
    controllers/              # pipeline, upload, analytics, channel-analytics, youtube, events
    services/
      cost.service.ts        # per-run USD estimate
      channel-analytics.service.ts
      pipeline.service.ts
    integrations/youtube/
      oauth.ts               # authedClient, parseAnalyticsCell, NotConnectedError (shared)
apps/worker
  src/
    pipeline-runner.ts       # 9-stage pipeline, memory-aware, cache-resumable, event-publishing
    cache/cache-resume.ts    # per-stage DB + file loaders
    events/publisher.ts      # Redis pub helper
    memory/vectorStore.ts    # Topic + Hook memory, duplicate-topic guard
    upload/                  # YouTube upload + Analytics v2 client (uses shared helper)
    enrichment/              # analytics → feedback → memory
    media/                   # clipDownload, clipPrep, compose (FFmpeg)
    cron/analytics-sync.ts   # node-cron for scheduled enrichment
    lib/concurrency.ts       # pLimit bounded runner
    integrations/youtube/client.ts  # authedYouTubeClient, parseAnalyticsCell (shared)
ai-system
  agents/                    # 10 agents: topic, script, hook, voice, timestamp,
                             # video_selection, video_meta (+autocomplete),
                             # thumbnail, feedback, prediction
  lib/
    llm.py                   # chat_with_fallback (retry + model downgrade)
    embeddings.py            # text-embedding-3-small helper
    log.py                   # stdlib logger with request-id correlation
```

## Roadmap

- Karaoke-style word-highlight subtitles (Whisper timings → per-word drawtext)
- Background music track (Pixabay audio or Epidemic Sound), mood-matched
- Scene transitions (fade / whip-pan) via FFmpeg filter_complex
- A/B hook testing backed by real analytics instead of LLM self-score
- Comment-to-topic pipeline (YouTube comments → LLM cluster → next niche suggestions)
- Cross-post to TikTok + Instagram Reels + X
- Multi-tenant auth — own YouTubeAccount + memory pool per user
- S3-backed storage, pgvector (once memory > 10k rows), Prometheus/Grafana
- Local `faster-whisper` to drop the $0.007/run Whisper cost

## Notes

- API + worker run `prisma db push` at container boot — swap to `migrate deploy` when you commit a first migration with `prisma migrate dev --name init`.
- Every Node ↔ Python call forwards `x-request-id` (runId prefix) so both sides' logs correlate.
- The VIDEO stage runs up to 6 parallel Pexels downloads + 2 parallel FFmpeg preps — tune in `pipeline-runner.ts` if CPU-constrained.
- `AnalyticsCard` and the channel dashboard display CTR in percent form. If you're querying `VideoAnalytics.ctr` directly in SQL for any custom analytics, note it's stored as percent (4.0 = 4%) too — consistent across the whole codebase.
- Cron ticks enqueue per-run enrichment jobs with unique `jobId`s per tick, so double-scheduling from two workers won't duplicate work _within_ a tick. For multi-worker scale-out, add a Redis SET-NX lock around the tick itself.
