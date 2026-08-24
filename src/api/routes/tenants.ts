import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requireAdmin, requireTenantAuth } from "../middleware/auth";
import { recordAuditLog } from "../../services/auditLog";

const router = Router();

const createTenantSchema = z.object({
  name: z.string().min(1),
  planId: z.enum(["free", "pro", "enterprise"]).default("free"),
});

// Admin-only: onboarding creates the tenant row; call POST /api/api-keys/tenants/:id/bootstrap
// next to issue their first API key.
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const body = createTenantSchema.parse(req.body);
    const tenant = await prisma.tenant.create({ data: body });
    res.status(201).json(tenant);

    recordAuditLog({
      tenantId: tenant.id, actor: "admin", action: "tenant.created",
      targetType: "tenant", targetId: tenant.id, metadata: { name: body.name, planId: body.planId },
    });
  } catch (err) {
    next(err);
  }
});

// Self-service: a tenant can only ever fetch itself — req.tenantId comes from
// their own API key, so there's no id param to spoof.
router.get("/me", requireTenantAuth, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: req.tenantId! },
      include: { plan: true },
    });
    res.json(tenant);
  } catch (err) {
    next(err);
  }
});

router.get("/me/usage", requireTenantAuth, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: req.tenantId! },
      include: { plan: true },
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const usage = await prisma.usageCounter.aggregate({
      where: { tenantId: tenant.id, date: { gte: startOfMonth } },
      _sum: { syncCount: true },
    });

    const used = usage._sum.syncCount ?? 0;
    res.json({
      plan: tenant.plan.id,
      quota: tenant.plan.monthlySyncQuota,
      used,
      remaining: tenant.plan.monthlySyncQuota === -1 ? -1 : tenant.plan.monthlySyncQuota - used,
    });
  } catch (err) {
    next(err);
  }
});

// Admin-only: list every tenant (support/ops tooling, admin dashboard).
router.get("/", requireAdmin, async (_req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(tenants);
  } catch (err) {
    next(err);
  }
});

// Admin-only: look up any tenant by id (support/ops tooling)
router.get("/:id", requireAdmin, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { plan: true },
    });
    res.json(tenant);
  } catch (err) {
    next(err);
  }
});

export default router;
