import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import tenantsRouter from "./api/routes/tenants";
import connectionsRouter from "./api/routes/connections";
import mappingsRouter from "./api/routes/mappings";
import jobsRouter from "./api/routes/jobs";
import apiKeysRouter from "./api/routes/apiKeys";
import webhooksRouter from "./api/routes/webhooks";
import adminBackupRouter from "./api/routes/adminBackup";
import adminRouter from "./api/routes/admin";
import { startWorkerProcess } from "./queue/worker";
import { startPollScheduler } from "./queue/scheduler";
import { startBackupScheduler } from "./queue/backupScheduler";

const app = express();

app.use(cors());
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Standalone mapping UI — plain HTML/CSS/JS, no build step, served directly
// from this API so it's same-origin (no CORS complications) and permanently
// available at /mapping-ui/ once deployed. See public/mapping-ui/index.html.
app.use("/mapping-ui", express.static(path.join(__dirname, "../public/mapping-ui")));

// IMPORTANT: mounted with express.raw() and BEFORE the global express.json()
// below — HMAC signature verification needs the exact raw request bytes.
// If this router were mounted after express.json(), req.body would already
// be a parsed object and signature verification would break.
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRouter);

app.use(express.json());

app.use("/api/tenants", tenantsRouter);
app.use("/api/connections", connectionsRouter);
app.use("/api/mappings", mappingsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/api-keys", apiKeysRouter);
app.use("/api/admin/backup-config", adminBackupRouter);
app.use("/api/admin", adminRouter);

// Centralized error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "unhandled API error");
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  logger.info(`Integration Hub API listening on :${port}`);
});

/**
 * Runs the BullMQ worker, poll scheduler, and backup scheduler INSIDE this
 * same process — for deployments on Render's Free plan, where Background
 * Workers aren't available without a paid Starter instance. Opt-in via
 * RUN_INLINE_WORKERS=true; leave unset (the default) when deploying the
 * separate integration-hub-worker / -scheduler / -backup services from
 * render.yaml, so work doesn't run twice.
 *
 * Trade-offs versus separate services (acceptable for a low-volume pilot,
 * worth revisiting before real production load): the sync workload shares
 * CPU/memory with the API's request handling instead of scaling
 * independently, and a crash in one no longer isolates from the others —
 * though each start*Process() function already avoids process.exit() for
 * exactly this reason.
 */
if (process.env.RUN_INLINE_WORKERS === "true") {
  logger.info("RUN_INLINE_WORKERS=true — starting worker, poll scheduler, and backup scheduler in-process");
  startWorkerProcess().catch((err) => logger.error({ err }, "inline worker process failed to start"));
  startPollScheduler();
  startBackupScheduler().catch((err) => logger.error({ err }, "inline backup scheduler failed to start"));
}
