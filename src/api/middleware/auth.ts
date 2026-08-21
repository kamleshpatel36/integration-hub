import { Request, Response, NextFunction } from "express";
import { resolveTenantFromApiKey } from "../../services/authService";

// Augment Express Request so downstream routes get typed req.tenantId
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

/**
 * Tenant auth: expects `Authorization: Bearer ih_live_...`.
 * On success, sets req.tenantId — every downstream route MUST scope its
 * Prisma queries with this value, never trust a tenantId from the request
 * body/query for tenant-scoped resources (that would let tenant A read/write
 * tenant B's data just by changing an id in the request).
 */
export async function requireTenantAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const key = header.slice("Bearer ".length);
  const resolved = await resolveTenantFromApiKey(key);
  if (!resolved) {
    return res.status(401).json({ error: "Invalid or revoked API key" });
  }

  req.tenantId = resolved.tenantId;
  next();
}

/**
 * Platform-admin auth for operations that create/manage tenants themselves
 * (e.g. onboarding a new customer, issuing their first API key). Uses a
 * single shared secret — fine while you're the only operator; swap for a
 * real admin-user table + login once you have a support team.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    return res.status(500).json({ error: "ADMIN_API_KEY is not configured on the server" });
  }
  if (key !== expected) {
    return res.status(401).json({ error: "Invalid admin key" });
  }
  next();
}
