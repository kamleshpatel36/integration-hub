import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../../db/client";
import { requireTenantAuth } from "../middleware/auth";
import { validateCustomJsSyntax } from "../../services/safeExpression";
import { recordAuditLog } from "../../services/auditLog";

const router = Router();
router.use(requireTenantAuth);

const fieldMappingRuleSchema = z.object({
  targetField: z.string(),
  transform: z.enum(["direct", "uppercase", "lowercase", "concat", "date_format", "static_value", "lookup_table", "custom_js"]),
  sourceField: z.string().optional(),
  sourceFields: z.array(z.string()).optional(),
  separator: z.string().optional(),
  dateFormat: z.string().optional(),
  staticValue: z.unknown().optional(),
  lookupTable: z.record(z.unknown()).optional(),
  customJs: z.string().max(500).optional(),
});

const createMappingSchema = z.object({
  name: z.string().min(1),
  sourceConnectionId: z.string().uuid(),
  targetConnectionId: z.string().uuid(),
  sourceObject: z.string().min(1),
  targetObject: z.string().min(1),
  fieldMappings: z.array(fieldMappingRuleSchema),
  triggerType: z.enum(["poll", "webhook", "manual"]).default("poll"),
  pollIntervalSec: z.number().min(60).default(300),
  isActive: z.boolean().optional(),
});

// Confirms both connections referenced in a mapping actually belong to this
// tenant — otherwise tenant A could wire up a mapping that reads/writes
// through tenant B's NetSuite connection just by supplying its id.
async function assertOwnsConnections(tenantId: string, sourceConnectionId: string, targetConnectionId: string) {
  const count = await prisma.connection.count({
    where: { tenantId, id: { in: [sourceConnectionId, targetConnectionId] } },
  });
  if (count !== new Set([sourceConnectionId, targetConnectionId]).size) {
    throw Object.assign(new Error("One or both connections do not belong to this tenant"), { status: 403 });
  }
}

// Rejects a mapping at save-time if any rule uses custom_js with an
// expression that doesn't parse or reaches outside the allowed grammar —
// tenants get the error immediately instead of it surfacing later in a
// failed sync job's log.
function assertCustomJsRulesValid(fieldMappings: z.infer<typeof createMappingSchema>["fieldMappings"]) {
  for (const rule of fieldMappings) {
    if (rule.transform !== "custom_js") continue;
    if (!rule.customJs) {
      throw Object.assign(new Error(`Rule for "${rule.targetField}" uses custom_js but has no expression`), { status: 400 });
    }
    const result = validateCustomJsSyntax(rule.customJs);
    if (!result.valid) {
      throw Object.assign(new Error(`Invalid custom_js expression for "${rule.targetField}": ${result.error}`), { status: 400 });
    }
  }
}

router.post("/", async (req, res, next) => {
  try {
    const body = createMappingSchema.parse(req.body);
    await assertOwnsConnections(req.tenantId!, body.sourceConnectionId, body.targetConnectionId);
    assertCustomJsRulesValid(body.fieldMappings);

    const webhookSecret = body.triggerType === "webhook" ? crypto.randomBytes(24).toString("hex") : undefined;

    const mapping = await prisma.mapping.create({
      data: { ...body, tenantId: req.tenantId!, webhookSecret } as any,
    });

    // webhookSecret is returned in full exactly once here; GET routes below
    // never include it in their response.
    res.status(201).json(mapping);

    recordAuditLog({
      tenantId: req.tenantId, actor: "tenant", action: "mapping.created",
      targetType: "mapping", targetId: mapping.id,
      metadata: { name: body.name, sourceObject: body.sourceObject, targetObject: body.targetObject, ruleCount: body.fieldMappings.length },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const mappings = await prisma.mapping.findMany({
      where: { tenantId: req.tenantId! },
      include: {
        sourceConnection: { select: { label: true, connectorType: true } },
        targetConnection: { select: { label: true, connectorType: true } },
      },
    });
    res.json(mappings.map(({ webhookSecret, ...m }: { webhookSecret: string | null; [key: string]: unknown }) => m));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const mapping = await prisma.mapping.findFirstOrThrow({
      where: { id: req.params.id, tenantId: req.tenantId! },
      include: { sourceConnection: true, targetConnection: true },
    });
    const { webhookSecret, ...safeMapping } = mapping;
    res.json({
      ...safeMapping,
      sourceConnection: { ...mapping.sourceConnection, credentialsEnc: undefined },
      targetConnection: { ...mapping.targetConnection, credentialsEnc: undefined },
    });
  } catch (err) {
    next(err);
  }
});

// Regenerate a mapping's webhook signing secret (invalidates the old one).
// Returned in full exactly once, same as at creation time.
router.post("/:id/webhook-secret/rotate", async (req, res, next) => {
  try {
    const existing = await prisma.mapping.findFirstOrThrow({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (existing.triggerType !== "webhook") {
      return res.status(400).json({ error: "Mapping is not configured for webhook triggers" });
    }
    const webhookSecret = crypto.randomBytes(24).toString("hex");
    await prisma.mapping.update({ where: { id: existing.id }, data: { webhookSecret } });
    res.json({ webhookSecret });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const body = createMappingSchema.partial().parse(req.body);
    if (body.fieldMappings) {
      assertCustomJsRulesValid(body.fieldMappings);
    }
    if (body.sourceConnectionId || body.targetConnectionId) {
      const existing = await prisma.mapping.findFirstOrThrow({
        where: { id: req.params.id, tenantId: req.tenantId! },
      });
      await assertOwnsConnections(
        req.tenantId!,
        body.sourceConnectionId ?? existing.sourceConnectionId,
        body.targetConnectionId ?? existing.targetConnectionId
      );
    }

    const result = await prisma.mapping.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId! },
      data: body as any,
    });
    if (result.count === 0) return res.status(404).json({ error: "Mapping not found" });
    const mapping = await prisma.mapping.findUniqueOrThrow({ where: { id: req.params.id } });
    res.json(mapping);

    recordAuditLog({
      tenantId: req.tenantId, actor: "tenant",
      action: body.isActive === false ? "mapping.paused" : body.isActive === true ? "mapping.resumed" : "mapping.updated",
      targetType: "mapping", targetId: mapping.id,
      metadata: { name: mapping.name, changedFields: Object.keys(body) },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.mapping.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    const result = await prisma.mapping.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (result.count === 0) return res.status(404).json({ error: "Mapping not found" });
    res.status(204).send();

    if (existing) {
      recordAuditLog({
        tenantId: req.tenantId, actor: "tenant", action: "mapping.deleted",
        targetType: "mapping", targetId: req.params.id, metadata: { name: existing.name },
      });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
