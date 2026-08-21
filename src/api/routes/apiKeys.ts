import { Router } from "express";
import { prisma } from "../../db/client";
import { generateApiKey } from "../../services/authService";
import { requireAdmin } from "../middleware/auth";
import { requireTenantAuth } from "../middleware/auth";

const router = Router();

// Admin-only: issue a tenant's first API key at onboarding time.
// (Bootstrapping problem: a tenant can't authenticate to create their own
// first key, so this one step is admin-gated; every key after that can be
// self-issued by the tenant via the authenticated route below.)
router.post("/tenants/:tenantId/bootstrap", requireAdmin, async (req, res, next) => {
  try {
    const { plaintext, hash } = generateApiKey();
    const apiKey = await prisma.apiKey.create({
      data: { tenantId: req.params.tenantId, keyHash: hash, label: "Bootstrap key" },
    });
    // plaintext is returned exactly once — the caller (your onboarding flow)
    // must hand it to the tenant now; it is never retrievable again.
    res.status(201).json({ id: apiKey.id, apiKey: plaintext });
  } catch (err) {
    next(err);
  }
});

// Tenant-authenticated: issue an additional key for themselves (e.g. one per environment).
router.post("/", requireTenantAuth, async (req, res, next) => {
  try {
    const { plaintext, hash } = generateApiKey();
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    const apiKey = await prisma.apiKey.create({
      data: { tenantId: req.tenantId!, keyHash: hash, label },
    });
    res.status(201).json({ id: apiKey.id, apiKey: plaintext });
  } catch (err) {
    next(err);
  }
});

router.get("/", requireTenantAuth, async (req, res, next) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { tenantId: req.tenantId! },
      select: { id: true, label: true, createdAt: true, revokedAt: true }, // never return keyHash
    });
    res.json(keys);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireTenantAuth, async (req, res, next) => {
  try {
    // Scope the update by tenantId too — prevents tenant A from revoking tenant B's key by id
    const result = await prisma.apiKey.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId! },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) return res.status(404).json({ error: "Key not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
