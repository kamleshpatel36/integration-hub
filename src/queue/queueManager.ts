import { Queue } from "bullmq";
import { connection } from "./redis";
import { prisma } from "../db/client";

/**
 * DYNAMIC LOAD BALANCING & USAGE LIMIT CONTROL — core of the platform.
 *
 * Strategy: one BullMQ queue per tenant, named `tenant:{tenantId}`.
 *   - Per-tenant RATE LIMIT (jobs/min) comes from the tenant's plan and is
 *     applied as a BullMQ queue rate limiter — this is the "usage limit
 *     control" feature (Free/Pro/Enterprise tiers get different throughput).
 *   - Per-tenant CONCURRENCY cap (maxConcurrentJobs) is applied on the worker
 *     side (see worker.ts) and is set BELOW NetSuite's own per-account
 *     concurrency limit, so we self-throttle instead of hitting NetSuite 429s.
 *   - "Load balancing" here means: many tenant queues share a fixed pool of
 *     worker processes/threads. The worker layer pulls fairly across tenant
 *     queues (round-robin) rather than letting one busy tenant starve others.
 *     This scales to low hundreds of tenants; past that, move to a single
 *     shared queue + token-bucket-per-tenant check at dequeue time (noted
 *     in README under "scaling beyond MVP").
 */

const queueCache = new Map<string, Queue>();

export async function getTenantQueue(tenantId: string): Promise<Queue> {
  const cached = queueCache.get(tenantId);
  if (cached) return cached;

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { plan: true },
  });

  const queue = new Queue(`tenant:${tenantId}`, {
    connection,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 5000 }, // 5s, 10s, 20s, 40s
      removeOnComplete: { age: 60 * 60 * 24 * 7 }, // keep 7 days
      removeOnFail: { age: 60 * 60 * 24 * 30 }, // keep 30 days for debugging
    },
  });

  // BullMQ rate limiting is set at the Worker (limiter option) rather than the
  // Queue in v5 — we stash the tenant's rate on the queue object for worker.ts
  // to read when it spins up a Worker for this tenant.
  (queue as any)._tenantRateLimitPerMin = tenant.plan.rateLimitPerMin;
  (queue as any)._tenantConcurrency = tenant.plan.maxConcurrentJobs;

  queueCache.set(tenantId, queue);
  return queue;
}

export interface SyncJobData {
  tenantId: string;
  mappingId: string;
  jobId: string; // Job row id in Postgres, for status updates
}

export async function enqueueSyncJob(data: SyncJobData) {
  const queue = await getTenantQueue(data.tenantId);
  await queue.add("sync", data, {
    jobId: data.jobId, // idempotency: dedupe if the same job is enqueued twice
  });
}
