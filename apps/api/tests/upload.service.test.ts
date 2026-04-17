import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  pipelineRun: {
    findUnique: vi.fn(),
  },
  youTubeAccount: {
    findUnique: vi.fn(),
  },
  youTubeUpload: {
    create: vi.fn(),
    update: vi.fn(),
  },
};

const uploadQueueMock = {
  add: vi.fn(),
};

vi.mock("../src/db/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/queues/uploadQueue", () => ({
  uploadQueue: uploadQueueMock,
}));

describe("upload.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues upload for a completed run", async () => {
    prismaMock.pipelineRun.findUnique.mockResolvedValue({
      id: "run_upload",
      status: "COMPLETED",
      video: { videoPath: "/tmp/video.mp4" },
      upload: null,
    });
    prismaMock.youTubeAccount.findUnique.mockResolvedValue({ id: "default" });
    prismaMock.youTubeUpload.create.mockResolvedValue({
      id: "upload_1",
      runId: "run_upload",
      status: "PENDING",
    });

    const { enqueueUpload } = await import("../src/services/upload.service");
    const result = await enqueueUpload("run_upload", "PUBLIC");

    expect(result.id).toBe("upload_1");
    expect(uploadQueueMock.add).toHaveBeenCalledWith(
      "upload",
      { runId: "run_upload", uploadId: "upload_1" },
      expect.any(Object),
    );
  });
});
