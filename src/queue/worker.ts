import "dotenv/config";
import { Worker, Job as BullJob } from "bullmq";
import { connection } from "./redis";
import { prisma } from "../db/client";
import { createConnector } from "../connectors/factory";
import { decryptCredentials } from "../services/crypto";
import { applyMapping } from "../services/transformEngine";
import { SyncJobData } from "./queueManager";
import { logger } from "../config/logger";

/**
 * Dynamic load balancer: scans for tenants with active mappings and ensures
 * exactly one BullMQ Worker exists per tenant queue, sized to that tenant's
 * plan (concurrency + jobs/min rate limit). Re-scans periodically so new
 * tenants get picked up without redeploying, and idle tenants' workers can
 * be torn down to free resources.
 */
const activeWorkers = new Map<string, Worker>();
const RESCAN_INTERVAL_MS = 30_000;

async function processSyncJob(job: BullJob<SyncJobData>) {
  const { mappingId, jobId } = job.data;

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  const mapping = await prisma.mapping.findUniqueOrThrow({
    where: { id: mappingId },
    include: { sourceConnection: true, targetConnection: true },
  });

  try {
    const sourceConnector = createConnector(
      mapping.sourceConnection.connectorType,
      await decryptCredentials(mapping.sourceConnection.credentialsEnc)
    );
    const targetConnector = createConnector(
      mapping.targetConnection.connectorType,
      await decryptCredentials(mapping.targetConnection.credentialsEnc)
    );

    const { records } = await sourceConnector.read(mapping.sourceObject, { limit: 100 });

    let written = 0;
    for (const record of records) {
      const mapped = applyMapping(record, mapping.fieldMappings as any);
      await targetConnector.write(mapping.targetObject, mapped);
      written++;
    }

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "SUCCESS",
        recordsRead: records.length,
        recordsWritten: written,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    const isRateLimit = message.includes("RATE_LIMITED");

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: isRateLimit ? "RETRYING" : "FAILED",
        errorMessage: message,
        attempt: { increment: 1 },
      },
    });

    throw err; // rethrow so BullMQ applies the backoff/retry policy
  }
}

async function ensureWorkerForTenant(tenantId: string, rateLimitPerMin: number, concurrency: number) {
  if (activeWorkers.has(tenantId)) return;

  const worker = new Worker<SyncJobData>(`tenant:${tenantId}`, processSyncJob, {
    connection,
    concurrency, // per-tenant concurrency cap — keeps us under NetSuite's account limit
    limiter: {
      max: rateLimitPerMin,
      duration: 60_000, // plan-driven rate limit: jobs/min per tenant
    },
  });

  worker.on("failed", (job, err) => {
    logger.error({ tenantId, jobId: job?.id, err: err.message }, "sync job failed");
  });

  activeWorkers.set(tenantId, worker);
  logger.info({ tenantId, concurrency, rateLimitPerMin }, "worker started for tenant");
}

async function rescanTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { mappings: { some: { isActive: true } } },
    include: { plan: true },
  });

  for (const tenant of tenants) {
    await ensureWorkerForTenant(tenant.id, tenant.plan.rateLimitPerMin, tenant.plan.maxConcurrentJobs);
  }

  // Tear down workers for tenants that no longer have active mappings —
  // frees Redis/connection resources instead of leaking idle workers.
  const activeTenantIds = new Set(tenants.map((t: { id: string }) => t.id));
  for (const [tenantId, worker] of activeWorkers.entries()) {
    if (!activeTenantIds.has(tenantId)) {
      await worker.close();
      activeWorkers.delete(tenantId);
      logger.info({ tenantId }, "worker torn down (no active mappings)");
    }
  }
}

async function main() {
  logger.info("Integration Hub worker process starting...");
  await rescanTenants();
  setInterval(() => {
    rescanTenants().catch((err) => logger.error({ err }, "rescan failed"));
  }, RESCAN_INTERVAL_MS);
}

/**
 * Exported so index.ts can start this in-process on a single free Web
 * Service (no separate paid Background Worker needed — see README
 * "Running everything on Render's Free plan"). Deliberately does NOT
 * process.exit on failure, since that would also kill the API server
 * sharing this process; only the standalone-script path below does that.
 */
export async function startWorkerProcess(): Promise<void> {
  await main();
}

// Only runs when this file is executed directly (`npm run worker`), i.e.
// the separate-service deployment path — not when imported by index.ts.
if (require.main === module) {
  startWorkerProcess().catch((err) => {
    logger.error({ err }, "worker process crashed");
    process.exit(1);
  });
}
