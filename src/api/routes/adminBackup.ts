import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requireAdmin } from "../middleware/auth";
import { getBackupConfig, runBackup, encryptS3Credentials } from "../../services/backupService";
import { assertValidCronExpression } from "../../services/cronSchedule";

const router = Router();
router.use(requireAdmin);

function toSafeConfig(config: Awaited<ReturnType<typeof getBackupConfig>>) {
  const { s3CredentialsEnc, ...safe } = config;
  return { ...safe, s3CredentialsSet: Boolean(s3CredentialsEnc) };
}

router.get("/", async (_req, res, next) => {
  try {
    const config = await getBackupConfig();
    res.json(toSafeConfig(config));
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  cronSchedule: z.string().optional(),
  retentionDays: z.number().min(1).max(365).optional(),
  storageProvider: z.enum(["s3", "local"]).optional(),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3Credentials: z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).optional(),
  localPath: z.string().optional(),
});

// Every field here is a live config change, not a deploy-time setting —
// takes effect the next time the backup scheduler ticks (within a minute).
router.patch("/", async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);

    if (body.cronSchedule) {
      try {
        assertValidCronExpression(body.cronSchedule);
      } catch (err) {
        return res.status(400).json({ error: `Invalid cron expression: ${(err as Error).message}` });
      }
    }

    const { s3Credentials, ...rest } = body;
    const data: Record<string, unknown> = { ...rest };
    if (s3Credentials) {
      data.s3CredentialsEnc = await encryptS3Credentials(s3Credentials);
    }

    const config = await prisma.backupConfig.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });

    res.json(toSafeConfig(config));
  } catch (err) {
    next(err);
  }
});

// Runs immediately regardless of `enabled` or the cron schedule — useful for
// "does this actually work" verification right after configuring storage.
router.post("/run-now", async (_req, res, next) => {
  try {
    const result = await runBackup("manual");
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/history", async (_req, res, next) => {
  try {
    const runs = await prisma.backupRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 30,
    });
    res.json(runs);
  } catch (err) {
    next(err);
  }
});

export default router;
