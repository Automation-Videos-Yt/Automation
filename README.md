# AI YouTube Automation

Autonomous, self-improving, cost-aware content pipeline: niche → published short → analytics fed back → next run knows what worked.

**Current pipeline** (Phase 5):
`Topic (memory-aware) → Script → Hook (memory-aware, variants + self-rank) → Prediction → Voice (smart-tiered) → Timestamp (Whisper) → Video Selection (Pexels) → Video (autocomplete SEO, parallel download+meta) → Thumbnail (smart-tiered) → [Upload] → [Analytics → Feedback → Memory (Topic + Hook)]`

## Architecture

```
Next.js ─► Node API ─► BullMQ (Redis) ─► 3 Workers ─► Python AI / Pexels / OpenAI / YouTube
                │     videoQueue            │         retries + model fallback throughout
                │     uploadQueue           │
                │     enrichmentQueue       ├─► FFmpeg, ElevenLabs/OpenAI TTS, DALL-E
                └────► Postgres ◄───────────┘
                       (runs, analytics, feedback,
                        TopicMemory + HookMemory, Prediction)
```

## What's in Phase 5

### Reliability

- **aiClient retries** with exponential backoff; skips 4xx (schema bugs — no point retrying)
- **BullMQ attempts: 3** on every queue, exponential backoff between attempts
- **LLM model fallback** — `script`, `hook`, `feedback`, `prediction` auto-downgrade `gpt-4o → gpt-4o-mini` if the primary keeps erroring
- **Voice fallback** — ElevenLabs failure → OpenAI `tts-1`; pipeline never hard-stops on TTS

### Self-improving feedback loop

- **TopicMemory + HookMemory** — both use `text-embedding-3-small` over topic (title + angle); app-side cosine similarity picks top-3 for each new run
- **Admission rules** — `views ≥ 10 AND ctr ≥ 2%` to keep noise out
- **Memory consumption** — Topic agent + Hook agent both receive `past_{topics|hooks}` with performance tags and bias toward strong patterns, away from weak ones

### Performance prediction (pre-upload)

New `PREDICTION` stage runs after HOOK with `gpt-4o`, low temp:
- `predicted_ctr`, `predicted_retention`, `score` (0–10), `reasoning`
- Anchored with past-run data (same niche) to keep predictions calibrated
- Drives cost-aware tier selection for voice and thumbnail
- Predicted vs actual shown side-by-side in the dashboard once analytics arrives
- **Failure-safe**: if prediction errors out, pipeline continues with a neutral `score=5` default

### Cost-aware tiering

| Tier | Voice | Thumbnail |
|---|---|---|
| score ≥ 7.5 | ElevenLabs (premium) | 1536×1024 `high` ~$0.15 |
| 5 ≤ score < 7.5 | OpenAI `tts-1` (economy) | 1024×1024 `medium` ~$0.04 |
| score < 5 | OpenAI `tts-1` (economy) | 1024×1024 `low` ~$0.02 |

Rough cost-per-video at score=5 (mid): **~$0.05** vs Phase 4's flat ~$0.40 — **8–10× cheaper** for runs the system expects to underperform.

### Parallelization

The VIDEO stage used to be strictly sequential. Now:

- `video_meta` LLM call + all scene download+prep run concurrently (`Promise.all`)
- Per-scene: 6-way concurrent downloads (I/O bound) + 2-way concurrent FFmpeg prep (CPU bound) — implemented via tiny `pLimit` in [apps/worker/src/lib/concurrency.ts](apps/worker/src/lib/concurrency.ts)

Typical saving on a 10-scene video: **~30–45s runtime reduction**.

## Pipeline stages

| Stage | Agent | Notes |
|---|---|---|
| `TOPIC` | topic (memory-aware) | top-3 `TopicMemory` passed in as `past_topics` |
| `SCRIPT` | script | model fallback gpt-4o → gpt-4o-mini |
| `HOOK` | hook (memory-aware) | top-3 `HookMemory` passed in as `past_hooks`; variants + self-rank |
| `PREDICTION` | prediction | drives voice + thumbnail tiering |
| `VOICE` | voice | tier: `premium` (ElevenLabs) or `economy` (OpenAI TTS) |
| `TIMESTAMP` | timestamp | Whisper word-level alignment |
| `VIDEO_SELECTION` | video_selection | LLM query → Pexels |
| `VIDEO` | video_meta + worker | autocomplete SEO + **concurrent** clip pipeline |
| `THUMBNAIL` | thumbnail | tier: `high` / `medium` / `low` quality |

## Data surface

- `PipelineRun` (per niche)
- `Topic`, `Script`, `HookVariant` (×N), `VoiceAsset`, `Scene`, `Video`
- `PerformancePrediction` (pre-upload)
- `YouTubeUpload` (post-render, on-demand)
- `VideoAnalytics` (snapshots, time series)
- `FeedbackInsight` (post-analytics, 1:1)
- `TopicMemory`, `HookMemory` (embedding-indexed learning store)

## Admission + retrieval constants (tune in code, not runtime)

All in [apps/worker/src/memory/vectorStore.ts](apps/worker/src/memory/vectorStore.ts):

| Constant | Default | Effect |
|---|---|---|
| `ADMISSION_VIEWS_MIN` | 10 | skip runs with too little signal |
| `ADMISSION_CTR_MIN` | 0.02 (2%) | skip runs that flopped |
| `SIMILARITY_FLOOR` | 0.15 | skip wildly unrelated memories |

Thresholds are deliberately low for early-stage channels — tighten once you have 50+ runs with real traffic.

## Quick start (Phase 5)

```bash
cp .env.example .env
# fill OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, PEXELS_API_KEY,
# YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET
docker compose down
docker compose up --build
```

After first boot with Phase 5:
1. Disconnect → Connect YouTube (new `yt-analytics.readonly` scope from Phase 4 stays granted; no re-consent needed if you already granted it)
2. Run a niche → notice the extra PREDICTION stage on the timeline
3. On the run detail page: new **Performance prediction** card appears (color-coded), with Predicted numbers and — once you click **Sync analytics** after a few hours — Actual numbers right beside them
4. After a few completed/uploaded/analyzed runs, future TOPIC and HOOK stages will auto-populate "past runs" context — check the worker log for `memory retrieval` lines

## Roadmap (post-Phase 5)

- **Scheduler** — cron-style auto-sync so the feedback loop runs hands-off
- **Canva-style templated thumbnails** — separate subsystem (asset library, text layout engine, font picker); would slot in as a 4th thumbnail tier below `low`
- **Local faster-whisper** — drop the Whisper API $0.007/run cost if you're CPU-rich
- **pgvector** migration — once `TopicMemory`+`HookMemory` exceed ~10k rows
- **Multi-tenant auth** — each user owns their own YouTubeAccount + memory pool

## Project layout

```
apps/web                   # Next.js 14 + React Query
apps/api                   # Express + Prisma + 3 BullMQ producers + OAuth + analytics endpoints
apps/worker
  pipeline-runner.ts       # 9-stage memory-aware, tier-aware, parallelized pipeline
  upload/                  # YouTube upload + analytics API clients
  enrichment/              # analytics → feedback → Topic + Hook memory
  memory/vectorStore       # app-side cosine similarity, admission + retrieval
  lib/concurrency          # pLimit — bounded concurrency runner
  lib/logger               # pino with run-id correlation
ai-system/agents           # 10 agents: topic, script, hook, voice, timestamp,
                           # video_selection, video_meta (+autocomplete), thumbnail,
                           # feedback, prediction
ai-system/lib
  llm.py                   # chat_with_fallback (retry + model downgrade)
  embeddings.py            # text-embedding-3-small helper
  log.py                   # stdlib-backed request-id-correlated logger
```

## Notes

- Prediction failures don't kill the pipeline — a neutral `score=5` keeps downstream tiering sane.
- Voice tier=economy uses OpenAI's `alloy` voice by default (overrideable in the agent).
- The concurrent VIDEO stage means Pexels request bursts can look spikier to their API — 6 in flight is well under their documented limits but tunable in `pLimit(6)`.
