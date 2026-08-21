import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../../db/client";
import { checkAndReserveQuota } from "../../services/quotaService";
import { enqueueSyncJob } from "../../queue/queueManager";
import { logger } from "../../config/logger";

const router = Router();

/**
 * POST /api/webhooks/:mappingId
 * Body: raw JSON payload from the tenant's external system.
 * Header: X-Webhook-Signature: hex-encoded HMAC-SHA256 of the raw request
 *         body, keyed with the mapping's webhookSecret.
 *
 * This route is mounted BEFORE the global express.json() body parser (see
 * index.ts) because signature verification needs the exact raw bytes that
 * were sent — re-serializing a parsed JSON object can produce different
 * bytes (key order, whitespace) and silently break verification for
 * legitimate callers. This router applies its own express.raw() parser
 * scoped to just this path.
 *
 * No tenant Bearer-token auth here by design — webhook callers are external
 * systems (Shopify, Salesforce, etc.), not tenant staff. The HMAC signature
 * is what proves the request is authentic, the same way Stripe/GitHub/Shopify
 * webhooks work.
 */

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.post("/:mappingId", async (req, res, next) => {
  try {
    const mapping = await prisma.mapping.findUnique({ where: { id: req.params.mappingId } });

    if (!mapping || mapping.triggerType !== "webhook" || !mapping.webhookSecret) {
      // Deliberately generic 404 — don't reveal whether a mappingId exists
      // vs. exists-but-isn't-webhook-enabled to an unauthenticated caller.
      return res.status(404).json({ error: "Not found" });
    }

    const signature = req.header("X-Webhook-Signature");
    if (!signature) {
      return res.status(401).json({ error: "Missing X-Webhook-Signature header" });
    }

    // req.body is a raw Buffer here (see express.raw() in index.ts for this path)
    const rawBody: Buffer = req.body;
    const expected = crypto.createHmac("sha256", mapping.webhookSecret).update(rawBody).digest("hex");

    if (!timingSafeEqualHex(signature, expected)) {
      logger.warn({ mappingId: mapping.id }, "webhook signature mismatch");
      return res.status(401).json({ error: "Invalid signature" });
    }

    if (!mapping.isActive) {
      return res.status(409).json({ error: "Mapping is not active" });
    }

    const quota = await checkAndReserveQuota(mapping.tenantId);
    if (!quota.allowed) {
      // 429 tells well-behaved webhook senders (Shopify etc.) to back off /
      // stop retrying rather than hammering a tenant that's over quota.
      return res.status(429).json({ error: "Tenant sync quota exceeded" });
    }

    const job = await prisma.job.create({
      data: { tenantId: mapping.tenantId, mappingId: mapping.id, status: "QUEUED" },
    });
    await enqueueSyncJob({ tenantId: mapping.tenantId, mappingId: mapping.id, jobId: job.id });

    res.status(202).json({ jobId: job.id });
  } catch (err) {
    next(err);
  }
});

export default router;
