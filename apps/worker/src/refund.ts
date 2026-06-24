import { PrismaClient } from "@prisma/client";
import { StageName } from "./stages/types";

const REFUNDABLE_STAGES: (StageName | "QUEUED")[] = ["QUEUED", "TOPIC", "SCRIPT"];

export async function processRefundIfEligible(
  prisma: PrismaClient,
  runId: string,
  failedStage: StageName | "QUEUED",
  reason: string,
) {
  if (!REFUNDABLE_STAGES.includes(failedStage)) {
    return; // Not eligible for refund
  }

  await prisma.$transaction(async (tx) => {
    const run = await tx.pipelineRun.findUnique({
      where: { id: runId },
      select: { 
        userId: true, 
        creditsCharged: true, 
        refundProcessed: true 
      }
    });

    if (!run || !run.userId || !run.creditsCharged || run.refundProcessed) {
      return;
    }

    const updatedUser = await tx.user.update({
      where: { id: run.userId },
      data: { credits: { increment: run.creditsCharged } }
    });

    await tx.creditTransaction.create({
      data: {
        userId: run.userId,
        amount: run.creditsCharged,
        balanceAfter: updatedUser.credits,
        type: "REFUND",
        referenceId: runId,
        metadata: { reason, failedStage }
      }
    });

    await tx.pipelineRun.update({
      where: { id: runId },
      data: { 
        refundProcessed: true,
        creditsRefunded: run.creditsCharged,
        refundReason: reason
      }
    });
  });
}
