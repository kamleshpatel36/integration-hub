import { prisma } from "../db/client";
import { logger } from "../config/logger";

/**
 * Records an entry in the Activity Log. Deliberately fire-and-forget: a
 * logging failure should never fail the actual request that triggered it
 * (creating a connection shouldn't 500 because the audit write hiccuped),
 * so this catches its own errors and just logs them.
 *
 * `metadata` must never contain credentials or other secrets — it's stored
 * as plain JSON and displayed directly in the Activity Log UI. Stick to
 * small, human-readable context (a label, a connector type, a record count).
 */
export function recordAuditLog(entry: {
  tenantId?: string | null;
  actor: "tenant" | "admin" | "system";
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): void {
  prisma.auditLog
    .create({
      data: {
        tenantId: entry.tenantId ?? null,
        actor: entry.actor,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata as any,
      },
    })
    .catch((err: Error) => {
      logger.warn({ err: err.message, action: entry.action }, "failed to write audit log entry");
    });
}
