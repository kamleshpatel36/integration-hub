import "dotenv/config";
import { prisma } from "../db/client";
import { getBackupConfig, runBackup } from "../services/backupService";
import { isBackupDue } from "../services/cronSchedule";
import { logger } from "../config/logger";

/**
 * Runs as its own process/service (see render.yaml: integration-hub-backup).
 * Deliberately re-reads BackupConfig from Postgres every tick instead of
 * caching it in memory — this is what makes `PATCH /api/admin/backup-config`
 * take effect within a minute with no restart or redeploy. The alternative
 * (in-memory node-cron job re-registered on config change) would work too,
 * but this way there's a single source of truth and no risk of the
 * in-memory schedule drifting from what's actually stored.
 */

const TICK_INTERVAL_MS = 60_000;

async function tick() {
  const config = await getBackupConfig();
  if (!config.enabled) return;

  if (isBackupDue(config.cronSchedule, config.lastRunAt)) {
    logger.info({ cronSchedule: config.cronSchedule }, "scheduled backup is due, running now");
    try {
      await runBackup("scheduled");
    } catch (err) {
      // runBackup already recorded the failure on the BackupRun row;
      // logging here is just for the process's own stdout/alerting.
      logger.error({ err: (err as Error).message }, "scheduled backup run failed");
    }
  }
}

async function main() {
  logger.info("Backup scheduler starting...");
  await tick();
  setInterval(() => {
    tick().catch((err) => logger.error({ err }, "backup scheduler tick failed"));
  }, TICK_INTERVAL_MS);
}

/**
 * Exported so index.ts can start this in-process on a single free Web
 * Service instead of requiring a separate paid Background Worker.
 * Deliberately does NOT process.exit on failure — that would kill the API
 * server sharing this process when run inline.
 */
export async function startBackupScheduler(): Promise<void> {
  await main();
}

if (require.main === module) {
  startBackupScheduler().catch((err) => {
    logger.error({ err }, "backup scheduler crashed");
    process.exit(1);
  });
}
