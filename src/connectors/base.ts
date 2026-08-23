/**
 * Every connector (NetSuite, Shopify, Salesforce, generic REST...) implements
 * this interface. The mapping engine and workers only ever talk to this
 * interface, never to a specific system directly — that's what makes adding
 * a new target a plug-in instead of a rewrite.
 */

export interface FieldDescriptor {
  name: string;
  label: string;
  type: "string" | "number" | "date" | "boolean" | "reference";
  /** True for account-specific custom fields (e.g. NetSuite's custentity_/custbody_/
   *  custcol_/custitem_/custrecord_ prefixed fields) as opposed to fields every
   *  account of that record type has. Lets the mapping UI group them separately. */
  isCustom?: boolean;
}

export interface ConnectorConfig {
  [key: string]: unknown;
}

export interface ReadOptions {
  filters?: Record<string, unknown>;
  since?: Date; // incremental sync support
  limit?: number;
  cursor?: string;
}

export interface ReadResult {
  records: Record<string, unknown>[];
  nextCursor?: string;
}

export abstract class BaseConnector {
  protected config: ConnectorConfig;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  /** Verify credentials work; used on connection setup + health checks. */
  abstract testConnection(): Promise<{ ok: boolean; message?: string }>;

  /** List available object/record types this connector exposes (for mapping UI). */
  abstract listObjectTypes(): Promise<string[]>;

  /** List fields for a given object type (for mapping UI dropdowns). */
  abstract listFields(objectType: string): Promise<FieldDescriptor[]>;

  /** Read records for sync. */
  abstract read(objectType: string, options: ReadOptions): Promise<ReadResult>;

  /** Write (create/update) a single record. Returns the target-system record id. */
  abstract write(objectType: string, record: Record<string, unknown>): Promise<string>;

  /** Refresh OAuth token if the connector uses token-based auth. No-op otherwise. */
  async refreshAuthIfNeeded(): Promise<void> {
    return;
  }
}
