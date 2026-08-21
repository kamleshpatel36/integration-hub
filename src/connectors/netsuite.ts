import { BaseConnector, ConnectorConfig, FieldDescriptor, ReadOptions, ReadResult } from "./base";

/**
 * NetSuite connector — SuiteTalk REST Web Services, OAuth 2.0 client credentials.
 *
 * Expected config shape (stored encrypted in Connection.credentialsEnc, decrypted
 * before this class is instantiated):
 * {
 *   accountId: "1234567",          // NetSuite account id, e.g. "TSTDRV1234567"
 *   accessToken: "...",
 *   refreshToken: "...",
 *   tokenExpiresAt: "2026-08-20T12:00:00Z",
 *   clientId: "...",
 *   clientSecret: "..."
 * }
 *
 * NOTE ON GOVERNANCE: NetSuite enforces per-account concurrency limits (typically
 * 5-15 concurrent requests depending on account tier/SuiteCloud Plus) and
 * SuiteTalk usage-unit governance. This connector does NOT itself throttle —
 * that's handled one layer up by the tenant-aware queue (see src/queue), which
 * caps concurrent workers per tenant BELOW NetSuite's limit so we get queued
 * jobs instead of 429/SSS_REQUEST_LIMIT_EXCEEDED errors.
 */
export class NetSuiteConnector extends BaseConnector {
  private get baseUrl(): string {
    const accountId = (this.config.accountId as string).toLowerCase().replace(/_/g, "-");
    return `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1`;
  }

  private async authHeader(): Promise<Record<string, string>> {
    await this.refreshAuthIfNeeded();
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async refreshAuthIfNeeded(): Promise<void> {
    const expiresAt = this.config.tokenExpiresAt
      ? new Date(this.config.tokenExpiresAt as string)
      : null;
    if (!expiresAt || expiresAt.getTime() - Date.now() > 60_000) return; // still valid for >60s

    const resp = await fetch(`https://${this.config.accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken as string,
        client_id: this.config.clientId as string,
        client_secret: this.config.clientSecret as string,
      }),
    });

    if (!resp.ok) {
      throw new Error(`NetSuite token refresh failed: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as { access_token: string; expires_in: number };
    this.config.accessToken = data.access_token;
    this.config.tokenExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    // Caller (ConnectionService) is responsible for persisting the refreshed
    // token back to the encrypted store — see services/connectionService.ts
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      const headers = await this.authHeader();
      const resp = await fetch(`${this.baseUrl}/customer?limit=1`, { headers });
      if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listObjectTypes(): Promise<string[]> {
    // Common record types — extend as needed. A fuller implementation would
    // introspect via the metadata catalog (/record/v1/metadata-catalog).
    return ["customer", "salesorder", "invoice", "item", "vendor", "vendorbill"];
  }

  async listFields(objectType: string): Promise<FieldDescriptor[]> {
    const headers = await this.authHeader();
    const resp = await fetch(
      `https://${this.config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/${objectType}`,
      { headers: { ...headers, Accept: "application/schema+json" } }
    );
    if (!resp.ok) throw new Error(`Failed to fetch metadata for ${objectType}: ${resp.status}`);
    const schema = (await resp.json()) as { properties?: Record<string, { type: string }> };
    return Object.entries(schema.properties ?? {}).map(([name, def]) => ({
      name,
      label: name,
      type: mapNsTypeToFieldType(def.type),
    }));
  }

  async read(objectType: string, options: ReadOptions): Promise<ReadResult> {
    const headers = await this.authHeader();
    // SuiteQL is generally better for bulk reads than record/v1 list endpoints,
    // but record/v1 is simpler for MVP. Swap in SuiteQL (/services/rest/query/v1/suiteql)
    // once volume requires it.
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("offset", options.cursor);
    if (options.since) {
      // NetSuite record/v1 doesn't support since-filters natively per record type;
      // for incremental sync, prefer SuiteQL with `lastmodifieddate >= ?`.
    }

    const resp = await fetch(`${this.baseUrl}/${objectType}?${params.toString()}`, { headers });
    if (!resp.ok) {
      if (resp.status === 429) {
        throw new Error("NETSUITE_RATE_LIMITED"); // caught by worker, triggers backoff+retry
      }
      throw new Error(`NetSuite read failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as { items: Record<string, unknown>[]; hasMore: boolean; offset: number };
    return {
      records: data.items,
      nextCursor: data.hasMore ? String(data.offset + data.items.length) : undefined,
    };
  }

  async write(objectType: string, record: Record<string, unknown>): Promise<string> {
    const headers = await this.authHeader();
    const isUpdate = Boolean(record.id);
    const url = isUpdate ? `${this.baseUrl}/${objectType}/${record.id}` : `${this.baseUrl}/${objectType}`;
    const resp = await fetch(url, {
      method: isUpdate ? "PATCH" : "POST",
      headers,
      body: JSON.stringify(record),
    });
    if (!resp.ok) {
      if (resp.status === 429) throw new Error("NETSUITE_RATE_LIMITED");
      throw new Error(`NetSuite write failed: ${resp.status} ${await resp.text()}`);
    }
    // record/v1 returns the new id in the Location header on create
    const location = resp.headers.get("Location");
    const id = location ? location.split("/").pop()! : (record.id as string);
    return id;
  }
}

function mapNsTypeToFieldType(nsType: string): FieldDescriptor["type"] {
  switch (nsType) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}
