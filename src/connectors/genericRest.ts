import { BaseConnector, FieldDescriptor, ReadOptions, ReadResult } from "./base";

/**
 * Generic REST connector — config-driven, works against any JSON REST API
 * that takes a bearer/API-key header. Use this as the starting point for
 * Shopify/Salesforce-style connectors, or as an escape hatch for target
 * systems you haven't built a dedicated connector for yet.
 *
 * Expected config:
 * {
 *   baseUrl: "https://mystore.myshopify.com/admin/api/2024-01",
 *   authHeader: "X-Shopify-Access-Token",   // or "Authorization"
 *   authValue: "shpat_xxx",                  // or "Bearer xxx"
 *   listPath: (objectType) => `/${objectType}.json`,
 * }
 */
export class GenericRestConnector extends BaseConnector {
  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      const resp = await fetch(this.config.baseUrl as string, { headers: this.headers() });
      return { ok: resp.status < 500 };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private headers(): Record<string, string> {
    return {
      [this.config.authHeader as string]: this.config.authValue as string,
      "Content-Type": "application/json",
    };
  }

  async listObjectTypes(): Promise<string[]> {
    return (this.config.knownObjectTypes as string[]) ?? [];
  }

  async listFields(_objectType: string): Promise<FieldDescriptor[]> {
    // Generic REST APIs don't expose schema uniformly; for MVP, fields are
    // defined manually in the mapping UI (free-text field name entry) rather
    // than introspected. Dedicated connectors (Shopify, Salesforce) override
    // this with real schema calls.
    return [];
  }

  async read(objectType: string, options: ReadOptions): Promise<ReadResult> {
    const url = new URL(`${this.config.baseUrl}/${objectType}.json`);
    if (options.limit) url.searchParams.set("limit", String(options.limit));
    if (options.cursor) url.searchParams.set("page_info", options.cursor);

    const resp = await fetch(url.toString(), { headers: this.headers() });
    if (!resp.ok) {
      if (resp.status === 429) throw new Error("TARGET_RATE_LIMITED");
      throw new Error(`Read failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const key = objectType + "s"; // naive pluralization; override per real connector
    const records = (data[key] as Record<string, unknown>[]) ?? [];
    return { records };
  }

  async write(objectType: string, record: Record<string, unknown>): Promise<string> {
    const isUpdate = Boolean(record.id);
    const url = `${this.config.baseUrl}/${objectType}${isUpdate ? `/${record.id}` : ""}.json`;
    const resp = await fetch(url, {
      method: isUpdate ? "PUT" : "POST",
      headers: this.headers(),
      body: JSON.stringify({ [objectType]: record }),
    });
    if (!resp.ok) {
      if (resp.status === 429) throw new Error("TARGET_RATE_LIMITED");
      throw new Error(`Write failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as Record<string, any>;
    return String(data[objectType]?.id ?? record.id);
  }
}
