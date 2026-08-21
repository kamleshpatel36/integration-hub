import "dotenv/config";
import cron from "node-cron";
import { prisma } from "../db/client";
import { checkAndReserveQuota } from "../services/quotaService";
import { enqueueSyncJob } from "./queueManager";
import { logger } from "../config/logger";

/**
 * Runs every minute; for each active poll-mode mapping, checks whether its
 * pollIntervalSec has elapsed since the last job and enqueues a new sync if so.
 * Separate process from the API and worker so it can be scaled/restarted
 * independently (run this as its own container/process: `npm run scheduler`).
 */

async function tick() {
  const mappings = await prisma.mapping.findMany({
    where: { isActive: true, triggerType: "poll" },
  });

  for (const mapping of mappings) {
    const lastJob = await prisma.job.findFirst({
      where: { mappingId: mapping.id },
      orderBy: { createdAt: "desc" },
    });

    const intervalMs = (mapping.pollIntervalSec ?? 300) * 1000;
    const dueAt = lastJob ? lastJob.createdAt.getTime() + intervalMs : 0;

    if (Date.now() < dueAt) continue; // not due yet

    const quota = await checkAndReserveQuota(mapping.tenantId);
    if (!quota.allowed) {
      logger.warn({ tenantId: mapping.tenantId, mappingId: mapping.id }, "skipped poll: quota exceeded");
      continue;
    }

    const job = await prisma.job.create({
      data: { tenantId: mapping.tenantId, mappingId: mapping.id, status: "QUEUED" },
    });
    await enqueueSyncJob({ tenantId: mapping.tenantId, mappingId: mapping.id, jobId: job.id });
    logger.info({ tenantId: mapping.tenantId, mappingId: mapping.id, jobId: job.id }, "poll-triggered sync enqueued");
  }
}

cron.schedule("* * * * *", () => {
  tick().catch((err) => logger.error({ err }, "scheduler tick failed"));
});

logger.info("Poll scheduler started (checking every minute)");
