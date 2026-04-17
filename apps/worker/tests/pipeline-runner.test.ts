import { beforeEach, describe, expect, it, vi } from "vitest";

const publishRunEventMock = vi.fn();
const enqueueAutoUploadForRunMock = vi.fn();

const prismaMock = {
  pipelineRun: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../src/db/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/events/publisher", () => ({
  publishRunEvent: publishRunEventMock,
}));

vi.mock("../src/upload/auto-upload", () => ({
  enqueueAutoUploadForRun: enqueueAutoUploadForRunMock,
}));

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("retries a failed stage up to the stage retry limit", async () => {
    const onError = vi.fn().mockResolvedValue(undefined);
    const flakyStage = {
      name: "SCRIPT",
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ success: true }),
      onError,
    };

    vi.doMock("../src/stages", () => ({
      PIPELINE_STAGES: [flakyStage],
    }));

    prismaMock.pipelineRun.findUnique.mockImplementation(async ({ select }) => {
      if (select) {
        return { status: "QUEUED", errorMessage: null };
      }
      return {
        id: "run_retry",
        niche: "automation",
        languageCode: "en",
        targetDurationSec: 75,
        experimentId: null,
        status: "QUEUED",
        stage: "QUEUED",
        currentAgent: null,
        errorMessage: null,
        stageRetryCounts: {},
      };
    });
    prismaMock.pipelineRun.update.mockResolvedValue(undefined);

    const { runPipeline } = await import("../src/pipeline-runner");
    await runPipeline("run_retry");

    expect(flakyStage.execute).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(prismaMock.pipelineRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stageRetryCounts: expect.objectContaining({ SCRIPT: 1 }),
        }),
      }),
    );
  });
});
