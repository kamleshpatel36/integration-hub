// Simple-mode field mapping schema — the same JSON that both "simple" and
// "advanced" UI modes read/write (see product notes: one engine, two editors).

export type TransformType =
  | "direct"          // copy value as-is
  | "uppercase"
  | "lowercase"
  | "concat"          // join multiple source fields with a separator
  | "date_format"      // reformat a date string
  | "static_value"     // ignore source, always emit a fixed value
  | "lookup_table"     // map source value through a static key->value table
  | "custom_js";       // advanced mode only: user-provided JS expression

export interface FieldMappingRule {
  targetField: string;
  transform: TransformType;
  sourceField?: string;          // used by direct/uppercase/lowercase/date_format/lookup_table
  sourceFields?: string[];       // used by concat
  separator?: string;            // used by concat
  dateFormat?: string;           // used by date_format (e.g. "YYYY-MM-DD")
  staticValue?: unknown;         // used by static_value
  lookupTable?: Record<string, unknown>; // used by lookup_table
  customJs?: string;             // used by custom_js — sandboxed eval, advanced mode only
}

export type FieldMappingConfig = FieldMappingRule[];
