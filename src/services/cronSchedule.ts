import { CronExpressionParser } from "cron-parser";

/** Throws if the expression doesn't parse — used for save-time validation in the admin API. */
export function assertValidCronExpression(expr: string): void {
  CronExpressionParser.parse(expr); // throws on invalid input
}

/**
 * True if a job on `cronSchedule` should have already fired at least once
 * since `lastRunAt` (or has never run at all). Pure function, no I/O — the
 * scheduler re-evaluates this against freshly-read config every tick, which
 * is what makes editing the schedule take effect live instead of requiring
 * a process restart.
 */
export function isBackupDue(cronSchedule: string, lastRunAt: Date | null, now: Date = new Date()): boolean {
  if (!lastRunAt) return true;
  const interval = CronExpressionParser.parse(cronSchedule, { currentDate: lastRunAt });
  const nextFireTime = interval.next().toDate();
  return now.getTime() >= nextFireTime.getTime();
}
