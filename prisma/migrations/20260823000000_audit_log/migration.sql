-- Adds the audit_logs table (AuditLog model). Hand-authored for the same
-- reason as the initial migration (see prisma/migrations/20260101000000_init) —
-- verify by applying directly with psql before shipping.

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "tenantId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- Deliberately NO foreign key to tenants — audit history should survive
-- independent of the referenced tenant/connection/mapping's lifecycle, and
-- tenantId is nullable for platform-level (admin) actions.
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");
