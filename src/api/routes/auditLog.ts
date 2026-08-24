import { Router } from "express";
import { prisma } from "../../db/client";
import { requireTenantAuth, requireAdmin } from "../middleware/auth";

const router = Router();

// Tenant: only ever sees their own activity — scoped by req.tenantId, same
// pattern as every other tenant-scoped route in this API.
router.get("/", requireTenantAuth, async (req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { tenantId: req.tenantId! },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

// Admin: platform-wide activity feed, including actions with no tenant
// context (e.g. backup runs, tenant creation itself).
router.get("/admin", requireAdmin, async (_req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

export default router;
