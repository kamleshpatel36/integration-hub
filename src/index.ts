import "dotenv/config";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import tenantsRouter from "./api/routes/tenants";
import connectionsRouter from "./api/routes/connections";
import mappingsRouter from "./api/routes/mappings";
import jobsRouter from "./api/routes/jobs";
import apiKeysRouter from "./api/routes/apiKeys";
import webhooksRouter from "./api/routes/webhooks";
import adminBackupRouter from "./api/routes/adminBackup";

const app = express();

app.use(cors());
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => res.json({ ok: true }));

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

// Centralized error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "unhandled API error");
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  logger.info(`Integration Hub API listening on :${port}`);
});
