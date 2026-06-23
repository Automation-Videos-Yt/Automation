import { prisma } from "../db/prisma";
import { scheduleQueue, ScheduleJobData } from "../queues/scheduleQueue";
import { scoped } from "../lib/logger";

const log = scoped("schedule-svc");

export class ScheduleServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function createSchedule(niche: string, cronExpression: string, languageCode = "en") {
  const schedule = await prisma.pipelineSchedule.create({
    data: {
      niche,
      languageCode,
      cronExpression,
      isActive: true,
    },
  });

  const jobName = `schedule-${schedule.id}`;
  const jobData: ScheduleJobData = { scheduleId: schedule.id, niche, languageCode };
  
  const job = await scheduleQueue.add(jobName, jobData, {
    repeat: { pattern: cronExpression },
    jobId: jobName,
  });

  const updated = await prisma.pipelineSchedule.update({
    where: { id: schedule.id },
    data: { repeatJobKey: job.repeatJobKey },
  });

  log.info({ scheduleId: schedule.id, niche, cronExpression }, "schedule created and queued");
  return updated;
}

export async function listSchedules() {
  return prisma.pipelineSchedule.findMany({
    orderBy: { createdAt: "desc" },
  });
}

export async function getSchedule(id: string) {
  return prisma.pipelineSchedule.findUnique({
    where: { id },
  });
}

export async function deleteSchedule(id: string) {
  const schedule = await prisma.pipelineSchedule.findUnique({
    where: { id },
  });
  
  if (!schedule) {
    throw new ScheduleServiceError("NOT_FOUND", "schedule not found");
  }

  if (schedule.repeatJobKey) {
    await scheduleQueue.removeRepeatableByKey(schedule.repeatJobKey);
  } else {
    // Fallback if repeatJobKey wasn't saved properly
    const repeatableJobs = await scheduleQueue.getRepeatableJobs();
    const job = repeatableJobs.find(j => j.name === `schedule-${id}`);
    if (job) {
      await scheduleQueue.removeRepeatableByKey(job.key);
    }
  }

  await prisma.pipelineSchedule.delete({
    where: { id },
  });

  log.info({ scheduleId: id }, "schedule deleted");
}
