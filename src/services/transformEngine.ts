import { FieldMappingConfig, FieldMappingRule } from "../types/mapping";
import { evaluateSafeExpression } from "./safeExpression";

/**
 * Applies a FieldMappingConfig to a source record, producing a target record.
 * This is the single engine both simple-mode and advanced-mode UIs feed into.
 */
export function applyMapping(
  sourceRecord: Record<string, unknown>,
  mapping: FieldMappingConfig
): Record<string, unknown> {
  const target: Record<string, unknown> = {};

  for (const rule of mapping) {
    target[rule.targetField] = applyRule(sourceRecord, rule);
  }

  return target;
}

function applyRule(source: Record<string, unknown>, rule: FieldMappingRule): unknown {
  switch (rule.transform) {
    case "direct":
      return rule.sourceField ? source[rule.sourceField] : undefined;

    case "uppercase":
      return rule.sourceField ? String(source[rule.sourceField] ?? "").toUpperCase() : undefined;

    case "lowercase":
      return rule.sourceField ? String(source[rule.sourceField] ?? "").toLowerCase() : undefined;

    case "concat":
      return (rule.sourceFields ?? [])
        .map((f) => source[f] ?? "")
        .join(rule.separator ?? " ")
        .trim();

    case "date_format": {
      if (!rule.sourceField) return undefined;
      const raw = source[rule.sourceField];
      if (!raw) return undefined;
      const d = new Date(raw as string);
      if (isNaN(d.getTime())) return raw; // pass through if unparseable, don't silently drop data
      return formatDate(d, rule.dateFormat ?? "YYYY-MM-DD");
    }

    case "static_value":
      return rule.staticValue;

    case "lookup_table": {
      if (!rule.sourceField) return undefined;
      const key = String(source[rule.sourceField] ?? "");
      return rule.lookupTable?.[key] ?? null;
    }

    case "custom_js":
      if (!rule.customJs) return undefined;
      // evaluateSafeExpression throws UnsafeExpressionError for anything
      // outside the allowed grammar — let it propagate so the job fails
      // loudly (visible in Job.errorMessage) rather than silently coercing
      // to null. Save-time validation (mappings.ts route) should have
      // already rejected malformed expressions before they got this far;
      // this is defense in depth for existing saved mappings.
      return evaluateSafeExpression(rule.customJs, { fields: source });

    default:
      return undefined;
  }
}

function formatDate(d: Date, pattern: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
  };
  return pattern.replace(/YYYY|MM|DD/g, (m) => map[m]);
}
