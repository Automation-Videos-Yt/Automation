# AI Automation - Interview Cheat Sheet

## High-Level System Design

**Q: How would you describe the architecture of your system?**
**A:** "I designed this as an event-driven microservices architecture using a Monorepo setup. The system is split into four main services to ensure strict separation of concerns and high scalability:
1. **Next.js Web Frontend**: Uses React Query and Server-Sent Events (SSE) for a real-time, polling-free user experience.
2. **Express API Backend**: The central traffic controller. It handles validations, writes to PostgreSQL, and pushes jobs to Redis queues without doing any heavy processing itself.
3. **BullMQ Node Workers**: Dedicated background processes that handle the heavy lifting: FFmpeg rendering, third-party API calls, and YouTube uploads.
4. **FastAPI AI System**: A Python microservice that handles all LLM orchestrations, Whisper transcriptions, and vector embeddings because Python has the strongest AI ecosystem."

## Resilience & Fault Tolerance

**Q: What happens if the FFmpeg video generation crashes halfway through?**
**A:** "Because of my architecture in `apps/worker/src/pipeline-runner.ts`, the system is highly resilient. The BullMQ queue catches the crash and schedules a retry using exponential backoff. When the worker picks the job back up, it reads from a `StageContext` cache. Instead of starting over from scratch, it resumes exactly at the video rendering stage, preventing me from double-paying for OpenAI and ElevenLabs API calls."

## Real-Time User Experience

**Q: Video generation takes minutes. How does the frontend know when the video is done without making the user manually refresh the page?**
**A:** "Instead of using short-polling which hammers the database, I implemented Server-Sent Events (SSE). When the `worker` finishes a pipeline stage, it publishes a payload to a Redis channel. My Express `api` subscribes to that Redis channel (`events/bus.ts`) and pipes the payload directly to the Next.js frontend over an open HTTP connection, which instantly updates the React state."

## Self-Improving AI Systems

**Q: Your resume mentions a 'self-improving memory loop'. How does that work technically?**
**A:** "After a generated video is uploaded, a background cron job (the `enrichmentQueue`) pulls the YouTube analytics for that video. If a video performs exceptionally well (e.g., high CTR or watch time), its underlying Topic and Hook are converted into dense vector embeddings using `text-embedding-3-small` in my Python AI service. These vectors are saved to Postgres using `pgvector`.
When the system generates a new video in the same niche, it performs a Cosine Similarity search to find past successful hooks and injects them into the LangChain LLM prompt as context. This means the AI mathematically learns what content performs best over time."

## Cost Optimization (LangGraph)

**Q: How do you handle the unpredictable costs of using multiple AI APIs?**
**A:** "I built an autonomous Cost-Optimization Engine using LangGraph and LangChain. Before executing expensive TTS or video generation steps, the system analyzes the predicted retention and CTR against the normalized pipeline cost. If the ROI looks negative, the LangGraph state machine will autonomously decide to either requeue the hook for regeneration, or downgrade the TTS from a premium ElevenLabs voice to an economy OpenAI voice."
