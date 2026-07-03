/**
 * Pure derivations for the config-review screen (slice C5) — everything computed from
 * a retained `cfg` body lives here, unit-testable without React.
 *
 * Redaction contract (reconciliation "redaction v1", displayed — never reversed):
 *  - the library publisher replaced secret VALUES (`password`/`pin`/messaging
 *    credentials) with the literal `"***"` before the cfg ever hit the bus — the
 *    console renders those as masked-redacted, never as a real value;
 *  - `$secret` REFERENCES (e.g. `"$secret:api-key"`) travel untouched by design —
 *    they are pointers into the vault, not values — and are labeled as such.
 */

/** How a leaf value must be presented. */
export type ValueKind = "value" | "redacted" | "secret-ref";

/** One row of the Structured tab: dotted path -> displayable leaf. */
export interface ConfigRow {
  /** Dotted/indexed path, e.g. `messaging.local.credentials.password`, `targets[0].url`. */
  path: string;
  /** The display string (unquoted scalars; `[]`/`{}` for empty containers). */
  display: string;
  kind: ValueKind;
}

/** The library's redaction sentinel (redaction v1). */
const REDACTED_SENTINEL = "***";

/**
 * Unwrap the effective config from a `cfg` envelope body. The shipped publisher sends
 * `{"config": {...}}`; anything else (defensive) is shown as-is rather than hidden.
 */
export function effectiveConfig(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if ("config" in obj) return obj.config;
  }
  return body;
}

/** Classify one leaf value (see the module's redaction contract). */
export function classifyValue(value: unknown): ValueKind {
  if (value === REDACTED_SENTINEL) return "redacted";
  if (typeof value === "string" && value.startsWith("$secret")) return "secret-ref";
  return "value";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displayScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return String(value);
}

/**
 * Flatten a config value into Structured-tab rows: depth-first, keys in document
 * order (the publisher's order is the schema's order — don't re-sort), arrays as
 * `path[i]`, empty containers as single `[]`/`{}` rows.
 */
export function flattenConfig(value: unknown, prefix = ""): ConfigRow[] {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return prefix === "" ? [] : [{ path: prefix, display: "{}", kind: "value" }];
    }
    return keys.flatMap((k) => flattenConfig(value[k], prefix === "" ? k : `${prefix}.${k}`));
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return prefix === "" ? [] : [{ path: prefix, display: "[]", kind: "value" }];
    }
    return value.flatMap((v, i) => flattenConfig(v, `${prefix === "" ? "" : prefix}[${i}]`));
  }
  const path = prefix === "" ? "(value)" : prefix;
  return [{ path, display: displayScalar(value), kind: classifyValue(value) }];
}

/** Redaction tallies for the "N values redacted" note. */
export interface RedactionCounts {
  redacted: number;
  secretRefs: number;
}

export function redactionCounts(rows: ConfigRow[]): RedactionCounts {
  let redacted = 0;
  let secretRefs = 0;
  for (const row of rows) {
    if (row.kind === "redacted") redacted++;
    else if (row.kind === "secret-ref") secretRefs++;
  }
  return { redacted, secretRefs };
}

/** One syntax-treatment token of the Raw JSON tab. */
export interface JsonToken {
  text: string;
  kind: "punct" | "key" | "string" | "number" | "literal" | "redacted" | "secret-ref";
}

/**
 * Pretty-print a value as syntax-classified JSON tokens (2-space indent). Joining the
 * `text`s yields valid JSON verbatim — including the literal `"***"` sentinels, which
 * (like `$secret` refs) carry their own token kind so the view can style them as
 * redacted/reference rather than as ordinary strings.
 */
export function jsonTokens(value: unknown, depth = 0): JsonToken[] {
  const pad = "  ".repeat(depth);
  const padInner = "  ".repeat(depth + 1);

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return [{ text: "{}", kind: "punct" }];
    const tokens: JsonToken[] = [{ text: "{\n", kind: "punct" }];
    keys.forEach((k, i) => {
      tokens.push({ text: padInner, kind: "punct" });
      tokens.push({ text: JSON.stringify(k), kind: "key" });
      tokens.push({ text: ": ", kind: "punct" });
      tokens.push(...jsonTokens(value[k], depth + 1));
      tokens.push({ text: i < keys.length - 1 ? ",\n" : "\n", kind: "punct" });
    });
    tokens.push({ text: `${pad}}`, kind: "punct" });
    return tokens;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ text: "[]", kind: "punct" }];
    const tokens: JsonToken[] = [{ text: "[\n", kind: "punct" }];
    value.forEach((v, i) => {
      tokens.push({ text: padInner, kind: "punct" });
      tokens.push(...jsonTokens(v, depth + 1));
      tokens.push({ text: i < value.length - 1 ? ",\n" : "\n", kind: "punct" });
    });
    tokens.push({ text: `${pad}]`, kind: "punct" });
    return tokens;
  }
  if (typeof value === "string") {
    const kind = classifyValue(value);
    return [{ text: JSON.stringify(value), kind: kind === "value" ? "string" : kind }];
  }
  if (typeof value === "number") return [{ text: JSON.stringify(value), kind: "number" }];
  // true / false / null — and any non-JSON oddity degrades to `null` honestly.
  return [{ text: JSON.stringify(value ?? null), kind: "literal" }];
}
