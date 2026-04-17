# Engineering Handoff Checklist

Generated: 2026-04-17
Source baseline: docs/IMPLEMENTATION_AUDIT.md

## 1. Handoff Objective

Provide an actionable transfer document for engineers taking ownership of the AI YouTube Automation stack.

This document focuses on:

- ownership boundaries,
- current implementation baseline,
- release-readiness checks,
- and immediate hardening backlog.

## 2. Ownership Map (Suggested)

| Area                 | Primary owner    | Secondary owner | Key files                                                                                                     |
| -------------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| Web dashboard        | Frontend         | Full-stack      | apps/web/app, apps/web/components, apps/web/services/api.ts                                                   |
| API control plane    | Backend          | Full-stack      | apps/api/src/app.ts, apps/api/src/routes, apps/api/src/controllers, apps/api/src/services                     |
| Worker execution     | Backend/Platform | Media engineer  | apps/worker/src/pipeline-runner.ts, apps/worker/src/stages, apps/worker/src/media, apps/worker/src/upload, apps/worker/src/enrichment |
| AI agent runtime     | ML/AI engineer   | Backend         | ai-system/main.py, ai-system/orchestrator/agent_runner.py, ai-system/agents, ai-system/schemas                |
| Data model           | Backend          | Platform        | apps/api/prisma/schema.prisma                                                                                 |
| Infra and containers | Platform         | Backend         | docker-compose.yml, infrastructure/docker                                                                     |
| CI                   | Platform         | Repo maintainer | .github/workflows/ci.yml                                                                                      |

## 3. Baseline Implementation Status

| Capability                        | Status  | Evidence                                                                                    |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| End-to-end generation pipeline    | Done    | apps/worker/src/pipeline-runner.ts, apps/worker/src/stages/index.ts                         |
| Queue-based execution and retries | Done    | apps/api/src/queues, apps/worker/src/index.ts                                               |
| Live run updates (SSE)            | Done    | apps/api/src/events/bus.ts, apps/api/src/controllers/events.controller.ts                   |
| YouTube OAuth and upload          | Done    | apps/api/src/controllers/youtube.controller.ts, apps/worker/src/upload/upload-runner.ts     |
| Analytics sync and feedback       | Done    | apps/api/src/services/analytics.service.ts, apps/worker/src/enrichment/enrichment-runner.ts |
| Topic/hook memory loop            | Done    | apps/worker/src/memory/vectorStore.ts                                                       |
| Cost analysis and recommendations | Done    | apps/api/src/services/cost.service.ts, apps/web/components/CostAnalysisCard.tsx             |
| Channel analytics dashboard       | Done    | apps/web/app/analytics/page.tsx                                                             |
| CI checks                         | Done    | .github/workflows/ci.yml                                                                    |
| Worker stage modularization       | Done    | apps/worker/src/stages                                                                      |
| Test suite (unit/integration)     | Pending | No test files in apps/api, apps/worker, apps/web                                            |
| Tracked DB migrations             | Pending | No apps/api/prisma/migrations directory                                                     |

## 4. Release Readiness Checklist

### 4.1 Environment and startup

- [ ] Confirm .env values are complete for all required providers.
- [ ] Validate docker compose up --build succeeds on clean machine.
- [ ] Validate health endpoints and service connectivity:
  - API: /health
  - AI: /health
  - Redis and Postgres health checks

### 4.2 Pipeline path

- [ ] Create a run from UI and verify stage progression to DONE.
- [ ] Validate retry behavior from FAILED state.
- [ ] Validate cancellation behavior for QUEUED and RUNNING runs.
- [ ] Validate cache-resume path by forcing a mid-run failure then retrying.

### 4.3 Upload path

- [ ] Connect YouTube account via OAuth.
- [ ] Trigger upload and verify status transitions PENDING -> RUNNING -> COMPLETED.
- [ ] Verify uploaded video metadata and tags on YouTube.
- [ ] Verify thumbnail set behavior (including non-fatal failure handling).

### 4.4 Analytics and learning

- [ ] Run sync for uploaded video and verify VideoAnalytics record creation.
- [ ] Verify feedback generation and persistence.
- [ ] Verify topic/hook admission logic updates memory tables when thresholds are met.

### 4.5 Cost analysis

- [ ] Verify /cost/run/:id response includes deterministic buckets.
- [ ] Verify recommendation output with LLM enabled.
- [ ] Verify heuristic fallback when LLM path is unavailable.

### 4.6 Frontend checks

- [ ] Validate home page run creation controls and feature toggles.
- [ ] Validate run detail page SSE updates.
- [ ] Validate analytics page charts/tables render for all range tabs.
- [ ] Validate upload and cost cards with real run data.

### 4.7 CI and build

- [ ] Confirm node/python/prisma/docker CI jobs pass on main.
- [ ] Confirm web build passes with NEXT_PUBLIC_API_URL set.
- [ ] Confirm prisma validate and prisma format --check pass.

## 5. Commands for New Owners

## 5.1 Local workspace

- npm install
- npm run dev:api
- npm run dev:worker
- npm run dev:web

## 5.2 Docker stack

- ./scripts/bootstrap.sh
- docker compose up --build

## 5.3 Smoke validation

- ./scripts/smoke.sh "productivity hacks"

## 5.4 Optional split workers

- docker compose --profile split-workers up -d worker-video worker-upload worker-enrichment

## 6. High-Priority Hardening Backlog

### P0

1. Add automated tests for API service logic and worker stage behavior.
2. Move from prisma db push workflow to tracked migrations.
3. Add stronger validation for conflicting feature flag combinations.

### P1

1. Improve multilingual timestamp/subtitle path.
2. Improve fallback observability when placeholder media is used.
3. Prevent apps/worker/src/stages/helpers.ts from becoming a new orchestration bottleneck by keeping stage logic local.

### P2

1. Strengthen secret/token storage controls (including token-at-rest protection).
2. Add deeper operational telemetry for run latency and stage-level failure analysis.

## 7. Operational Risk Register (Current)

| Risk                       | Impact                                     | Mitigation                                            |
| -------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Sparse stage-level tests   | Regression risk in orchestration behavior  | Add stage-focused automated coverage                  |
| No tracked migrations      | Risky schema evolution across environments | Introduce prisma migration workflow                   |
| Sparse automated tests     | Regression risk                            | Add unit/integration coverage for critical flows      |
| Placeholder media fallback | Possible output quality drop               | Improve clip retrieval strategy + operator visibility |

## 8. Handoff Acceptance Criteria

Handoff is considered complete when:

- [ ] New owner can run stack locally and in Docker.
- [ ] New owner can execute full generation -> upload -> analytics loop.
- [ ] New owner can diagnose failures from logs/events/DB state.
- [ ] Team agrees on owners for each module listed in Section 2.
- [ ] P0 backlog items have target milestones.

---

This checklist is intended as the engineering operations companion to docs/IMPLEMENTATION_AUDIT.md and docs/IMPLEMENTATION_BUSINESS_SUMMARY.md.
