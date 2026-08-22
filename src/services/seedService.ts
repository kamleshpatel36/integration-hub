import { prisma } from "../db/client";

/**
 * Seeds the three subscription plans. Idempotent (upsert) — safe to call
 * repeatedly, whether via `npx prisma db seed` (needs Shell access, which
 * Render's Free tier doesn't include) or via the admin API endpoint below
 * (works on any plan, no Shell required).
 */
export async function seedPlans(): Promise<{ id: string; name: string }[]> {
  const plans = [
    { id: "free", name: "Free", monthlySyncQuota: 500, maxConcurrentJobs: 1, rateLimitPerMin: 10 },
    { id: "pro", name: "Pro", monthlySyncQuota: 10000, maxConcurrentJobs: 3, rateLimitPerMin: 60 },
    { id: "enterprise", name: "Enterprise", monthlySyncQuota: -1, maxConcurrentJobs: 8, rateLimitPerMin: 300 },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({ where: { id: plan.id }, create: plan, update: {} });
  }

  return plans.map((p) => ({ id: p.id, name: p.name }));
}
