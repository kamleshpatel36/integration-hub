import jsep from "jsep";

/**
 * SANDBOXED evaluator for the `custom_js` mapping transform.
 *
 * Design choice: this is deliberately NOT a real JavaScript sandbox
 * (isolated-vm / vm2 / Node's vm module). Those run actual JS with a global
 * scope and require careful context-escape hardening, timeouts, and memory
 * limits to be safe for untrusted tenant-authored code — and have a history
 * of sandbox-escape CVEs.
 *
 * Instead, jsep parses only a single EXPRESSION (no `if`, no loops, no
 * function declarations, no assignment — the grammar cannot express them).
 * We then walk the resulting AST ourselves and only evaluate an explicit
 * allowlist of node types, so "what this code can do" is fully enumerable
 * by reading this file, not "whatever the JS engine permits minus what we
 * blocked." No loops are expressible, so there's no infinite-loop DoS
 * vector to guard against with timeouts.
 *
 * Available to tenant expressions:
 *   - `fields.someField` — read-only access to the source record
 *   - arithmetic: + - * / %
 *   - comparison: == != === !== < <= > >=
 *   - logical: && || !
 *   - ternary: cond ? a : b
 *   - a small whitelist of pure helper functions (see HELPERS below)
 *
 * NOT available: any other identifier (no `window`, `process`, `require`,
 * `constructor`, etc.), assignment, `new`, function literals, loops.
 */

const MAX_AST_NODES = 200; // guards against absurdly large expressions, not a timing concern (no loops exist)
const MAX_EXPRESSION_LENGTH = 500;

type EvalContext = { fields: Record<string, unknown> };

const HELPERS: Record<string, (...args: any[]) => unknown> = {
  upper: (v: unknown) => String(v ?? "").toUpperCase(),
  lower: (v: unknown) => String(v ?? "").toLowerCase(),
  trim: (v: unknown) => String(v ?? "").trim(),
  substr: (v: unknown, start: number, len?: number) => String(v ?? "").substr(start, len),
  concat: (...args: unknown[]) => args.map((a) => String(a ?? "")).join(""),
  coalesce: (...args: unknown[]) => args.find((a) => a !== null && a !== undefined && a !== ""),
  toNumber: (v: unknown) => {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  },
  toString: (v: unknown) => (v === null || v === undefined ? "" : String(v)),
  length: (v: unknown) => String(v ?? "").length,
};

const ALLOWED_BINARY_OPS = new Set(["+", "-", "*", "/", "%", "==", "!=", "===", "!==", "<", "<=", ">", ">="]);
const ALLOWED_LOGICAL_OPS = new Set(["&&", "||"]);
const ALLOWED_UNARY_OPS = new Set(["!", "-", "+"]);

export class UnsafeExpressionError extends Error {}

/**
 * Validates an expression parses and contains only allowed constructs,
 * WITHOUT evaluating it against real data. Call this at mapping save-time
 * so tenants get immediate feedback on a bad expression instead of a
 * failure buried in a later sync job's error log.
 */
export function validateCustomJsSyntax(expression: string): { valid: true } | { valid: false; error: string } {
  try {
    assertLength(expression);
    const ast = jsep(expression);
    assertNodeAllowed(ast, 0);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

export function evaluateSafeExpression(expression: string, context: EvalContext): unknown {
  assertLength(expression);
  const ast = jsep(expression);
  assertNodeAllowed(ast, 0);
  return evalNode(ast, context);
}

function assertLength(expression: string) {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new UnsafeExpressionError(`Expression exceeds max length of ${MAX_EXPRESSION_LENGTH} characters`);
  }
}

let nodeCount = 0;

// Pre-walks the tree to confirm every node type/identifier is on the
// allowlist BEFORE any evaluation happens — evaluation never encounters a
// node it doesn't already know is safe.
function assertNodeAllowed(node: any, depth: number): void {
  if (depth === 0) nodeCount = 0;
  nodeCount++;
  if (nodeCount > MAX_AST_NODES) {
    throw new UnsafeExpressionError(`Expression too complex (max ${MAX_AST_NODES} nodes)`);
  }

  switch (node.type) {
    case "Literal":
      return;
    case "Identifier":
      if (node.name !== "fields" && !(node.name in HELPERS)) {
        throw new UnsafeExpressionError(`Identifier "${node.name}" is not allowed`);
      }
      return;
    case "MemberExpression":
      if (node.computed) {
        throw new UnsafeExpressionError("Computed member access (fields[x]) is not allowed — use fields.x");
      }
      assertNodeAllowed(node.object, depth + 1);
      // node.property is a bare Identifier used as a key name, not evaluated
      // as a variable reference — don't run it through the Identifier check.
      if (node.property.type !== "Identifier") {
        throw new UnsafeExpressionError("Invalid property access");
      }
      return;
    case "CallExpression":
      if (node.callee.type !== "Identifier" || !(node.callee.name in HELPERS)) {
        throw new UnsafeExpressionError(`Function "${node.callee.name ?? "?"}" is not in the allowed helper list`);
      }
      node.arguments.forEach((arg: any) => assertNodeAllowed(arg, depth + 1));
      return;
    case "BinaryExpression":
      if (!ALLOWED_BINARY_OPS.has(node.operator)) {
        throw new UnsafeExpressionError(`Operator "${node.operator}" is not allowed`);
      }
      assertNodeAllowed(node.left, depth + 1);
      assertNodeAllowed(node.right, depth + 1);
      return;
    case "LogicalExpression":
      if (!ALLOWED_LOGICAL_OPS.has(node.operator)) {
        throw new UnsafeExpressionError(`Operator "${node.operator}" is not allowed`);
      }
      assertNodeAllowed(node.left, depth + 1);
      assertNodeAllowed(node.right, depth + 1);
      return;
    case "UnaryExpression":
      if (!ALLOWED_UNARY_OPS.has(node.operator)) {
        throw new UnsafeExpressionError(`Unary operator "${node.operator}" is not allowed`);
      }
      assertNodeAllowed(node.argument, depth + 1);
      return;
    case "ConditionalExpression":
      assertNodeAllowed(node.test, depth + 1);
      assertNodeAllowed(node.consequent, depth + 1);
      assertNodeAllowed(node.alternate, depth + 1);
      return;
    default:
      // Explicitly rejects: AssignmentExpression, ArrayExpression,
      // ObjectExpression, ThisExpression, NewExpression, Compound (jsep's
      // sequence-expression node), and anything else not covered above.
      throw new UnsafeExpressionError(`Expression construct "${node.type}" is not allowed`);
  }
}

function evalNode(node: any, context: EvalContext): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      if (node.name === "fields") return context.fields;
      // Bare helper-function names as values (not called) evaluate to
      // undefined — only CallExpression invokes them.
      return undefined;
    case "MemberExpression": {
      const obj = evalNode(node.object, context) as Record<string, unknown> | undefined;
      const key = node.property.name as string;
      return obj?.[key] ?? null;
    }
    case "CallExpression": {
      const fn = HELPERS[node.callee.name as string];
      const args = node.arguments.map((a: any) => evalNode(a, context));
      return fn(...args);
    }
    case "BinaryExpression": {
      const l = evalNode(node.left, context) as any;
      const r = evalNode(node.right, context) as any;
      switch (node.operator) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        case "%":
          return l % r;
        case "==":
          return l == r;
        case "!=":
          return l != r;
        case "===":
          return l === r;
        case "!==":
          return l !== r;
        case "<":
          return l < r;
        case "<=":
          return l <= r;
        case ">":
          return l > r;
        case ">=":
          return l >= r;
      }
      return undefined;
    }
    case "LogicalExpression": {
      const l = evalNode(node.left, context) as any;
      if (node.operator === "&&") return l ? evalNode(node.right, context) : l;
      if (node.operator === "||") return l ? l : evalNode(node.right, context);
      return undefined;
    }
    case "UnaryExpression": {
      const arg = evalNode(node.argument, context) as any;
      switch (node.operator) {
        case "!":
          return !arg;
        case "-":
          return -arg;
        case "+":
          return +arg;
      }
      return undefined;
    }
    case "ConditionalExpression":
      return evalNode(node.test, context) ? evalNode(node.consequent, context) : evalNode(node.alternate, context);
    default:
      // Unreachable in practice: assertNodeAllowed already rejected anything
      // that would land here, at validation time, before evaluation started.
      throw new UnsafeExpressionError(`Expression construct "${node.type}" is not allowed`);
  }
}
