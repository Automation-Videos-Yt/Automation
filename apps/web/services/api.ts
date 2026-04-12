const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type RunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
export type PipelineStage =
  | "QUEUED"
  | "TOPIC"
  | "SCRIPT"
  | "HOOK"
  | "PREDICTION"
  | "VOICE"
  | "TIMESTAMP"
  | "VIDEO_SELECTION"
  | "VIDEO"
  | "THUMBNAIL"
  | "DONE"
  | "FAILED";

export type PerformancePrediction = {
  id: string;
  runId: string;
  predictedCtr: number;
  predictedRetention: number;
  score: number;
  reasoning: string;
  createdAt: string;
};

export type UploadStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
export type UploadPrivacy = "PRIVATE" | "UNLISTED" | "PUBLIC";

export type YouTubeUpload = {
  id: string;
  runId: string;
  status: UploadStatus;
  privacy: UploadPrivacy;
  youtubeVideoId: string | null;
  videoUrl: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type YouTubeStatus =
  | { connected: false }
  | {
      connected: true;
      channelId: string | null;
      channelTitle: string | null;
      scope: string;
      tokenExpiresAt: string;
    };

export type VideoAnalyticsSnapshot = {
  id: string;
  runId: string;
  snapshotAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number | null;
  impressions: number | null;
  ctr: number | null;
  avgViewDurationSec: number | null;
  avgViewPercentage: number | null;
  watchTimeMinutes: number | null;
  subsGained: number | null;
};

export type FeedbackInsight = {
  id: string;
  runId: string;
  whatWorked: string;
  whatDidnt: string;
  suggestions: string;
  performanceTag: string;
  createdAt: string;
  updatedAt: string;
};

export type RunAnalyticsResponse = {
  latest: VideoAnalyticsSnapshot | null;
  history: VideoAnalyticsSnapshot[];
  feedback: FeedbackInsight | null;
};

export type HookVariant = {
  id: string;
  index: number;
  text: string;
  score: number;
  reasoning: string | null;
  chosen: boolean;
};

export type Scene = {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  query: string | null;
  clipUrl: string | null;
  clipSource: string | null;
  clipPath: string | null;
  clipDurationSec: number | null;
};

export type PipelineRun = {
  id: string;
  niche: string;
  stage: PipelineStage;
  status: RunStatus;
  currentAgent: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  topic?: {
    title: string;
    angle: string;
    rationale: string;
    trendScore: number;
  } | null;
  script?: {
    hook: string;
    body: string;
    cta: string;
    wordCount: number;
    durationEstimateSec: number;
  } | null;
  voiceAsset?: {
    audioPath: string;
    durationSec: number;
    voiceId: string;
  } | null;
  video?: {
    videoPath: string;
    thumbnailPath: string | null;
    title: string | null;
    description: string | null;
    tags: string[];
  } | null;
  hookVariants?: HookVariant[];
  scenes?: Scene[];
  upload?: YouTubeUpload | null;
  prediction?: PerformancePrediction | null;
};

export type AgentLog = {
  id: string;
  agent: string;
  status: "SUCCESS" | "FAILED";
  durationMs: number;
  errorMessage: string | null;
  createdAt: string;
};

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  base: API_URL,

  createRun(niche: string) {
    return fetch(`${API_URL}/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ niche }),
    }).then<PipelineRun>(handle);
  },

  getRun(id: string) {
    return fetch(`${API_URL}/pipeline/${id}`, { cache: "no-store" }).then<PipelineRun>(handle);
  },

  listRuns() {
    return fetch(`${API_URL}/pipeline`, { cache: "no-store" }).then<PipelineRun[]>(handle);
  },

  getLogs(id: string) {
    return fetch(`${API_URL}/pipeline/${id}/logs`, { cache: "no-store" }).then<AgentLog[]>(handle);
  },

  retryRun(id: string) {
    return fetch(`${API_URL}/pipeline/${id}/retry`, { method: "POST" }).then<PipelineRun>(handle);
  },

  mediaUrl(storagePath: string) {
    const rel = storagePath.replace(/^\/storage\/?/, "");
    return `${API_URL}/media/${rel}`;
  },

  // --- YouTube ---
  youtubeStatus() {
    return fetch(`${API_URL}/auth/youtube/status`, { cache: "no-store" }).then<YouTubeStatus>(handle);
  },

  youtubeConnectUrl() {
    // Full-page redirect — OAuth can't be XHR.
    return `${API_URL}/auth/youtube`;
  },

  youtubeDisconnect() {
    return fetch(`${API_URL}/auth/youtube/disconnect`, { method: "POST" }).then<{
      connected: false;
    }>(handle);
  },

  startUpload(runId: string, privacy: UploadPrivacy) {
    return fetch(`${API_URL}/pipeline/${runId}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ privacy }),
    }).then<YouTubeUpload>(handle);
  },

  getUpload(runId: string) {
    return fetch(`${API_URL}/pipeline/${runId}/upload`, { cache: "no-store" }).then<YouTubeUpload>(handle);
  },

  // --- Phase 4: analytics + feedback ---
  getRunAnalytics(runId: string) {
    return fetch(`${API_URL}/pipeline/${runId}/analytics`, {
      cache: "no-store",
    }).then<RunAnalyticsResponse>(handle);
  },

  syncRunAnalytics(runId: string) {
    return fetch(`${API_URL}/pipeline/${runId}/analytics/sync`, {
      method: "POST",
    }).then<{ enqueued: true }>(handle);
  },

  syncAllAnalytics() {
    return fetch(`${API_URL}/analytics/sync`, { method: "POST" }).then<{
      queued: number;
    }>(handle);
  },
};
