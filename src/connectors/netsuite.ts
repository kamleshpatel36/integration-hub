import crypto from "crypto";
import { BaseConnector, ConnectorConfig, FieldDescriptor, ReadOptions, ReadResult } from "./base";

/**
 * NetSuite connector — SuiteTalk REST Web Services. Supports two auth modes,
 * selected via `config.authType`:
 *
 * "oauth2" (default if authType is omitted, for backwards compatibility):
 * {
 *   authType: "oauth2",
 *   accountId: "1234567",
 *   clientId: "...", clientSecret: "...", refreshToken: "...",
 *   accessToken: "...",        // optional — auto-fetched if missing/expired
 *   tokenExpiresAt: "2026-08-20T12:00:00Z"  // optional, same reason
 * }
 *
 * "oauth1" (Token-Based Authentication / TBA — no refresh flow; every
 * request is individually signed with the consumer secret + token secret,
 * so there's no access token to expire or refresh):
 * {
 *   authType: "oauth1",
 *   accountId: "1234567",
 *   consumerKey: "...", consumerSecret: "...",
 *   tokenId: "...", tokenSecret: "..."
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
  private get isOAuth1(): boolean {
    return this.config.authType === "oauth1";
  }

  private get baseUrl(): string {
    const accountId = (this.config.accountId as string).toLowerCase().replace(/_/g, "-");
    return `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1`;
  }

  /**
   * Builds the Authorization header for one request. OAuth 1.0a's signature
   * is computed over the exact HTTP method + URL (including query string)
   * of THIS request, so — unlike a bearer token — it can't be built once
   * and reused; every call site passes its own method/url.
   */
  private async buildAuthHeaders(method: string, url: string): Promise<Record<string, string>> {
    const authHeader = this.isOAuth1 ? this.buildOAuth1Header(method, url) : await this.buildOAuth2Header();
    return { Authorization: authHeader, "Content-Type": "application/json" };
  }

  private async buildOAuth2Header(): Promise<string> {
    await this.refreshAuthIfNeeded();
    return `Bearer ${this.config.accessToken}`;
  }

  /**
   * OAuth 1.0a (RFC 5849) HMAC-SHA256 signing — the algorithm NetSuite's
   * Token-Based Authentication requires. Built from scratch here rather
   * than pulling in an oauth-1.0a npm package, since the whole thing is
   * ~30 lines and it's one less third-party dependency handling secrets.
   */
  private buildOAuth1Header(method: string, fullUrl: string): string {
    const url = new URL(fullUrl);
    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (queryParams[key] = value));
    const baseUrlNoQuery = `${url.origin}${url.pathname}`;

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.config.consumerKey as string,
      oauth_token: this.config.tokenId as string,
      oauth_signature_method: "HMAC-SHA256",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_nonce: crypto.randomBytes(16).toString("hex"),
      oauth_version: "1.0",
    };

    // Signature base string: METHOD & percent-encoded base URL & percent-encoded,
    // alphabetically-sorted "key=value" params (oauth params + any query params)
    const allParams = { ...oauthParams, ...queryParams };
    const paramString = Object.keys(allParams)
      .sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
      .join("&");
    const baseString = [method.toUpperCase(), percentEncode(baseUrlNoQuery), percentEncode(paramString)].join("&");

    const signingKey = `${percentEncode(this.config.consumerSecret as string)}&${percentEncode(this.config.tokenSecret as string)}`;
    const signature = crypto.createHmac("sha256", signingKey).update(baseString).digest("base64");

    const authParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
    const headerParams = Object.keys(authParams)
      .map((key) => `${percentEncode(key)}="${percentEncode(authParams[key])}"`)
      .join(", ");

    // realm is the NetSuite account ID — required by NetSuite's TBA implementation,
    // not strictly part of the OAuth 1.0a spec's signature computation.
    return `OAuth realm="${this.config.accountId}", ${headerParams}`;
  }

  async refreshAuthIfNeeded(): Promise<void> {
    if (this.isOAuth1) return; // TBA has no refresh flow — tokens don't expire this way

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
      const url = `${this.baseUrl}/customer?limit=1`;
      const headers = await this.buildAuthHeaders("GET", url);
      const resp = await fetch(url, { headers });
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
    const url = `https://${this.config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/${objectType}`;
    const headers = await this.buildAuthHeaders("GET", url);
    const resp = await fetch(url, { headers: { ...headers, Accept: "application/schema+json" } });
    if (!resp.ok) throw new Error(`Failed to fetch metadata for ${objectType}: ${resp.status}`);
    const schema = (await resp.json()) as { properties?: Record<string, { type: string }> };
    return Object.entries(schema.properties ?? {}).map(([name, def]) => ({
      name,
      label: name,
      type: mapNsTypeToFieldType(def.type),
      isCustom: isCustomNetSuiteField(name),
    }));
  }

  async read(objectType: string, options: ReadOptions): Promise<ReadResult> {
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

    const url = `${this.baseUrl}/${objectType}?${params.toString()}`;
    const headers = await this.buildAuthHeaders("GET", url);
    const resp = await fetch(url, { headers });
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
    const isUpdate = Boolean(record.id);
    const url = isUpdate ? `${this.baseUrl}/${objectType}/${record.id}` : `${this.baseUrl}/${objectType}`;
    const method = isUpdate ? "PATCH" : "POST";
    const headers = await this.buildAuthHeaders(method, url);
    const resp = await fetch(url, { method, headers, body: JSON.stringify(record) });
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

/**
 * NetSuite's standard custom-field prefixes — a field starting with any of
 * these was added via customization on this specific account, rather than
 * being part of every account's base record schema for this type.
 */
function isCustomNetSuiteField(fieldName: string): boolean {
  return /^cust(entity|body|col|item|record|page)_/i.test(fieldName);
}

/**
 * OAuth 1.0a percent-encoding (RFC 3986) — stricter than JS's built-in
 * encodeURIComponent, which leaves `!*'()` unescaped. The OAuth 1.0a spec
 * requires those encoded too, or NetSuite will reject the signature as
 * invalid (it computes the same base string on its end and compares).
 */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
