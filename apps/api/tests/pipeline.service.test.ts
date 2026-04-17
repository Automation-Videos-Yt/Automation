import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  $transaction: vi.fn(),
  pipelineRun: {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  youTubeUpload: {
    update: vi.fn(),
  },
};

const videoQueueMock = {
  add: vi.fn(),
  getJobs: vi.fn(),
};

const uploadQueueMock = {
  add: vi.fn(),
  getJobs: vi.fn(),
};

vi.mock("../src/db/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/queues/videoQueue", () => ({
  videoQueue: videoQueueMock,
}));

vi.mock("../src/queues/uploadQueue", () => ({
  uploadQueue: uploadQueueMock,
}));

vi.mock("../src/services/cost.service", () => ({
  estimateRunCost: vi.fn().mockResolvedValue({ totalUsd: 0 }),
}));

describe("pipeline.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a run and enqueues the video job", async () => {
    const createdRun = {
      id: "run_1",
      experimentId: "run_1",
      niche: "automation",
      languageCode: "en",
      targetDurationSec: 75,
      stage: "QUEUED",
      status: "QUEUED",
    };

    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({
        pipelineRun: {
          create: vi.fn().mockResolvedValue({ id: "run_1" }),
          update: vi.fn().mockResolvedValue(createdRun),
        },
      }),
    );

    const { createPipelineRun } = await import("../src/services/pipeline.service");
    const result = await createPipelineRun("automation", 75, "en", {
      enableTimestamp: true,
      enableSubtitles: true,
    });

    expect(result.id).toBe("run_1");
    expect(videoQueueMock.add).toHaveBeenCalledTimes(1);
    expect(videoQueueMock.add).toHaveBeenCalledWith(
      "run-pipeline",
      expect.objectContaining({ runId: "run_1" }),
      expect.any(Object),
    );
  });

  it("retries a failed run and resets failure metadata", async () => {
    prismaMock.pipelineRun.findUnique.mockResolvedValue({
      id: "run_retry",
      status: "FAILED",
      stage: "SCRIPT",
    });
    prismaMock.pipelineRun.update.mockResolvedValue({
      id: "run_retry",
      status: "QUEUED",
    });

    const { retryPipelineRun } = await import("../src/services/pipeline.service");
    await retryPipelineRun("run_retry");

    expect(prismaMock.pipelineRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "QUEUED",
          failedStage: null,
          stageFailureReason: null,
        }),
      }),
    );
    expect(videoQueueMock.add).toHaveBeenCalledTimes(1);
  });

  it("cancels a run and stores cancellation metadata", async () => {
    const removableJob = {
      data: { runId: "run_cancel" },
      remove: vi.fn().mockResolvedValue(undefined),
    };
    videoQueueMock.getJobs.mockResolvedValue([removableJob]);
    uploadQueueMock.getJobs.mockResolvedValue([]);
    prismaMock.pipelineRun.findUnique.mockResolvedValue({
      id: "run_cancel",
      status: "QUEUED",
      stage: "SCRIPT",
      upload: null,
    });
    prismaMock.pipelineRun.update.mockResolvedValue({
      id: "run_cancel",
      status: "FAILED",
    });

    const { cancelPipelineRun } = await import("../src/services/pipeline.service");
    await cancelPipelineRun("run_cancel");

    expect(removableJob.remove).toHaveBeenCalled();
    expect(prismaMock.pipelineRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stageFailureReason: "cancelled by user",
        }),
      }),
    );
  });
});
