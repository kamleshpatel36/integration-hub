# Integration Hub — MVP

Multi-tenant iPaaS-style middleware. Tenants connect their own NetSuite account
and their own target system (Shopify/Salesforce/generic REST), define field
mappings, and the platform syncs data on a schedule, webhook, or manual trigger.

## Architecture (3 processes)

1. **API** (`npm run dev`) — Express REST API. Tenant/connection/mapping CRUD,
   manual job triggers, usage dashboard.
2. **Worker** (`npm run worker`) — dynamically spins up one BullMQ Worker per
   tenant, sized by that tenant's plan (concurrency + jobs/min). This is the
   load-balancing + rate-limiting layer.
3. **Scheduler** (`npm run scheduler`) — cron tick every minute; enqueues sync
   jobs for mappings on `triggerType: "poll"` whose interval has elapsed.

All three read from the same Postgres + Redis, so they can be deployed as
separate containers and scaled independently (e.g. more worker replicas as
tenant count grows, API stays lean).

## How load balancing + quota control actually work here

- **Per-tenant queue** (`tenant:{tenantId}` in Redis via BullMQ) — isolates one
  tenant's job backlog from another's.
- **Per-tenant concurrency cap** (`Plan.maxConcurrentJobs`) — set below
  NetSuite's own account concurrency limit, so we self-throttle instead of
  triggering NetSuite 429 / `SSS_REQUEST_LIMIT_EXCEEDED`.
- **Per-tenant rate limit** (`Plan.rateLimitPerMin`) — this is your product's
  usage-limit control: Free/Pro/Enterprise tiers get different throughput,
  enforced by BullMQ's `limiter` option on the Worker.
- **Monthly sync quota** (`Plan.monthlySyncQuota`) — checked in
  `quotaService.checkAndReserveQuota()` before every job is enqueued (both
  manual triggers and scheduler ticks respect it).

**Scaling beyond MVP**: one-queue-per-tenant is simple and fine to a few
hundred tenants. Past that, move to a single shared queue with a
token-bucket-per-tenant check at dequeue time — noted here so it's not a
surprise rewrite later.

## Setup

```bash
npm install
cp .env.example .env
# generate CREDENTIALS_MASTER_KEY and paste into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# start Postgres + Redis locally (or point DATABASE_URL/REDIS_URL at managed instances)
npx prisma migrate dev --name init
npx prisma db seed

# run all three processes (separate terminals)
npm run dev
npm run worker
npm run scheduler
```

## What's stubbed / needs real implementation before production

- `custom_js` transform is now enabled — see "Custom expressions" below for
  what it can and can't do. `GenericRestConnector`'s `listFields()` still
  needs real schema introspection once you have real Shopify/Salesforce
  customers.
- NetSuite connector uses `record/v1` for reads; swap in SuiteQL
  (`/services/rest/query/v1/suiteql`) once you need incremental sync
  (`lastmodifieddate >=`) or higher-volume bulk reads.
- Credential encryption supports AWS KMS envelope encryption (see
  "Credential encryption (KMS)" below) — falls back to a static local key
  when `KMS_KEY_ID` isn't set, which is fine for local dev but should be
  configured before handling production customer secrets.
- Auth is API-key based with tenant isolation (see "Auth" below).
- Webhook-triggered mappings are supported (see "Webhook-triggered syncs"
  below) — HMAC-SHA256 verified.

## Auth

- `POST /api/tenants` and `POST /api/api-keys/tenants/:tenantId/bootstrap` require
  an `X-Admin-Key` header matching `ADMIN_API_KEY` (your onboarding-only operations).
- Every other tenant-scoped route requires `Authorization: Bearer ih_live_...`.
  The middleware resolves this to `req.tenantId`; routes never trust a
  tenantId supplied in the request body or query string.
- A tenant can self-issue additional keys via `POST /api/api-keys` (once they
  have their bootstrap key) and revoke via `DELETE /api/api-keys/:id`.

## Webhook-triggered syncs

Create a mapping with `"triggerType": "webhook"` — the response includes a
one-time `webhookSecret`. Give the external system this URL and secret:

```
POST https://your-host/api/webhooks/{mappingId}
X-Webhook-Signature: <hex HMAC-SHA256 of the raw request body, keyed with webhookSecret>
```

The route verifies the signature with a timing-safe comparison before
enqueueing a sync — same pattern as Stripe/GitHub/Shopify webhooks. If you
lose the secret, rotate it: `POST /api/mappings/:id/webhook-secret/rotate`
(old secret stops working immediately).

## Custom expressions (`custom_js` transform)

Advanced-mode field rules can use `transform: "custom_js"` with a
`customJs` expression string, e.g.:

```
upper(fields.firstName) + " " + upper(fields.lastName)
fields.age >= 18 ? "adult" : "minor"
coalesce(fields.region, "unknown")
```

This is NOT a JavaScript sandbox (no `isolated-vm`/`vm2`/Node `vm`) — it's a
restricted expression parser ([jsep](https://github.com/EricSmekens/jsep))
whose grammar can only express a single expression, never statements, loops,
or function declarations. `src/services/safeExpression.ts` then walks the
parsed AST against an explicit allowlist before evaluating anything.

Allowed: arithmetic, comparisons, `&&`/`||`/`!`, ternaries, `fields.x`
member access, and a fixed helper list (`upper`, `lower`, `trim`, `substr`,
`concat`, `coalesce`, `toNumber`, `toString`, `length`).

Blocked by construction: any other identifier (`process`, `require`,
`constructor`, etc.), computed member access (`fields[x]`), assignment,
`new`, and any function call not in the helper list. No loops exist in the
grammar, so there's no infinite-loop DoS vector to guard with a timeout —
node-count and string-length caps handle the rest.

Expressions are validated at mapping save-time (`POST`/`PATCH
/api/mappings`) so a bad expression is rejected immediately with a 400,
not discovered later in a failed sync job's error log.



```
src/
  connectors/       BaseConnector interface + NetSuite, generic REST, factory
  services/         transform engine, quota checks, credential encryption
  queue/            BullMQ queue manager, worker (load balancer), scheduler
  api/routes/       Express routes: tenants, connections, mappings, jobs
  db/               Prisma client singleton
prisma/
  schema.prisma     Tenant, Plan, Connection, Mapping, Job, UsageCounter
  seed.ts           seeds free/pro/enterprise plans
```

## Deploying (Render Blueprint)

`render.yaml` at the repo root defines all five pieces — API, worker,
scheduler, Postgres, Redis — as one deployable unit.

1. Push this project to a GitHub repo (private is fine).
2. On [render.com](https://render.com), **New > Blueprint**, connect the repo.
   Render reads `render.yaml` and shows all 5 resources it's about to create
   — review and click **Apply**.
3. `CREDENTIALS_MASTER_KEY` and `ADMIN_API_KEY` are auto-generated by the
   Blueprint (see `envVarGroups` in `render.yaml`) — you don't set these
   yourself. After the first deploy, copy `ADMIN_API_KEY`'s value from the
   `integration-hub-shared` env group in the Render dashboard; you'll need it
   for onboarding.
4. Wait for all 3 services to finish deploying (the API service's build
   command runs `prisma migrate deploy`, so your schema is live once it's green).
5. Seed the three plans — open a shell on the `integration-hub-api` service
   in the Render dashboard and run:
   ```
   npx prisma db seed
   ```
6. Confirm it's alive: `curl https://<your-api>.onrender.com/health` → `{"ok":true}`
7. Create your first tenant (replace `<ADMIN_KEY>` and `<API_URL>`):
   ```
   curl -X POST https://<API_URL>/api/tenants \
     -H "X-Admin-Key: <ADMIN_KEY>" -H "Content-Type: application/json" \
     -d '{"name":"Pilot Customer","planId":"pro"}'
   ```
8. Issue their first API key (use the tenant `id` from step 7):
   ```
   curl -X POST https://<API_URL>/api/api-keys/tenants/<TENANT_ID>/bootstrap \
     -H "X-Admin-Key: <ADMIN_KEY>"
   ```
   The response's `apiKey` is shown once — hand it to the tenant now.
9. Point the `MappingBuilder` artifact's "Base URL" at `https://<API_URL>/api`
   and paste that key in to start building mappings against the real API.

**Before inviting real pilot customers**, at minimum: set up AWS KMS and run
the migration script (see "Credential encryption (KMS)" below), enable and
verify automatic backups (see "Automatic database backups" below — run
`POST /api/admin/backup-config/run-now` once and confirm it lands in S3),
and add an uptime monitor hitting `/health`.

## Automatic database backups

Backups run as their own service (`integration-hub-backup` in `render.yaml`)
and every operational setting — on/off, schedule, retention, storage target
— lives in the `BackupConfig` DB row, not env vars or code. The scheduler
re-reads that row every minute, so changing it via the admin API takes
effect within a minute with **no restart or redeploy**.

**Enable it** (replace `<ADMIN_KEY>` / `<API_URL>`):
```
curl -X PATCH https://<API_URL>/api/admin/backup-config \
  -H "X-Admin-Key: <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "cronSchedule": "0 3 * * *",
    "retentionDays": 30,
    "storageProvider": "s3",
    "s3Bucket": "your-backup-bucket",
    "s3Region": "us-east-1",
    "s3Credentials": { "accessKeyId": "...", "secretAccessKey": "..." }
  }'
```
Omit `s3Credentials` to fall back to the `BACKUP_S3_ACCESS_KEY_ID` /
`BACKUP_S3_SECRET_ACCESS_KEY` env vars set in the Render Blueprint — either
works, and you can switch between them anytime without redeploying.

**Other endpoints** (all admin-key gated):
- `GET /api/admin/backup-config` — current settings (credentials never returned, just `s3CredentialsSet: true/false`)
- `POST /api/admin/backup-config/run-now` — trigger an immediate backup, bypasses the `enabled` flag and schedule
- `GET /api/admin/backup-config/history` — last 30 runs with status, size, and storage location

**How pruning works**: on every successful backup, runs older than
`retentionDays` get deleted from storage (S3 or local disk) and their DB
record removed — except the single most recent successful backup is always
kept, even if it's past the retention window, so a misconfigured short
retention never leaves you with zero backups. If a storage deletion fails
(e.g. transient S3 error), the DB record is left in place and retried on
the next successful backup.

**Restoring**: backups are `pg_dump --format=custom` (`.dump` files),
restored with `pg_restore`:
```
# from S3
aws s3 cp s3://your-backup-bucket/backups/integration-hub-2026-08-21T03-00-00-000Z.dump ./backup.dump
pg_restore --clean --if-exists --no-owner --no-acl -d "$DATABASE_URL" ./backup.dump
```
Restoring is deliberately a manual, deliberate action — there's no
automated restore endpoint, since an API-triggered restore is exactly the
kind of action a compromised admin key should NOT be able to take unattended.

**Why this needs its own Docker-runtime service**: `pg_dump`/`pg_restore`
aren't present in Node buildpacks/Nixpacks. `render.yaml` runs all four app
services from the same `Dockerfile` (which installs `postgresql-client`)
with per-service `dockerCommand` overrides — this also guarantees the
Prisma engine binary is identical across all four instead of potentially
drifting between a Nixpacks build and a Docker one.

## Credential encryption (KMS)

Tenant connection credentials (and backup S3 credentials) are encrypted
before they touch Postgres. Two backends, chosen automatically based on
whether `KMS_KEY_ID` is set:

- **Static local key** (`CREDENTIALS_MASTER_KEY`) — AES-256-GCM with a key
  in an env var. Fine for local dev. If this is still the only backend in
  production, the app logs a warning once at startup (check your logs).
- **AWS KMS envelope encryption** (`KMS_KEY_ID` set) — the actual master
  key (a KMS CMK) never leaves AWS. Each encrypt call asks KMS to generate
  a fresh 256-bit data key, uses it locally for AES-256-GCM, stores only
  the *KMS-wrapped* data key alongside the ciphertext, and zeroes the
  plaintext data key from memory immediately after. A database leak alone
  can't decrypt anything without also having IAM access to call
  `kms:Decrypt` on that specific key — which you can revoke or audit
  independently (CloudTrail logs every decrypt call) without touching the
  database at all.

Every stored payload has a 1-byte format tag, so switching `KMS_KEY_ID` on
doesn't break reading rows encrypted before the switch — it only changes
which backend *new* writes use.

### Setting up AWS KMS

1. Create a symmetric KMS key (console: **KMS > Create key**, or CLI:
   `aws kms create-key --description "integration-hub credential encryption"`).
   Note the key's ARN.
2. Create an IAM user (or role, if your deploy target supports it) with a
   policy scoped to just this key and just the two operations the app uses:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
       "Resource": "arn:aws:kms:us-east-1:123456789012:key/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
     }]
   }
   ```
   Generate an access key for this user.
3. Set `KMS_KEY_ID` (the ARN from step 1), `AWS_REGION`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — in `render.yaml`'s shared
   env group if deploying there, or your `.env` locally.
4. Redeploy (or restart locally). From this point, all *new* encrypt calls
   use KMS. Existing rows still decrypt fine via the static-key fallback —
   nothing breaks — but they're not benefiting from KMS yet.
5. Migrate existing rows onto KMS:
   ```
   npm run migrate-credentials-to-kms
   ```
   On Render, run this from a shell on the `integration-hub-api` service
   (it needs `DATABASE_URL`, `CREDENTIALS_MASTER_KEY`, and the KMS env vars
   all present, which it already has there). It's idempotent — re-running
   skips anything already migrated, so it's safe to run again if a prior
   run partially failed.
6. **Don't remove `CREDENTIALS_MASTER_KEY`** from your env even after
   migrating — keep it around in case you ever need to run the migration
   script again (e.g. against a restored backup taken before the migration).
# integration-hub
