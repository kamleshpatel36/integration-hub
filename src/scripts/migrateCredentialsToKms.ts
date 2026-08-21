import "dotenv/config";
import { prisma } from "../db/client";
import { decryptLegacyUnversionedPayload, encryptCredentials } from "../services/crypto";
import { isKmsConfigured } from "../services/kms";
import { logger } from "../config/logger";

/**
 * Run once after switching CREDENTIALS_MASTER_KEY -> KMS_KEY_ID (or any time
 * you just want to confirm everything's on the current format). Safe to
 * re-run: rows already on a versioned format (KMS or tagged static-key) are
 * skipped, not re-encrypted twice.
 *
 *   npm run migrate-credentials-to-kms
 *
 * Requires CREDENTIALS_MASTER_KEY to still be set (even after adding
 * KMS_KEY_ID) — it's what decrypts the OLD unversioned rows this script is
 * migrating away from. Don't remove it from your env until this has run
 * successfully against production.
 */

async function main() {
  if (!isKmsConfigured()) {
    logger.warn(
      "KMS_KEY_ID is not set — this run will re-encrypt legacy rows onto the versioned STATIC-KEY format, not KMS. " +
        "Set KMS_KEY_ID first if the goal is to move onto AWS KMS."
    );
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  const connections = await prisma.connection.findMany();
  for (const conn of connections) {
    try {
      const buf = Buffer.from(conn.credentialsEnc, "base64");
      // A recognized format byte means this row is already on a versioned
      // format (0x01 = tagged static-key, 0x02 = KMS envelope) — nothing to do.
      if (buf[0] === 0x01 || buf[0] === 0x02) {
        skipped++;
        continue;
      }

      const creds = decryptLegacyUnversionedPayload(conn.credentialsEnc);
      const reEncrypted = await encryptCredentials(creds);
      await prisma.connection.update({ where: { id: conn.id }, data: { credentialsEnc: reEncrypted } });
      migrated++;
      logger.info({ connectionId: conn.id, tenantId: conn.tenantId }, "migrated connection credentials");
    } catch (err) {
      failed++;
      logger.error({ connectionId: conn.id, err: (err as Error).message }, "failed to migrate connection credentials");
    }
  }

  const backupConfig = await prisma.backupConfig.findUnique({ where: { id: "default" } });
  if (backupConfig?.s3CredentialsEnc) {
    try {
      const buf = Buffer.from(backupConfig.s3CredentialsEnc, "base64");
      if (buf[0] === 0x01 || buf[0] === 0x02) {
        skipped++;
      } else {
        const creds = decryptLegacyUnversionedPayload(backupConfig.s3CredentialsEnc);
        const reEncrypted = await encryptCredentials(creds);
        await prisma.backupConfig.update({ where: { id: "default" }, data: { s3CredentialsEnc: reEncrypted } });
        migrated++;
        logger.info("migrated backup S3 credentials");
      }
    } catch (err) {
      failed++;
      logger.error({ err: (err as Error).message }, "failed to migrate backup S3 credentials");
    }
  }

  logger.info({ migrated, skipped, failed }, "credential migration complete");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "migration script crashed");
  process.exit(1);
});
