import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";
import { checkAndReserveQuota } from "../../services/quotaService";
import { enqueueSyncJob } from "../../queue/queueManager";
import { requireTenantAuth } from "../middleware/auth";
import { recordAuditLog } from "../../services/auditLog";

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

    recordAuditLog({
      tenantId: req.tenantId, actor: "tenant", action: "job.triggered",
      targetType: "job", targetId: job.id,
      metadata: { mappingName: mapping.name, trigger: "manual" },
    });
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

// Full detail for one job — the "data history" drill-down (error message,
// exact timing, record counts) that the list view intentionally keeps terse.
router.get("/:id", async (req, res, next) => {
  try {
    const job = await prisma.job.findFirstOrThrow({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: { mapping: { select: { name: true, sourceObject: true, targetObject: true } } },
    });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

export default router;
