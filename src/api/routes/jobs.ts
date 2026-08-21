import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";
import { checkAndReserveQuota } from "../../services/quotaService";
import { enqueueSyncJob } from "../../queue/queueManager";
import { requireTenantAuth } from "../middleware/auth";

const router = Router();
router.use(requireTenantAuth);

router.post("/trigger", async (req, res, next) => {
  try {
    const { mappingId } = z.object({ mappingId: z.string().uuid() }).parse(req.body);

    // Scoped by tenantId — a tenant can only ever trigger their own mappings.
    const mapping = await prisma.mapping.findFirstOrThrow({
      where: { id: mappingId, tenantId: req.tenantId! },
    });

    const quota = await checkAndReserveQuota(req.tenantId!);
    if (!quota.allowed) {
      return res.status(429).json({ error: "Monthly sync quota exceeded for this tenant's plan" });
    }

    const job = await prisma.job.create({
      data: { tenantId: req.tenantId!, mappingId, status: "QUEUED" },
    });

    await enqueueSyncJob({ tenantId: req.tenantId!, mappingId, jobId: job.id });

    res.status(202).json({ jobId: job.id, quotaRemaining: quota.remaining });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const jobs = await prisma.job.findMany({
      where: { tenantId: req.tenantId! },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { mapping: { select: { name: true } } },
    });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

export default router;
