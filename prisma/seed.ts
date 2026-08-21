import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.plan.upsert({
    where: { id: "free" },
    create: { id: "free", name: "Free", monthlySyncQuota: 500, maxConcurrentJobs: 1, rateLimitPerMin: 10 },
    update: {},
  });
  await prisma.plan.upsert({
    where: { id: "pro" },
    create: { id: "pro", name: "Pro", monthlySyncQuota: 10000, maxConcurrentJobs: 3, rateLimitPerMin: 60 },
    update: {},
  });
  await prisma.plan.upsert({
    where: { id: "enterprise" },
    create: { id: "enterprise", name: "Enterprise", monthlySyncQuota: -1, maxConcurrentJobs: 8, rateLimitPerMin: 300 },
    update: {},
  });

  console.log("Seeded plans: free, pro, enterprise");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
