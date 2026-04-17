import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StageContext } from "../../src/stages";

const runAgentMock = vi.fn();
const loadScriptMock = vi.fn();

vi.mock("../../src/clients/aiClient", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../../src/cache/cache-resume", async () => {
  const actual = await vi.importActual<object>("../../src/cache/cache-resume");
  return {
    ...actual,
    loadScript: loadScriptMock,
  };
});

function createContext(): StageContext {
  return {
    runId: "run_script",
    prisma: {
      script: {
        create: vi.fn().mockResolvedValue(undefined),
      },
      pipelineRun: {
        update: vi.fn().mockResolvedValue(undefined),
        findUnique: vi.fn().mockResolvedValue({
          id: "run_script",
          niche: "automation",
          languageCode: "en",
          targetDurationSec: 75,
          experimentId: "run_script",
        }),
      },
      agentLog: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as StageContext["prisma"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as StageContext["logger"],
    emit: vi.fn().mockResolvedValue(undefined),
    cache: {
      features: {
        enableTimestamp: true,
        enableSubtitles: true,
        enableThumbnail: true,
        enableHookVariants: true,
      },
      topic: {
        title: "AI automation",
        angle: "growth",
        rationale: "works",
        trend_score: 0.9,
      },
    },
    config: {
      ENABLE_THUMBNAIL_AGENT: false,
    } as StageContext["config"],
  };
}

describe("scriptStage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes script generation and persists output", async () => {
    loadScriptMock.mockResolvedValue(null);
    runAgentMock.mockResolvedValue({
      hook: "Start here",
      body: "Body copy",
      cta: "Follow for more",
      word_count: 42,
      duration_estimate_sec: 18,
    });

    const { scriptStage } = await import("../../src/stages/script.stage");
    const result = await scriptStage.execute(createContext());

    expect(result.success).toBe(true);
    expect(runAgentMock).toHaveBeenCalledWith(
      "script",
      expect.objectContaining({ topic_title: expect.any(String) }),
      expect.any(Object),
    );
  });

  it("uses cached script output without calling AI", async () => {
    loadScriptMock.mockResolvedValue({
      hook: "Cached hook",
      body: "Cached body",
      cta: "Cached cta",
      word_count: 40,
      duration_estimate_sec: 17,
    });

    const { scriptStage } = await import("../../src/stages/script.stage");
    const result = await scriptStage.execute(createContext());

    expect(result.success).toBe(true);
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
