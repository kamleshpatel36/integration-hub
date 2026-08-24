import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../db/client";
import { encryptCredentials, decryptCredentials } from "./crypto";
import { logger } from "../config/logger";
import { recordAuditLog } from "./auditLog";
import type { BackupConfig } from "@prisma/client";

/**
 * All operational knobs (enabled, schedule, retention, storage target) live
 * in the BackupConfig singleton row, not env vars or code — see
 * src/queue/backupScheduler.ts, which re-reads this row every tick. Editing
 * it via PATCH /api/admin/backup-config takes effect within a minute, no
 * redeploy required. S3 *credentials* can still come from env as a
 * bootstrap default (BACKUP_S3_ACCESS_KEY_ID/SECRET) and be overridden
 * later via the API without touching deploy config.
 */

export async function getBackupConfig(): Promise<BackupConfig> {
  return prisma.backupConfig.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
}

async function resolveS3Credentials(config: BackupConfig): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  if (config.s3CredentialsEnc) {
    return (await decryptCredentials(config.s3CredentialsEnc)) as { accessKeyId: string; secretAccessKey: string };
  }
  return {
    accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY ?? "",
  };
}

export function encryptS3Credentials(creds: { accessKeyId: string; secretAccessKey: string }): Promise<string> {
  return encryptCredentials(creds);
}

/**
 * Runs `pg_dump` in Postgres's custom format (`-Fc`) — already compressed,
 * and restorable/selectively-restorable with `pg_restore` (see README).
 * Requires the `postgresql-client` package in whatever image runs this
 * (the provided Dockerfile installs it) — plain Node buildpacks/Nixpacks
 * generally do NOT have `pg_dump` on PATH, which is why the backup
 * scheduler is deployed as its own Docker-runtime service in render.yaml.
 */
function dumpDatabase(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return reject(new Error("DATABASE_URL is not set"));

    const proc = spawn("pg_dump", ["--no-owner", "--no-acl", "--format=custom", dbUrl]);
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Failed to spawn pg_dump (${err.message}). Is postgresql-client installed? See README "Backups" section.`))
    );
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`pg_dump exited with code ${code}: ${stderr.slice(0, 500)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

async function uploadToS3(config: BackupConfig, filename: string, buffer: Buffer): Promise<string> {
  const creds = await resolveS3Credentials(config);
  if (!creds.accessKeyId || !creds.secretAccessKey || !config.s3Bucket) {
    throw new Error("S3 storage selected but bucket or credentials are not configured");
  }
  const client = new S3Client({ region: config.s3Region || "us-east-1", credentials: creds });
  const key = `backups/${filename}`;
  await client.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: buffer }));
  return `s3://${config.s3Bucket}/${key}`;
}

async function writeLocal(config: BackupConfig, filename: string, buffer: Buffer): Promise<string> {
  const dir = config.localPath || "/var/backups/integration-hub";
  await fs.promises.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fs.promises.writeFile(fullPath, buffer);
  return fullPath;
}

async function deleteBackupObject(config: BackupConfig, location: string): Promise<void> {
  if (location.startsWith("s3://")) {
    const withoutScheme = location.slice("s3://".length);
    const [bucket, ...keyParts] = withoutScheme.split("/");
    const creds = await resolveS3Credentials(config);
    const client = new S3Client({ region: config.s3Region || "us-east-1", credentials: creds });
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyParts.join("/") }));
  } else {
    await fs.promises.unlink(location);
  }
}

/**
 * Deletes successful backups older than retentionDays, but ALWAYS keeps at
 * least the single most recent successful backup regardless of its age —
 * a misconfigured short retention window should never leave zero backups.
 * A storage-deletion failure leaves the BackupRun row in place so it's
 * retried on the next prune pass rather than losing track of the object.
 */
async function pruneOldBackups(config: BackupConfig): Promise<void> {
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
  const successfulRuns = await prisma.backupRun.findMany({
    where: { status: "success" },
    orderBy: { finishedAt: "desc" },
  });

  const [mostRecent, ...older] = successfulRuns;
  if (!mostRecent) return;

  const stale = older.filter((r: (typeof older)[number]) => r.finishedAt && r.finishedAt < cutoff && r.location);

  for (const run of stale) {
    try {
      await deleteBackupObject(config, run.location!);
      await prisma.backupRun.delete({ where: { id: run.id } });
    } catch (err) {
      logger.warn({ runId: run.id, err: (err as Error).message }, "failed to delete stale backup object, will retry next prune cycle");
    }
  }
}

export async function runBackup(trigger: "scheduled" | "manual"): Promise<{ location: string; sizeBytes: number } | null> {
  const config = await getBackupConfig();
  if (!config.enabled && trigger === "scheduled") return null;

  const run = await prisma.backupRun.create({ data: { configId: "default", trigger, status: "running" } });
  const filename = `integration-hub-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;

  try {
    const buffer = await dumpDatabase();
    const location =
      config.storageProvider === "s3" ? await uploadToS3(config, filename, buffer) : await writeLocal(config, filename, buffer);

    await prisma.backupRun.update({
      where: { id: run.id },
      data: { status: "success", finishedAt: new Date(), sizeBytes: buffer.length, location },
    });
    await prisma.backupConfig.update({ where: { id: "default" }, data: { lastRunAt: new Date() } });

    await pruneOldBackups(config);

    logger.info({ location, sizeBytes: buffer.length, trigger }, "backup completed");
    recordAuditLog({
      tenantId: null, actor: trigger === "manual" ? "admin" : "system", action: "backup.completed",
      targetType: "backupRun", targetId: run.id, metadata: { location, sizeBytes: buffer.length, trigger },
    });
    return { location, sizeBytes: buffer.length };
  } catch (err) {
    await prisma.backupRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: (err as Error).message },
    });
    logger.error({ err: (err as Error).message, trigger }, "backup failed");
    recordAuditLog({
      tenantId: null, actor: trigger === "manual" ? "admin" : "system", action: "backup.failed",
      targetType: "backupRun", targetId: run.id, metadata: { error: (err as Error).message, trigger },
    });
    throw err;
  }
}
