import { prisma } from "../db/prisma";

export type CostRunProfile = {
  niche: string | null;
  targetDurationSec: number | null;
  topic: { title: string | null; angle: string | null } | null;
  script: {
    hook: string | null;
    body: string | null;
    cta: string | null;
    wordCount: number | null;
  } | null;
  prediction: {
    score: number | null;
    predictedCtr: number | null;
    predictedRetention: number | null;
  } | null;
};

export type CostHistoryLogRow = {
  agent: string;
  createdAt: Date;
  inputJson: unknown;
  outputJson: unknown;
};

export async function findRunId(runId: string): Promise<{ id: string } | null> {
  return prisma.pipelineRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
}

export async function getRunCostInputs(runId: string): Promise<{
  voice: { voiceId: string; durationSec: number } | null;
  thumbnailLog: { outputJson: unknown } | null;
  voiceLog: { inputJson: unknown; outputJson: unknown } | null;
  runProfile: CostRunProfile | null;
}> {
  const [voice, thumbnailLog, voiceLog, runProfile] = await Promise.all([
    prisma.voiceAsset.findUnique({
      where: { runId },
      select: { voiceId: true, durationSec: true },
    }),
    prisma.agentLog.findFirst({
      where: { runId, agent: "thumbnail", status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      select: { outputJson: true },
    }),
    prisma.agentLog.findFirst({
      where: { runId, agent: "voice", status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      select: { inputJson: true, outputJson: true },
    }),
    prisma.pipelineRun.findUnique({
      where: { id: runId },
      select: {
        niche: true,
        targetDurationSec: true,
        topic: {
          select: {
            title: true,
            angle: true,
          },
        },
        script: {
          select: {
            hook: true,
            body: true,
            cta: true,
            wordCount: true,
          },
        },
        prediction: {
          select: {
            score: true,
            predictedCtr: true,
            predictedRetention: true,
          },
        },
      },
    }),
  ]);

  return {
    voice,
    thumbnailLog,
    voiceLog,
    runProfile,
  };
}

export async function hasSuccessfulScriptLog(runId: string): Promise<boolean> {
  const row = await prisma.agentLog.findFirst({
    where: { runId, agent: "script", status: "SUCCESS" },
    select: { id: true },
  });
  return !!row;
}

export async function listHistoricalSignalRows(niche: string): Promise<{
  topicMemoryRows: Array<{
    topicTitle: string;
    topicAngle: string;
    ctr: number | null;
    avgViewPct: number | null;
    performance: number;
  }>;
  hookMemoryRows: Array<{
    hookText: string;
    ctr: number | null;
    avgViewPct: number | null;
    performance: number;
  }>;
  recentRuns: Array<{
    analytics: Array<{ ctr: number | null; avgViewPercentage: number | null }>;
  }>;
}> {
  const [topicMemoryRows, hookMemoryRows, recentRuns] = await Promise.all([
    prisma.topicMemory.findMany({
      where: { niche },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        topicTitle: true,
        topicAngle: true,
        ctr: true,
        avgViewPct: true,
        performance: true,
      },
    }),
    prisma.hookMemory.findMany({
      where: { niche },
      orderBy: { performance: "desc" },
      take: 30,
      select: {
        hookText: true,
        ctr: true,
        avgViewPct: true,
        performance: true,
      },
    }),
    prisma.pipelineRun.findMany({
      where: { niche },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        analytics: {
          orderBy: { snapshotAt: "desc" },
          take: 1,
          select: { ctr: true, avgViewPercentage: true },
        },
      },
    }),
  ]);

  return {
    topicMemoryRows,
    hookMemoryRows,
    recentRuns,
  };
}

export async function listCostHistoryLogs(
  runId: string,
): Promise<CostHistoryLogRow[]> {
  const rows = await prisma.agentLog.findMany({
    where: {
      runId,
      status: "SUCCESS",
      agent: { in: ["script", "voice", "thumbnail"] },
    },
    orderBy: { createdAt: "asc" },
    take: 300,
    select: {
      agent: true,
      createdAt: true,
      inputJson: true,
      outputJson: true,
    },
  });

  return rows.map((row) => ({
    agent: row.agent,
    createdAt: row.createdAt,
    inputJson: row.inputJson,
    outputJson: row.outputJson,
  }));
}
