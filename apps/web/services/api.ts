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

// --- Channel-level analytics types ---
export type ChannelOverview = {
  channelId: string | null;
  channelTitle: string | null;
  subscriberCount: number;
  totalViews: number;
  totalVideos: number;
  hiddenSubscriberCount: boolean;
  channelThumbnail: string | null;
  customUrl: string | null;
  publishedAt: string | null;
};

export type DailyMetrics = {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number | null;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  comments: number;
  shares: number;
};

export type ChannelAnalyticsSummary = {
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  subscribersGained: number;
  subscribersLost: number;
  netSubscribers: number;
  likes: number;
  comments: number;
  shares: number;
  impressions: number | null;
  impressionsCtr: number | null;
};

export type TopVideo = {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  likes: number;
  comments: number;
  subscribersGained: number;
};

export type ChannelAnalyticsResponse = {
  overview: ChannelOverview;
  summary: ChannelAnalyticsSummary;
  daily: DailyMetrics[];
  topVideos: TopVideo[];
  dateRange: { start: string; end: string };
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

export type HookExperimentRun = {
  runId: string;
  hookText: string | null;
  status: RunStatus;
  stage: PipelineStage;
  uploadStatus: UploadStatus | null;
  videoUrl: string | null;
  views: number | null;
  avgViewPercentage: number | null;
  watchTimeMinutes: number | null;
  replayRate: number | null;
  score: number | null;
  isWinner: boolean;
};

export type HookExperimentResponse = {
  experimentId: string;
  canPickWinner: boolean;
  winnerRunId: string | null;
  runs: HookExperimentRun[];
};

export type PipelineRun = {
  id: string;
  experimentId: string | null;
  niche: string;
  languageCode: string;
  targetDurationSec: number;
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
  cost?: RunCost;
};

export type PipelineRunsPage = {
  items: PipelineRun[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type CostAnalysis = {
  actions: Array<
    | "APPROVE_PIPELINE"
    | "REGENERATE_HOOK"
    | "MODIFY_SCRIPT"
    | "CHANGE_VOICE_TIER"
    | "SKIP_THUMBNAIL"
    | "CHANGE_TOPIC"
  >;
  confidence: number;
  reasoning: string;
  cost_optimization: {
    main_cost_driver: "voice" | "llm" | "thumbnail" | "video";
    suggestion: string;
  };
  expected_impact: {
    ctr: "increase" | "decrease" | "neutral";
    retention: "increase" | "decrease" | "neutral";
  };
  iteration_control: {
    should_continue: boolean;
    reason: "max_iterations" | "converged" | "improvement_expected";
  };
  learning_signal: {
    pattern_detected: string | null;
    should_store: boolean;
  };
};

export type RunCost = {
  voiceUsd: number;
  whisperUsd: number;
  thumbnailUsd: number;
  llmUsd: number;
  totalUsd: number;
  analysis?: CostAnalysis | null;
  analysisModel?: string | null;
  source: {
    voiceProvider: string | null;
    voiceChars: number | null;
    audioDurationSec: number | null;
    thumbnailQuality: string | null;
    thumbnailEnabled: boolean;
  };
};

export type RunCostResponse = {
  runId: string;
  cost: RunCost;
};

export type CostHistoryEvent = {
  agent: "script" | "voice" | "thumbnail";
  at: string;
  deltaUsd: number;
  totalUsd: number;
  breakdown: {
    voiceUsd: number;
    whisperUsd: number;
    thumbnailUsd: number;
    llmUsd: number;
    totalUsd: number;
  };
  source: {
    voiceProvider: string | null;
    voiceChars: number | null;
    audioDurationSec: number | null;
    thumbnailQuality: string | null;
    thumbnailEnabled: boolean;
  };
};

export type RunCostHistoryResponse = {
  runId: string;
  latest: RunCost;
  events: CostHistoryEvent[];
};

export type CostAnalysisCacheStats = {
  enabled: boolean;
  model: string;
  ttlMs: number;
  now: string;
  entries: number;
  inFlight: number;
  metrics: {
    requests: number;
    cacheHits: number;
    cacheMisses: number;
    generated: number;
    failed: number;
    inFlightWaits: number;
    skippedDisabled: number;
    skippedMissingApiKey: number;
    skippedZeroTotal: number;
  };
};

export type RunFeatureToggles = {
  enableTimestamp: boolean;
  enableSubtitles: boolean;
  enableThumbnail: boolean;
  enableHookVariants: boolean;
};

export type AgentLog = {
  id: string;
  agent: string;
  status: "SUCCESS" | "FAILED";
  durationMs: number;
  errorMessage: string | null;
  createdAt: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public code?: string,
  ) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    // Surface the structured error.code when the server sent JSON.
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === "string") code = parsed.error;
    } catch {
      // non-JSON body — leave code undefined
    }
    throw new ApiError(res.status, text, code);
  }
  return res.json() as Promise<T>;
}

export const api = {
  base: API_URL,

  createRun(
    niche: string,
    durationSec: number = 75,
    languageCode: string = "en",
    features?: Partial<RunFeatureToggles>,
  ) {
    return fetch(`${API_URL}/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ niche, durationSec, languageCode, features }),
    }).then<PipelineRun>(handle);
  },

  createBatch(
    niche: string,
    count: number,
    durationSec: number = 75,
    languageCodes: string[] = ["en"],
    features?: Partial<RunFeatureToggles>,
  ) {
    return fetch(`${API_URL}/pipeline/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        niche,
        count,
        durationSec,
        languageCodes,
        features,
      }),
    }).then<{ count: number; runs: PipelineRun[] }>(handle);
  },

  getRun(id: string) {
    return fetch(`${API_URL}/pipeline/${id}`, {
      cache: "no-store",
    }).then<PipelineRun>(handle);
  },

  listRuns() {
    return fetch(`${API_URL}/pipeline`, { cache: "no-store" }).then<
      PipelineRun[]
    >(handle);
  },

  listRunsPaged(opts?: { page?: number; pageSize?: number }) {
    const page = opts?.page ?? 1;
    const pageSize = opts?.pageSize ?? 20;
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });

    return fetch(`${API_URL}/pipeline?${query.toString()}`, {
      cache: "no-store",
    }).then<PipelineRunsPage>(handle);
  },

  getLogs(id: string) {
    return fetch(`${API_URL}/pipeline/${id}/logs`, { cache: "no-store" }).then<
      AgentLog[]
    >(handle);
  },

  getExperiment(id: string) {
    return fetch(`${API_URL}/pipeline/${id}/experiment`, {
      cache: "no-store",
    }).then<HookExperimentResponse>(handle);
  },

  retryRun(id: string) {
    return fetch(`${API_URL}/pipeline/${id}/retry`, {
      method: "POST",
    }).then<PipelineRun>(handle);
  },

  cancelRun(id: string) {
    return fetch(`${API_URL}/pipeline/${id}/cancel`, {
      method: "POST",
    }).then<PipelineRun>(handle);
  },

  mediaUrl(storagePath: string) {
    const rel = storagePath.replace(/^\/storage\/?/, "");
    return `${API_URL}/media/${rel}`;
  },

  // --- YouTube ---
  youtubeStatus() {
    return fetch(`${API_URL}/auth/youtube/status`, {
      cache: "no-store",
    }).then<YouTubeStatus>(handle);
  },

  youtubeConnectUrl() {
    // Full-page redirect — OAuth can't be XHR.
    return `${API_URL}/auth/youtube`;
  },

  youtubeDisconnect() {
    return fetch(`${API_URL}/auth/youtube/disconnect`, {
      method: "POST",
    }).then<{
      connected: false;
    }>(handle);
  },

  startUpload(runId: string, privacy: UploadPrivacy, scheduledAt?: string) {
    return fetch(`${API_URL}/pipeline/${runId}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ privacy, scheduledAt }),
    }).then<YouTubeUpload>(handle);
  },

  getUpload(runId: string) {
    return fetch(`${API_URL}/pipeline/${runId}/upload`, {
      cache: "no-store",
    }).then<YouTubeUpload>(handle);
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

  // --- Channel analytics dashboard ---
  getChannelAnalytics(days: "7" | "28" | "90" | "365" = "28") {
    return fetch(`${API_URL}/analytics/channel?days=${days}`, {
      cache: "no-store",
    }).then<ChannelAnalyticsResponse>(handle);
  },

  // --- Cost analysis ---
  getRunCost(runId: string, opts?: { refreshAnalysis?: boolean }) {
    const params = new URLSearchParams();
    if (opts?.refreshAnalysis) {
      params.set("refreshAnalysis", "true");
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return fetch(`${API_URL}/cost/run/${runId}${query}`, {
      cache: "no-store",
    }).then<RunCostResponse>(handle);
  },

  getRunCostHistory(
    runId: string,
    opts?: { limit?: number; refreshAnalysis?: boolean },
  ) {
    const params = new URLSearchParams();
    if (opts?.limit != null) {
      params.set("limit", String(opts.limit));
    }
    if (opts?.refreshAnalysis) {
      params.set("refreshAnalysis", "true");
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return fetch(`${API_URL}/cost/run/${runId}/history${query}`, {
      cache: "no-store",
    }).then<RunCostHistoryResponse>(handle);
  },

  getCostCacheStats() {
    return fetch(`${API_URL}/cost/cache/stats`, {
      cache: "no-store",
    }).then<CostAnalysisCacheStats>(handle);
  },
};
