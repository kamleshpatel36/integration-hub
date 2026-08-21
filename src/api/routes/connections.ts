import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";
import { encryptCredentials, decryptCredentials } from "../../services/crypto";
import { createConnector } from "../../connectors/factory";
import { requireTenantAuth } from "../middleware/auth";

const router = Router();
router.use(requireTenantAuth);

const createConnectionSchema = z.object({
  connectorType: z.enum(["NETSUITE", "SHOPIFY", "SALESFORCE", "GENERIC_REST"]),
  label: z.string().min(1),
  credentials: z.record(z.unknown()),
});

router.post("/", async (req, res, next) => {
  try {
    const body = createConnectionSchema.parse(req.body);
    const credentialsEnc = await encryptCredentials(body.credentials);

    const connection = await prisma.connection.create({
      data: {
        tenantId: req.tenantId!,
        connectorType: body.connectorType,
        label: body.label,
        credentialsEnc,
        status: "pending",
      },
    });

    const connector = createConnector(body.connectorType, body.credentials);
    const result = await connector.testConnection();

    const updated = await prisma.connection.update({
      where: { id: connection.id },
      data: { status: result.ok ? "connected" : "error", lastCheckedAt: new Date() },
    });

    res.status(201).json({ ...updated, credentialsEnc: undefined, testResult: result });
  } catch (err) {
    next(err);
  }
});

// Every lookup below is scoped by BOTH id and tenantId — this is what stops
// tenant A from testing/reading tenant B's connection by guessing/enumerating
// a UUID.
router.post("/:id/test", async (req, res, next) => {
  try {
    const connection = await prisma.connection.findFirstOrThrow({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    const connector = createConnector(connection.connectorType, await decryptCredentials(connection.credentialsEnc));
    const result = await connector.testConnection();

    await prisma.connection.update({
      where: { id: connection.id },
      data: { status: result.ok ? "connected" : "error", lastCheckedAt: new Date() },
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/objects", async (req, res, next) => {
  try {
    const connection = await prisma.connection.findFirstOrThrow({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    const connector = createConnector(connection.connectorType, await decryptCredentials(connection.credentialsEnc));
    const objectTypes = await connector.listObjectTypes();
    res.json(objectTypes);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/objects/:objectType/fields", async (req, res, next) => {
  try {
    const connection = await prisma.connection.findFirstOrThrow({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    const connector = createConnector(connection.connectorType, await decryptCredentials(connection.credentialsEnc));
    const fields = await connector.listFields(req.params.objectType);
    res.json(fields);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const connections = await prisma.connection.findMany({
      where: { tenantId: req.tenantId! },
      select: { id: true, connectorType: true, label: true, status: true, lastCheckedAt: true, createdAt: true },
    });
    res.json(connections);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const result = await prisma.connection.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (result.count === 0) return res.status(404).json({ error: "Connection not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
