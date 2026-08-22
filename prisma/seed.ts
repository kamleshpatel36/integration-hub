import "dotenv/config";
import { seedPlans } from "../src/services/seedService";
import { prisma } from "../src/db/client";

async function main() {
  const plans = await seedPlans();
  console.log(`Seeded plans: ${plans.map((p) => p.id).join(", ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
