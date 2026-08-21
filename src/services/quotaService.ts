import { prisma } from "../db/client";

/**
 * Usage-limit control. Called before every job is enqueued.
 * Tracks daily counters but checks against the tenant's MONTHLY quota
 * (sum of the current calendar month's daily counters) so plan limits read
 * naturally as "10,000 syncs / month" while still giving us daily granularity
 * for usage dashboards and anomaly detection.
 */
export async function checkAndReserveQuota(tenantId: string): Promise<{ allowed: boolean; remaining: number }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { plan: true },
  });

  if (tenant.plan.monthlySyncQuota === -1) {
    return { allowed: true, remaining: -1 }; // unlimited (enterprise)
  }

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const usage = await prisma.usageCounter.aggregate({
    where: { tenantId, date: { gte: startOfMonth } },
    _sum: { syncCount: true },
  });

  const usedThisMonth = usage._sum.syncCount ?? 0;
  const remaining = tenant.plan.monthlySyncQuota - usedThisMonth;

  if (remaining <= 0) {
    return { allowed: false, remaining: 0 };
  }

  // Reserve one unit against today's counter (upsert)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.usageCounter.upsert({
    where: { tenantId_date: { tenantId, date: today } },
    create: { tenantId, date: today, syncCount: 1 },
    update: { syncCount: { increment: 1 } },
  });

  return { allowed: true, remaining: remaining - 1 };
}
