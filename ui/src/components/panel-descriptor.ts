/**
 * Descriptor-renderer v2 primitives (edge-console-panels.md §4/§4.1) — the pure,
 * console-owned vocabulary the Panel widgets share:
 *
 *  - the CLOSED `rendererRequirements` token set and the view-level gate check;
 *  - dot-path resolution into command results / rows (no array indexing, expressions,
 *    or JSONPath; prototype keys rejected; a missing path renders an em dash);
 *  - the closed formats enum (`text`, `number`, `duration-ms`, `timestamp`, `boolean`,
 *    `quality`, `address`, `badge`) — unknown formats fall back to plain text, never crash;
 *  - command availability resolution (§4.1): missing verb → unavailable; absent
 *    `availability` or `state:"available"` → available; `disabled`/`unsupported` →
 *    disable and surface the SANITIZED reason;
 *  - the closed `refresh` object (`onEnter`/`manual`/`intervalMs` clamped ≥ 2 s; auto
 *    refresh only for read-only verbs — discovery tables are manual-only);
 *  - the `commandTable.controls[]` schema check + prototype-safe request assembly
 *    (`integer-range` emits exactly a two-integer inclusive array; `select` reads static
 *    options or an `optionsSource` from the already-loaded Configuration tab data);
 *  - lifecycle optimistic UI gates (§4.1 table) computed from the latest `sb/status`;
 *  - eventFeed family/limit/filter rules and metricSeries aggregation.
 *
 * Everything here is pure (no React, no IO) so the closed vocabularies are unit-testable
 * on their own; the widgets in `ComponentDetailView` render on top of these.
 */
import type {
  ComponentDescribeManifest,
  CommandError,
  MetricPoint,
  PanelViewDescriptor,
  PanelWidgetDescriptor,
} from "@edgecommons/edge-console-protocol";

/** The em dash rendered for a missing/unknown field (edge-console-panels.md §4). */
export const EM_DASH = "—";

/* -----------------------------------------------------------------------------
 * rendererRequirements — the view-level gate (§4, spec token set).
 * --------------------------------------------------------------------------- */

/**
 * The ONLY requirement tokens this console knows (the closed initial set). A view
 * declaring any other token renders the single "requires a newer edge-console" state.
 */
export const KNOWN_RENDERER_REQUIREMENTS: ReadonlySet<string> = new Set([
  "instance-selector.v1",
  "command-availability.v1",
  "status-dashboard.v1",
  "action-bar.v1",
  "command-table.v1",
  "metric-series.v1",
  "event-feed.v1",
  "tree-columns.v1",
  "signal-columns.v1",
]);

/**
 * The tokens of a view's `rendererRequirements` this console does NOT know.
 * `undefined` when the view declares no requirements (render as before); an empty
 * array when every declared token is known (mount normally); a non-empty array
 * when the view must be gated (non-string entries count as unknown).
 */
export function unknownRequirementTokens(view: PanelViewDescriptor): string[] | undefined {
  const declared = view.rendererRequirements;
  if (!Array.isArray(declared)) return undefined;
  return declared
    .filter((t) => typeof t !== "string" || !KNOWN_RENDERER_REQUIREMENTS.has(t))
    .map((t) => sanitizeText(typeof t === "string" ? t : JSON.stringify(t), 64) ?? "(invalid)");
}

/* -----------------------------------------------------------------------------
 * Sanitizing — reasons, confirm text, and error messages are display-safe plain text.
 * --------------------------------------------------------------------------- */

/**
 * Sanitize component-provided display text: plain text only (control characters
 * stripped, whitespace collapsed, bounded length). `undefined` for anything that is
 * not a non-empty string.
 */
export function sanitizeText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/* -----------------------------------------------------------------------------
 * Paths — dot-separated keys into a JSON object. No array indexing, expressions,
 * functions, or JSONPath; prototype keys are rejected; arrays are never traversed.
 * --------------------------------------------------------------------------- */

const FORBIDDEN_PATH_TOKENS = new Set(["__proto__", "prototype", "constructor"]);
const PATH_TOKEN_REJECT = /[[\]$*()]/;
const MAX_PATH_LENGTH = 128;
const MAX_PATH_DEPTH = 8;

/** Whether `path` is a valid closed dot-path (`protocol.arState`). */
export function isSafePath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH_LENGTH) return false;
  const tokens = path.split(".");
  if (tokens.length > MAX_PATH_DEPTH) return false;
  return tokens.every(
    (t) => t !== "" && !PATH_TOKEN_REJECT.test(t) && !FORBIDDEN_PATH_TOKENS.has(t),
  );
}

/**
 * Resolve a dot-path into a JSON object, own-properties only. Anything invalid or
 * missing — bad path, non-object step, array step (indexing is prohibited) — is
 * `undefined` (the caller renders the em dash).
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!isSafePath(path)) return undefined;
  let current: unknown = root;
  for (const token of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, token)) return undefined;
    current = record[token];
  }
  return current;
}

/* -----------------------------------------------------------------------------
 * Formats — the closed console-owned enum. Unknown format → plain text (no crash);
 * missing value → the em dash.
 * --------------------------------------------------------------------------- */

/** The status tones a formatted tag can carry (console-owned closed set). */
export type StatusTone = "ok" | "warn" | "error" | "info" | "neutral";

/** One formatted cell value, ready for the shared renderer. */
export interface FormattedValue {
  /** The display text (the em dash when `missing`). */
  text: string;
  /** True when the field was missing/null (em-dash rule). */
  missing: boolean;
  /** How to render: plain text, mono text, or a status tag. */
  kind: "plain" | "mono" | "tag";
  /** The tag tone (only for `kind:"tag"`). */
  tone?: StatusTone;
}

const STATUS_TONE_SYNONYMS: Record<string, StatusTone> = {
  ok: "ok",
  good: "ok",
  green: "ok",
  online: "ok",
  warn: "warn",
  warning: "warn",
  uncertain: "warn",
  degraded: "warn",
  error: "error",
  err: "error",
  bad: "error",
  red: "error",
  critical: "error",
  info: "info",
  blue: "info",
  neutral: "neutral",
  gray: "neutral",
  grey: "neutral",
};

function scalarText(value: unknown, max = 160): string {
  if (typeof value === "string") return sanitizeText(value, max) ?? EM_DASH;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : EM_DASH;
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return sanitizeText(JSON.stringify(value), max) ?? EM_DASH;
  } catch {
    return EM_DASH;
  }
}

function formatNumberText(value: number): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 100_000 || abs < 0.01)) return value.toExponential(2);
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatDurationMsText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

/**
 * Format one resolved value per the closed formats enum. `statusMap` (own-properties
 * only) maps the RAW value's string form to a status tone; a mapped value renders as
 * a toned tag carrying the formatted text. Unknown formats fall back to plain text.
 */
export function formatPanelValue(
  value: unknown,
  format?: string,
  unit?: string,
  statusMap?: unknown,
): FormattedValue {
  if (value === undefined || value === null) return { text: EM_DASH, missing: true, kind: "plain" };

  let text: string;
  let kind: FormattedValue["kind"] = "plain";
  let tone: StatusTone | undefined;

  switch (format) {
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) text = formatNumberText(value);
      else text = scalarText(value);
      break;
    case "duration-ms":
      if (typeof value === "number" && Number.isFinite(value)) text = formatDurationMsText(value);
      else text = scalarText(value);
      break;
    case "timestamp":
      if (typeof value === "number" && Number.isFinite(value)) text = new Date(value).toISOString();
      else text = scalarText(value);
      kind = "mono";
      break;
    case "boolean":
      if (typeof value === "boolean") text = value ? "Yes" : "No";
      else text = scalarText(value);
      break;
    case "quality": {
      text = scalarText(value);
      kind = "tag";
      const norm = typeof value === "string" ? value.toLowerCase() : "";
      tone = norm === "good" ? "ok" : norm === "uncertain" ? "warn" : norm === "bad" ? "error" : "neutral";
      break;
    }
    case "badge":
      text = scalarText(value);
      kind = "tag";
      tone = "neutral";
      break;
    case "address":
      text = scalarText(value);
      kind = "mono";
      break;
    default:
      // `text` and every UNKNOWN format: plain text rendering, visible value, no crash.
      text = scalarText(value);
      break;
  }

  // statusMap: raw value → tone (console-owned tone vocabulary, lenient synonyms).
  if (statusMap !== null && typeof statusMap === "object" && !Array.isArray(statusMap)) {
    const raw = typeof value === "boolean" ? String(value) : scalarText(value);
    const map = statusMap as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(map, raw)) {
      const mapped = map[raw];
      const mappedTone = typeof mapped === "string" ? STATUS_TONE_SYNONYMS[mapped.toLowerCase()] : undefined;
      kind = "tag";
      tone = mappedTone ?? "neutral";
    }
  }

  if (unit !== undefined && unit !== "" && kind !== "tag" && text !== EM_DASH) {
    text = `${text} ${unit}`;
  }
  return { text, missing: false, kind, ...(tone !== undefined ? { tone } : {}) };
}

/* -----------------------------------------------------------------------------
 * Command availability (§4.1) — the ONE resolution every command-bound widget/action uses.
 * --------------------------------------------------------------------------- */

/** The resolved availability of one advertised verb for UI binding purposes. */
export type CommandAvailabilityState =
  | { status: "unavailable" }
  | { status: "available" }
  | { status: "disabled"; reason?: string }
  | { status: "unsupported"; reason?: string };

/**
 * Resolve a verb's availability per §4.1: a missing verb is unavailable; absent
 * `availability` or `state:"available"` (or any unknown state token, for backward
 * compatibility) is available; `disabled`/`unsupported` disables every bound
 * widget/action and carries the sanitized optional reason.
 */
export function commandAvailability(
  manifest: ComponentDescribeManifest | undefined,
  verb: string | undefined,
): CommandAvailabilityState {
  if (verb === undefined || verb === "") return { status: "unavailable" };
  const commands = Array.isArray(manifest?.commands) ? manifest.commands : [];
  const cap = commands.find((c) => c.verb === verb);
  if (cap === undefined) return { status: "unavailable" };
  const availability = cap.availability;
  if (availability === undefined || availability === null) return { status: "available" };
  const state = (availability as { state?: unknown }).state;
  if (state === "disabled" || state === "unsupported") {
    const reason = sanitizeText((availability as { reason?: unknown }).reason);
    return { status: state, ...(reason !== undefined ? { reason } : {}) };
  }
  return { status: "available" };
}

/* -----------------------------------------------------------------------------
 * Command failure classification — distinct unavailable/forbidden/timeout/malformed states.
 * --------------------------------------------------------------------------- */

/** The distinct visible failure classes a settled command error maps to (§4.1). */
export type CommandFailureKind = "forbidden" | "timeout" | "malformed" | "error";

/** Classify a settled command error into its distinct visible state + display label. */
export function classifyCommandFailure(error: CommandError | undefined): {
  kind: CommandFailureKind;
  label: string;
  code: string;
} {
  const code = error?.code ?? "ERROR";
  if (code === "FORBIDDEN") return { kind: "forbidden", label: "Not permitted for your role", code };
  if (code === "TIMEOUT") return { kind: "timeout", label: "Timed out — no reply", code };
  if (code === "MALFORMED_REPLY") return { kind: "malformed", label: "The reply was malformed", code };
  const label = sanitizeText(error?.message) ?? "Command failed";
  return { kind: "error", label, code };
}

/* -----------------------------------------------------------------------------
 * refresh — the closed `{onEnter?, manual?, intervalMs?}` object. Auto refresh
 * (onEnter/interval) is permitted only for read-only verbs; intervalMs ≥ 2000.
 * --------------------------------------------------------------------------- */

/** The minimum permitted auto-refresh interval (ms). */
export const MIN_REFRESH_INTERVAL_MS = 2000;

/** A normalized panel refresh policy. */
export interface PanelRefresh {
  onEnter: boolean;
  manual: boolean;
  intervalMs?: number;
}

/**
 * Normalize a descriptor `refresh` value. `allowAuto:false` (discovery/commandTable)
 * forces manual-only regardless of the descriptor. `intervalMs` is clamped up to
 * {@link MIN_REFRESH_INTERVAL_MS}. The manual affordance defaults ON (it is always safe).
 */
export function panelRefresh(value: unknown, opts: { allowAuto: boolean }): PanelRefresh {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const manual = record?.["manual"] !== false;
  if (!opts.allowAuto) return { onEnter: false, manual: true };
  const onEnter = record?.["onEnter"] === true;
  const rawInterval = record?.["intervalMs"];
  const intervalMs =
    typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(rawInterval))
      : undefined;
  return { onEnter, manual, ...(intervalMs !== undefined ? { intervalMs } : {}) };
}

/* -----------------------------------------------------------------------------
 * Fields / columns / actions — the small closed descriptor sub-shapes.
 * --------------------------------------------------------------------------- */

/** One statusDashboard field: `{label, path, format?, unit?, statusMap?}`. */
export interface PanelField {
  label: string;
  path: string;
  format?: string;
  unit?: string;
  statusMap?: Record<string, unknown>;
}

function entryRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function entryString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Parse a widget's `fields[]` (invalid entries dropped — label + safe path required). */
export function panelFields(widget: PanelWidgetDescriptor): PanelField[] {
  const raw = widget["fields"];
  if (!Array.isArray(raw)) return [];
  const fields: PanelField[] = [];
  for (const entry of raw) {
    const record = entryRecord(entry);
    if (record === undefined) continue;
    const label = sanitizeText(record["label"], 80);
    const path = entryString(record, "path");
    if (label === undefined || path === undefined || !isSafePath(path)) continue;
    const format = entryString(record, "format");
    const unit = sanitizeText(record["unit"], 16);
    const statusMap = entryRecord(record["statusMap"]);
    fields.push({
      label,
      path,
      ...(format !== undefined ? { format } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(statusMap !== undefined ? { statusMap } : {}),
    });
  }
  return fields;
}

/** One generic column: `{label, path, format?}` (commandTable/treeBrowser/signalGrid). */
export interface PanelColumn {
  label: string;
  path: string;
  format?: string;
}

/**
 * Parse a `columns[]` value. `undefined` when absent or no entry is valid (the widget
 * keeps its built-in headings); otherwise the valid columns in order.
 */
export function panelColumns(value: unknown): PanelColumn[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns: PanelColumn[] = [];
  for (const entry of value) {
    const record = entryRecord(entry);
    if (record === undefined) continue;
    const label = sanitizeText(record["label"], 80);
    const path = entryString(record, "path");
    if (label === undefined || path === undefined || !isSafePath(path)) continue;
    const format = entryString(record, "format");
    columns.push({ label, path, ...(format !== undefined ? { format } : {}) });
  }
  return columns.length > 0 ? columns : undefined;
}

/** One actionBar action: `{verb, label, role?, danger?, confirm?, args?}`. */
export interface PanelAction {
  verb: string;
  label: string;
  role?: string;
  danger: boolean;
  confirm?: string;
  args?: Record<string, unknown>;
}

/** Parse a widget's `actions[]` (verb + label required; confirm text sanitized). */
export function panelActions(widget: PanelWidgetDescriptor): PanelAction[] {
  const raw = widget["actions"];
  if (!Array.isArray(raw)) return [];
  const actions: PanelAction[] = [];
  for (const entry of raw) {
    const record = entryRecord(entry);
    if (record === undefined) continue;
    const verb = entryString(record, "verb");
    const label = sanitizeText(record["label"], 60) ?? verb;
    if (verb === undefined || label === undefined) continue;
    const role = sanitizeText(record["role"], 24);
    const confirm = sanitizeText(record["confirm"], 400);
    const args = entryRecord(record["args"]);
    actions.push({
      verb,
      label,
      danger: record["danger"] === true,
      ...(role !== undefined ? { role } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
      ...(args !== undefined ? { args: sanitizeArgsObject(args) } : {}),
    });
  }
  return actions;
}

/** Shallow-copy a descriptor args object, dropping prototype-polluting keys. */
export function sanitizeArgsObject(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (FORBIDDEN_PATH_TOKENS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Lifecycle optimistic UI gates (§4.1 table) — computed from the latest sb/status
 * result WHEN PRESENT, else enabled. UI affordances only; the gateway and the
 * component still enforce authorization and state.
 * --------------------------------------------------------------------------- */

/** The lifecycle verbs whose pending state gates `reconnect`. */
export const LIFECYCLE_VERBS: readonly string[] = ["sb/pause", "sb/resume", "reconnect", "repoll"];

/** The relevant slice of the latest ok `sb/status` result. */
export interface LifecycleStatus {
  state?: string;
  connected?: boolean;
  paused?: boolean;
}

/** Extract the lifecycle-relevant fields from an ok `sb/status` result body. */
export function lifecycleStatus(result: unknown): LifecycleStatus | undefined {
  const record = entryRecord(result);
  if (record === undefined) return undefined;
  const state = typeof record["state"] === "string" ? (record["state"] as string) : undefined;
  const connected = typeof record["connected"] === "boolean" ? (record["connected"] as boolean) : undefined;
  const paused = typeof record["paused"] === "boolean" ? (record["paused"] as boolean) : undefined;
  return {
    ...(state !== undefined ? { state } : {}),
    ...(connected !== undefined ? { connected } : {}),
    ...(paused !== undefined ? { paused } : {}),
  };
}

/**
 * Whether a lifecycle action is optimistically ENABLED (§4.1 table):
 *  - `sb/pause`   — state ONLINE and not paused;
 *  - `sb/resume`  — paused;
 *  - `repoll`     — connected and not paused;
 *  - `reconnect`  — no lifecycle command pending.
 * With NO status available every gate is optimistic (enabled); non-lifecycle verbs
 * are never gated here.
 */
export function lifecycleGateEnabled(
  verb: string,
  status: LifecycleStatus | undefined,
  lifecyclePending: boolean,
): boolean {
  switch (verb) {
    case "sb/pause": {
      if (status === undefined) return true;
      const online = status.state !== undefined ? status.state === "ONLINE" : true;
      return online && status.paused !== true;
    }
    case "sb/resume":
      return status === undefined ? true : status.paused === true;
    case "repoll": {
      if (status === undefined) return true;
      const connected =
        status.connected !== undefined
          ? status.connected
          : status.state !== undefined
            ? status.state === "ONLINE"
            : true;
      return connected && status.paused !== true;
    }
    case "reconnect":
      return !lifecyclePending;
    default:
      return true;
  }
}

/* -----------------------------------------------------------------------------
 * commandTable controls — the console-owned, schema-checked request form (§4).
 * --------------------------------------------------------------------------- */

/** The closed control types. */
export type PanelControlType =
  | "text"
  | "integer"
  | "integer-range"
  | "boolean"
  | "duration-ms"
  | "select";

const CONTROL_TYPES: ReadonlySet<string> = new Set([
  "text",
  "integer",
  "integer-range",
  "boolean",
  "duration-ms",
  "select",
]);

/** One resolved select option (value emitted verbatim; label displayed). */
export interface PanelSelectOption {
  value: string | number | boolean;
  label: string;
}

/** One accepted, schema-checked control. */
export interface PanelControl {
  /** The closed request field this control fills (nested via dots, e.g. `filter.vendorId`). */
  field: string;
  label: string;
  type: PanelControlType;
  /** Resolved options (select only — static or from `optionsSource`). */
  options?: PanelSelectOption[];
}

/** The parse outcome: accepted controls plus the rejected entries' display names. */
export interface ParsedControls {
  controls: PanelControl[];
  rejected: string[];
}

/** The bound on options resolved from an `optionsSource` array. */
export const MAX_SELECT_OPTIONS = 200;

function staticOptions(raw: unknown): PanelSelectOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options: PanelSelectOption[] = [];
  for (const entry of raw.slice(0, MAX_SELECT_OPTIONS)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      options.push({ value: entry, label: scalarText(entry, 80) });
      continue;
    }
    const record = entryRecord(entry);
    if (record === undefined) continue;
    const value = record["value"];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const label = sanitizeText(record["label"], 80) ?? scalarText(value, 80);
    options.push({ value, label });
  }
  return options.length > 0 ? options : undefined;
}

/**
 * Resolve a select `optionsSource` — a bounded array in the configuration ALREADY
 * loaded by the Configuration tab, addressed with literal `path`/`valuePath`/`labelPath`
 * keys. The source root is the loaded cfg body (with a lenient `config` sub-root
 * fallback matching the published cfg envelope shape).
 */
export function optionsFromSource(source: unknown, configBody: unknown): PanelSelectOption[] | undefined {
  const record = entryRecord(source);
  if (record === undefined) return undefined;
  const path = entryString(record, "path");
  const valuePath = entryString(record, "valuePath");
  const labelPath = entryString(record, "labelPath");
  if (path === undefined || !isSafePath(path)) return undefined;
  let array = resolvePath(configBody, path);
  if (!Array.isArray(array)) {
    const configRoot = entryRecord(configBody)?.["config"];
    array = configRoot !== undefined ? resolvePath(configRoot, path) : undefined;
  }
  if (!Array.isArray(array)) return undefined;
  const options: PanelSelectOption[] = [];
  for (const element of array.slice(0, MAX_SELECT_OPTIONS)) {
    let value: unknown = element;
    let label: unknown = element;
    if (valuePath !== undefined || labelPath !== undefined) {
      value = valuePath !== undefined ? resolvePath(element, valuePath) : element;
      label = labelPath !== undefined ? resolvePath(element, labelPath) : value;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    options.push({ value, label: scalarText(label, 80) });
  }
  return options.length > 0 ? options : undefined;
}

/**
 * Schema-check a widget's `controls[]`. A control names ONE closed request field
 * (safe dot-path — prototype keys and unknown control types are rejected) and may
 * only narrow: nothing beyond the declared controls ever reaches the request.
 */
export function parseControls(raw: unknown, configBody: unknown): ParsedControls {
  if (!Array.isArray(raw)) return { controls: [], rejected: [] };
  const controls: PanelControl[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const record = entryRecord(entry);
    const field = record !== undefined ? entryString(record, "field") : undefined;
    const type = record !== undefined ? entryString(record, "type") : undefined;
    const name = field ?? "(control)";
    if (
      record === undefined ||
      field === undefined ||
      !isSafePath(field) ||
      type === undefined ||
      !CONTROL_TYPES.has(type) ||
      seen.has(field)
    ) {
      rejected.push(sanitizeText(name, 60) ?? "(control)");
      continue;
    }
    const label = sanitizeText(record["label"], 80) ?? field;
    if (type === "select") {
      const options = staticOptions(record["options"]) ?? optionsFromSource(record["optionsSource"], configBody);
      if (options === undefined) {
        rejected.push(field);
        continue;
      }
      seen.add(field);
      controls.push({ field, label, type, options });
      continue;
    }
    seen.add(field);
    controls.push({ field, label, type: type as PanelControlType });
  }
  return { controls, rejected };
}

/** The live form value of one control (raw input strings; parsing happens on assembly). */
export type PanelControlValue = string | boolean | { lo: string; hi: string };

function parseIntegerText(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : undefined;
}

function setNestedField(target: Record<string, unknown>, field: string, value: unknown): void {
  const tokens = field.split(".");
  let current = target;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    const existing = current[token];
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      current[token] = {};
    }
    current = current[token] as Record<string, unknown>;
  }
  current[tokens[tokens.length - 1]!] = value;
}

/**
 * Assemble the request-args object from the accepted controls and their live values —
 * only declared fields, nested names assembled as objects, empty/invalid inputs
 * omitted. `integer-range` emits exactly a two-integer inclusive `[lo, hi]` array.
 */
export function assembleControlArgs(
  controls: PanelControl[],
  values: Record<string, PanelControlValue>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const control of controls) {
    const value = Object.prototype.hasOwnProperty.call(values, control.field)
      ? values[control.field]
      : undefined;
    if (value === undefined) continue;
    switch (control.type) {
      case "text": {
        if (typeof value !== "string") break;
        const text = value.trim();
        if (text !== "") setNestedField(args, control.field, text);
        break;
      }
      case "integer": {
        if (typeof value !== "string") break;
        const n = parseIntegerText(value);
        if (n !== undefined) setNestedField(args, control.field, n);
        break;
      }
      case "duration-ms": {
        if (typeof value !== "string") break;
        const n = parseIntegerText(value);
        if (n !== undefined && n >= 0) setNestedField(args, control.field, n);
        break;
      }
      case "integer-range": {
        if (typeof value !== "object" || value === null || typeof (value as { lo?: unknown }).lo !== "string")
          break;
        const range = value as { lo: string; hi: string };
        const lo = parseIntegerText(range.lo);
        const hi = parseIntegerText(range.hi);
        if (lo !== undefined && hi !== undefined && lo <= hi) {
          setNestedField(args, control.field, [lo, hi]);
        }
        break;
      }
      case "boolean": {
        if (value === true) setNestedField(args, control.field, true);
        break;
      }
      case "select": {
        if (typeof value !== "string" || value === "") break;
        const option = control.options?.find((o) => String(o.value) === value);
        if (option !== undefined) setNestedField(args, control.field, option.value);
        break;
      }
    }
  }
  return args;
}

/* -----------------------------------------------------------------------------
 * eventFeed — families, bounded limit, optional scalar field filters.
 * --------------------------------------------------------------------------- */

/** The default and maximum eventFeed row bounds. */
export const DEFAULT_EVENT_FEED_LIMIT = 50;
export const MAX_EVENT_FEED_LIMIT = 200;

/** Clamp a descriptor `limit` into `[1, 200]` (default 50). */
export function clampEventLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EVENT_FEED_LIMIT;
  return Math.min(MAX_EVENT_FEED_LIMIT, Math.max(1, Math.round(value)));
}

/**
 * Whether an event TYPE belongs to one of the declared families: an exact match, or
 * a `family.`/`family/` prefix. An empty family list accepts every type.
 */
export function eventFamilyMatch(type: string, families: string[]): boolean {
  if (families.length === 0) return true;
  return families.some((f) => type === f || type.startsWith(`${f}.`) || type.startsWith(`${f}/`));
}

/**
 * Parse a widget's `filters` object into `[path, expected]` pairs — safe dot-paths
 * into the event body, scalar expected values only; anything else is dropped.
 */
export function panelEventFilters(value: unknown): [string, string | number | boolean][] {
  const record = entryRecord(value);
  if (record === undefined) return [];
  const filters: [string, string | number | boolean][] = [];
  for (const [path, expected] of Object.entries(record)) {
    if (!isSafePath(path)) continue;
    if (typeof expected !== "string" && typeof expected !== "number" && typeof expected !== "boolean")
      continue;
    filters.push([path, expected]);
  }
  return filters;
}

/* -----------------------------------------------------------------------------
 * metricSeries — aggregation over the bounded recent points.
 * --------------------------------------------------------------------------- */

/**
 * Aggregate a metric series' recent points: `last` (default), `avg`, `min`, `max`,
 * or `sum`. Unknown aggregations fall back to `last`; empty points → undefined.
 */
export function aggregateSeries(points: MetricPoint[] | undefined, aggregation?: string): number | undefined {
  if (points === undefined || points.length === 0) return undefined;
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (values.length === 0) return undefined;
  switch (aggregation) {
    case "avg":
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    default:
      return values[values.length - 1];
  }
}
