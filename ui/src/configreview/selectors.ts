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

/* -----------------------------------------------------------------------------
 * R4 — the GENUINELY HIERARCHICAL structured view.
 *
 * `flattenConfig` (above) produces a FLAT dotted-path list — kept only for the
 * redaction tally + the "N redacted" note. The Structured TAB now renders the
 * effective config as a real nested TREE: {@link buildConfigTree} yields nested
 * object/array container nodes (expand/collapse) down to redaction-classified
 * leaves, so `messaging → local → credentials → password` is four nested rows, and
 * `component.instances[]` is an array node whose items are structured object
 * entries — not a single `messaging.local.credentials.password` string.
 * --------------------------------------------------------------------------- */

/** A config tree node is a container (object/array) or a value leaf. */
export type ConfigNodeKind = "object" | "array" | "leaf";

/** One node of the nested Structured tree (see {@link buildConfigTree}). */
export interface ConfigTreeNode {
  /** The key (object child) or `[i]` (array item) shown at this level. */
  label: string;
  /** Full dotted/indexed path — stable React key + expansion identity. */
  path: string;
  kind: ConfigNodeKind;
  /** Leaf only: the display string (unquoted scalars; `{}`/`[]` for empty containers). */
  display?: string;
  /** Leaf only: the redaction classification (see the module's redaction contract). */
  valueKind?: ValueKind;
  /** Container only: child nodes in document order. */
  children?: ConfigTreeNode[];
  /** Container only: a collapsed-row summary (`2 keys` / `3 items`). */
  summary?: string;
}

/** Build one node for `value` under `label`/`path` (recursive). */
function nodeFor(label: string, path: string, value: unknown): ConfigTreeNode {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return { label, path, kind: "leaf", display: "{}", valueKind: "value" };
    const children = keys.map((k) => nodeFor(k, path === "" ? k : `${path}.${k}`, value[k]));
    return {
      label,
      path,
      kind: "object",
      children,
      summary: `${keys.length} ${keys.length === 1 ? "key" : "keys"}`,
    };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { label, path, kind: "leaf", display: "[]", valueKind: "value" };
    const children = value.map((v, i) => nodeFor(`[${i}]`, `${path}[${i}]`, v));
    return {
      label,
      path,
      kind: "array",
      children,
      summary: `${value.length} ${value.length === 1 ? "item" : "items"}`,
    };
  }
  return { label, path, kind: "leaf", display: displayScalar(value), valueKind: classifyValue(value) };
}

/**
 * Build the top-level nodes of the effective config (children of the root
 * object/array). A scalar root yields a single `(value)` leaf; an empty root
 * yields `[]` (no rows). Document order is preserved (the publisher's order = the
 * schema's order — never re-sorted).
 */
export function buildConfigTree(value: unknown): ConfigTreeNode[] {
  if (isPlainObject(value)) {
    return Object.keys(value).map((k) => nodeFor(k, k, value[k]));
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => nodeFor(`[${i}]`, `[${i}]`, v));
  }
  return [nodeFor("(value)", "(value)", value)];
}

/**
 * The container paths to expand by default: nested OBJECTS down to `maxDepth`
 * (0-based), leaving ARRAYS collapsed (the mockup shows `instances[]` folded to a
 * `2 items` summary the operator opens on demand). So the top of the tree is
 * visibly nested while long lists stay compact.
 */
export function defaultExpandedPaths(
  nodes: ConfigTreeNode[],
  maxDepth: number,
  depth = 0,
  acc: Set<string> = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    if (node.kind === "object" && node.children !== undefined && depth < maxDepth) {
      acc.add(node.path);
      defaultExpandedPaths(node.children, maxDepth, depth + 1, acc);
    }
  }
  return acc;
}

/** Canonical JSON (object keys sorted) — the stable input to {@link configHash}. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A stable content fingerprint of the effective config — an 8-hex FNV-1a hash over
 * canonical JSON (keys sorted, so key ORDER doesn't change it, but any VALUE does).
 * CONSOLE-COMPUTED and labeled as such: the `cfg` envelope carries no publisher
 * hash, so this is an honest console-side drift key ("did the effective config
 * change since I last fetched it?"), never a claimed publisher-supplied digest.
 */
export function configHash(value: unknown): string {
  const text = canonicalJson(value);
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
