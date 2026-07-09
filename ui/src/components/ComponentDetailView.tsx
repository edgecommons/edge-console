/**
 * The Component Detail screen (slice R2) — faithful to the signed-off hi-fi
 * (`docs/mockups-hifi.html`, `#screen-detail`): the breadcrumb
 * (`Overview / Components / {hier path} / {component}`), the title + subtitle, and the tab
 * set. The tabs that available data supports are BUILT for real:
 *   - **Health**    — liveness/state + the runtime attributes (cpu / memory / disk /
 *                     threads·files·fds / uptime) + the console-computed health checks;
 *   - **Instances** — every instance of the (device, component) from the identity `instance`
 *                     token;
 *   - **Configuration** — the full structured/raw effective `cfg` inspector from the
 *                     ConfigStore, mounted in place;
 *   - **Events**    — this component's filtered `evt`/alarm slice, with a link to Events & Alarms;
 *   - **Metrics**   — this component's custom non-system metric series published over the bus.
 *
 * The component-specific Panel tab is descriptor-driven: the console asks the component for
 * `cmd/describe`, then renders the advertised panel views without fabricating OPC UA-only UI.
 * Logs are served by the component-scoped C6 log tail (`subscribe-logs`/`log`) and kept
 * out of the general last-known-value model so high-rate log records do not churn the page.
 *
 * `ComponentDetailView` is purely presentational (state in, DOM out — component-testable
 * without a socket); `ConnectedComponentDetailView` binds it to the shared {@link FleetClient}
 * and owns the config request / event subscription lifecycle.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  InlineLoading,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  Tile,
} from "@carbon/react";
import { ArrowRight, ChevronDown, ChevronRight, CircleFilled } from "@carbon/react/icons";
import type {
  CommandCapability,
  CommandError,
  ComponentDescribeManifest,
  ComponentKey,
  ConsoleLogRecord,
  InstanceStatus,
  LogLevel,
  MetricSeriesSnapshot,
  PanelViewDescriptor,
  PanelWidgetDescriptor,
} from "@edgecommons/edge-console-protocol";
import { LOG_LEVELS, componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import type { DescriptorEntryView } from "../fleet/description-store";
import type { ComponentView } from "../fleet/store";
import { formatDurationMs, formatDurationSecs } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { Sparkline } from "../common/Sparkline";
import { StatusTag } from "../health/StatusTag";
import { CommandToasts } from "../health/CommandToasts";
import type { InvokeCommand } from "../health/EdgeHealthView";
import { SeverityTag } from "../events/EventsView";
import { formatClockTime, summarizeBody } from "../events/selectors";
import { ConfigInspector } from "../configreview/ConfigInspector";
import type { HealthCheck } from "./detail-selectors";
import {
  alarmsForComponent,
  componentDetailPath,
  connectionStateCheck,
  detailSubtitleParts,
  detailUptimeSecs,
  healthChecks,
} from "./detail-selectors";
import { findComponent } from "./components-tree";

/** A no-op command seam (presentational tests without a live client). */
const NO_INVOKE: InvokeCommand = () => undefined;

/** The Health tab's console-computed "health checks" structured list. */
function HealthChecks({ checks }: { checks: HealthCheck[] }): React.JSX.Element {
  const toneTag = (c: HealthCheck) => {
    if (c.tone === "plain") return <span className={c.pending === true ? "ec-dim" : "ec-mono"}>{c.value}</span>;
    const type = c.tone === "ok" ? "green" : c.tone === "err" ? "red" : c.tone === "unknown" ? "gray" : undefined;
    const className = c.tone === "warn" ? "ec-tag ec-tag--warn" : "ec-tag";
    return (
      <Tag size="sm" {...(type !== undefined ? { type } : {})} className={className}>
        {c.value}
      </Tag>
    );
  };
  return (
    <div className="ec-slist" data-testid="health-checks">
      <div className="ec-slist__r ec-slist__r--hd">
        <span className="ec-slist__k">Operational checks</span>
        <span className="ec-slist__v ec-dim">Status</span>
      </div>
      {checks.map((c) => (
        <div className="ec-slist__r" key={c.label} data-testid={`health-check-${c.label.replace(/[^a-z]/gi, "-")}`}>
          <span className="ec-slist__k">{c.label}</span>
          <span className="ec-slist__v">
            {toneTag(c)}
            {c.detail !== undefined && <span className="ec-dim">{c.detail}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function HealthStateStrip({
  label,
  value,
  tone,
  detail,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  tone?: HealthCheck["tone"];
  detail: string;
  testId: string;
}): React.JSX.Element {
  const toneClass = tone !== undefined && tone !== "plain" ? ` ec-health-state--${tone}` : "";
  return (
    <div className={`ec-health-state${toneClass}`} data-testid={testId}>
      <div className="ec-health-state__label">{label}</div>
      <div className="ec-health-state__value">{value}</div>
      <div className="ec-health-state__detail">{detail}</div>
    </div>
  );
}

function countOrDash(value: number | undefined): string {
  return value !== undefined ? String(Math.round(value)) : "—";
}

function gbOrDash(value: number | undefined): string {
  return value !== undefined ? String(Math.round(value)) : "—";
}

function commandCapabilities(manifest: ComponentDescribeManifest | undefined): CommandCapability[] {
  return Array.isArray(manifest?.commands) ? manifest.commands : [];
}

function hasCommand(manifest: ComponentDescribeManifest | undefined, verb: string | undefined): verb is string {
  return verb !== undefined && commandCapabilities(manifest).some((c) => c.verb === verb);
}

function viewTitle(view: PanelViewDescriptor): string {
  return view.title ?? view.label ?? view.id;
}

function viewWidgets(view: PanelViewDescriptor): PanelWidgetDescriptor[] {
  return Array.isArray(view.widgets) ? view.widgets : Array.isArray(view.descriptor) ? view.descriptor : [];
}

function stringProp(obj: PanelWidgetDescriptor, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function arrayProp(obj: PanelWidgetDescriptor, key: string): unknown[] {
  const value = obj[key];
  return Array.isArray(value) ? value : [];
}

function firstInstanceArg(comp: ComponentView, scoped: boolean): Record<string, unknown> {
  if (!scoped) return {};
  const first = comp.instances?.[0]?.instance;
  return first !== undefined && first !== "main" ? { instance: first } : {};
}

function latestCommand(
  commands: ClientState["commands"],
  key: ComponentKey,
  verb: string | undefined,
) {
  if (verb === undefined) return undefined;
  return commands.latestByComponentVerb[`${componentKeyId(key)}::${verb}`];
}

type LatestCommandEntry = ReturnType<typeof latestCommand>;

function errorText(error: CommandError | undefined): string {
  return error !== undefined ? `${error.code}${error.message !== "" ? `: ${error.message}` : ""}` : "Command failed";
}

function CapabilityUnavailable({ verb, reason }: { verb?: string; reason?: string }): React.JSX.Element {
  return (
    <div className="ec-panel-unavailable" data-testid="panel-capability-unavailable">
      <Tag size="sm" type="gray" className="ec-tag">
        Unavailable
      </Tag>
      <span>
        {verb !== undefined ? <span className="ec-mono">cmd/{verb}</span> : "This binding"}{" "}
        {reason ?? "is not advertised by this component."}
      </span>
    </div>
  );
}

function CommandResultPreview({
  entry,
  empty,
}: {
  entry: LatestCommandEntry;
  empty: string;
}): React.JSX.Element {
  if (entry === undefined) return <p className="ec-dim">{empty}</p>;
  if (entry.phase === "pending") return <InlineLoading description="Waiting for reply..." />;
  if (entry.phase === "error") return <p className="ec-panel-error">{errorText(entry.error)}</p>;
  return (
    <pre className="ec-panel-json" data-testid="panel-command-result">
      {JSON.stringify(entry.result ?? {}, null, 2)}
    </pre>
  );
}

function commandResultGate(entry: LatestCommandEntry, empty: string): React.JSX.Element | undefined {
  if (entry === undefined) return <p className="ec-dim">{empty}</p>;
  if (entry.phase === "pending") return <InlineLoading description="Waiting for reply..." />;
  if (entry.phase === "error") return <p className="ec-panel-error">{errorText(entry.error)}</p>;
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordsFromProp(obj: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] {
  const value = obj?.[key];
  return Array.isArray(value) ? value.map(objectRecord).filter((v): v is Record<string, unknown> => v !== undefined) : [];
}

function propString(obj: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function propNumber(obj: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function propBoolean(obj: Record<string, unknown> | undefined, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

function nodeNamespace(row: Record<string, unknown>): string {
  const namespace = row["namespace"];
  return typeof namespace === "number" || typeof namespace === "string" ? `ns=${namespace}` : "ns=?";
}

function nodeId(row: Record<string, unknown>): string {
  return propString(row, "signalId", "nodeId", "id") ?? "—";
}

function addressNodeId(row: Record<string, unknown>): string {
  return propString(row, "nodeId", "id", "signalId") ?? "—";
}

function nodeName(row: Record<string, unknown>): string {
  return propString(row, "name", "displayName", "browseName", "signalId", "nodeId", "id") ?? "Unnamed node";
}

interface AddressTreeRow {
  id: string;
  pathKey: string;
  node: Record<string, unknown>;
  depth: number;
  referenceType?: string;
  referenceTypeId?: string;
}

function nodeReferences(node: Record<string, unknown>): Record<string, unknown>[] {
  return recordsFromProp(node, "refs");
}

function referenceTarget(ref: Record<string, unknown>): Record<string, unknown> {
  const target = objectRecord(ref["target"]) ?? objectRecord(ref["node"]);
  if (target !== undefined) return target;
  const targetNodeId = propString(ref, "targetNodeId", "nodeId") ?? "unresolved";
  return { nodeId: targetNodeId, name: targetNodeId };
}

function hasAddressRefs(node: Record<string, unknown>): boolean {
  return Array.isArray(node["refs"]);
}

function addressNodeMightHaveChildren(node: Record<string, unknown>): boolean {
  if (nodeReferences(node).length > 0) return true;
  if (hasAddressRefs(node)) return false;
  const nodeClass = propString(node, "nodeClass")?.toLowerCase();
  return nodeClass === undefined || nodeClass === "object" || nodeClass === "method" || nodeClass === "view";
}

function mergeAddressNode(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (existing === undefined) return incoming;
  const merged = { ...existing, ...incoming };
  if (!hasAddressRefs(incoming) && hasAddressRefs(existing)) {
    merged["refs"] = existing["refs"];
  }
  return merged;
}

function collectAddressNodes(root: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const collected: Record<string, Record<string, unknown>> = {};
  const walk = (node: Record<string, unknown>, path: Set<string>) => {
    const id = addressNodeId(node);
    if (id !== "—") {
      collected[id] = mergeAddressNode(collected[id], node);
      if (path.has(id)) return;
      path = new Set(path);
      path.add(id);
    }
    for (const childRef of nodeReferences(node)) {
      walk(referenceTarget(childRef), path);
    }
  };
  walk(root, new Set());
  return collected;
}

function mergeAddressTree(
  previous: Record<string, Record<string, unknown>>,
  root: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const next = { ...previous };
  const collected = collectAddressNodes(root);
  for (const [id, node] of Object.entries(collected)) {
    next[id] = mergeAddressNode(next[id], node);
  }
  return next;
}

function flattenAddressHierarchy(
  rootId: string | undefined,
  nodesById: Record<string, Record<string, unknown>>,
  expanded: ReadonlySet<string>,
): AddressTreeRow[] {
  if (rootId === undefined) return [];
  const root = nodesById[rootId];
  if (root === undefined) return [];
  const rows: AddressTreeRow[] = [];
  const walk = (
    node: Record<string, unknown>,
    depth: number,
    ref: Record<string, unknown> | undefined,
    path: Set<string>,
    pathKey: string,
  ) => {
    const id = addressNodeId(node);
    const row: AddressTreeRow = { id, pathKey, node, depth };
    if (ref !== undefined) {
      const referenceType = propString(ref, "referenceType");
      const referenceTypeId = propString(ref, "referenceTypeId");
      if (referenceType !== undefined) row.referenceType = referenceType;
      if (referenceTypeId !== undefined) row.referenceTypeId = referenceTypeId;
    }
    rows.push(row);
    if (id === "—" || !expanded.has(id)) return;
    if (id !== "—" && path.has(id)) return;
    const nextPath = new Set(path);
    if (id !== "—") nextPath.add(id);
    const duplicateRefs = new Map<string, number>();
    for (const childRef of nodeReferences(node)) {
      const target = referenceTarget(childRef);
      const targetId = addressNodeId(target);
      const loaded = targetId !== "—" ? nodesById[targetId] : undefined;
      const referenceKey = propString(childRef, "referenceTypeId", "referenceType") ?? "ref";
      const childKeyBase = `${referenceKey}>${targetId}`;
      const duplicateIndex = duplicateRefs.get(childKeyBase) ?? 0;
      duplicateRefs.set(childKeyBase, duplicateIndex + 1);
      const childPathKey = `${pathKey}/${childKeyBase}${duplicateIndex === 0 ? "" : `#${duplicateIndex}`}`;
      walk(loaded !== undefined ? mergeAddressNode(target, loaded) : target, depth + 1, childRef, nextPath, childPathKey);
    }
  };
  walk(root, 0, undefined, new Set(), `root:${rootId}`);
  return rows;
}

function addressReferenceLabel(row: AddressTreeRow): string {
  return row.referenceType ?? row.referenceTypeId ?? "—";
}

function addressNodeActionLabel(row: AddressTreeRow, isExpanded: boolean): string {
  const action = isExpanded ? "Collapse" : "Expand";
  return `${action} ${nodeName(row.node)} (${addressNodeId(row.node)})`;
}

function metricValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 100_000 || abs < 0.01)) return value.toExponential(2);
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function isCustomMetric(series: MetricSeriesSnapshot): boolean {
  const metric = series.metric.trim().toLowerCase();
  return (
    metric !== "" &&
    metric !== "sys" &&
    !metric.startsWith("sys.") &&
    !metric.startsWith("sys/") &&
    !metric.startsWith("sys_")
  );
}

function customMetricsForComponent(series: MetricSeriesSnapshot[], detailKey: ComponentKey): MetricSeriesSnapshot[] {
  const id = componentKeyId(detailKey);
  return series
    .filter((s) => componentKeyId(s.key) === id && isCustomMetric(s))
    .sort(
      (a, b) =>
        a.instance.localeCompare(b.instance) ||
        a.metric.localeCompare(b.metric) ||
        a.measure.localeCompare(b.measure),
    );
}

function logLevelTagType(level: LogLevel): "red" | "magenta" | "blue" | "gray" | "warm-gray" {
  switch (level) {
    case "fatal":
    case "error":
      return "red";
    case "warn":
      return "warm-gray";
    case "info":
      return "blue";
    case "debug":
    case "trace":
      return "gray";
  }
}

function logLevelLabel(level: LogLevel): string {
  return level.toUpperCase();
}

function AddressSpaceResult({
  entry,
  empty,
  onBrowseNode,
}: {
  entry: LatestCommandEntry;
  empty: string;
  onBrowseNode: (ref: string) => void;
}): React.JSX.Element {
  const [rootId, setRootId] = useState<string | undefined>(undefined);
  const [nodesById, setNodesById] = useState<Record<string, Record<string, unknown>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadStatusById, setLoadStatusById] = useState<Record<string, "pending" | "error">>({});

  useEffect(() => {
    if (entry?.phase === "ok") {
      const result = objectRecord(entry.result);
      const root = objectRecord(result?.["root"]);
      if (root === undefined || propString(result, "mode") !== "hierarchical") return;
      const loadedId = addressNodeId(root);
      if (loadedId === "—") return;
      setNodesById((previous) => mergeAddressTree(previous, root));
      setRootId((previous) => previous ?? loadedId);
      setExpanded((previous) => {
        if (previous.has(loadedId)) return previous;
        const next = new Set(previous);
        next.add(loadedId);
        return next;
      });
      setLoadStatusById((previous) => {
        if (previous[loadedId] === undefined) return previous;
        const next = { ...previous };
        delete next[loadedId];
        return next;
      });
    } else if (entry?.phase === "error") {
      setLoadStatusById((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const [id, status] of Object.entries(previous)) {
          if (status === "pending") {
            next[id] = "error";
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    }
  }, [entry?.phase, entry?.requestId, entry?.result]);

  const hasRoot = rootId !== undefined && nodesById[rootId] !== undefined;
  if (!hasRoot) {
    const gate = commandResultGate(entry, empty);
    if (gate !== undefined) return gate;

    const result = objectRecord(entry?.result);
    if (result === undefined) return <CommandResultPreview entry={entry} empty={empty} />;

    const root = objectRecord(result["root"]);
    if (root === undefined || propString(result, "mode") !== "hierarchical") {
      const instance = propString(result, "id", "instance") ?? "default";
      return (
        <div className="ec-panel-result" data-testid="panel-address-tree">
          <div className="ec-panel-result-meta">
            <span>
              Instance <span className="ec-mono">{instance}</span>
            </span>
          </div>
          <p className="ec-panel-error">Browse reply did not include hierarchical refs.</p>
        </div>
      );
    }
  }

  const result = objectRecord(entry?.result);
  const instance = propString(result, "id", "instance") ?? "default";
  const truncated = propBoolean(result, "truncated") === true;
  const rows = flattenAddressHierarchy(rootId, nodesById, expanded);
  const loadedRefCount = Math.max(0, rows.length - 1);
  const latestRefCount = propNumber(result, "refCount");
  const depth = propNumber(result, "depth");
  const pendingRow = rows.find((row) => loadStatusById[row.id] === "pending");
  const failedRow = rows.find((row) => loadStatusById[row.id] === "error");
  const loadingLabel =
    pendingRow !== undefined
      ? `Loading ${nodeName(pendingRow.node)}...`
      : entry?.phase === "pending" && hasRoot
        ? "Loading address space..."
        : undefined;
  const failureLabel = failedRow !== undefined ? `Could not load ${nodeName(failedRow.node)}.` : undefined;

  const toggleNode = (row: AddressTreeRow) => {
    if (row.id === "—" || !addressNodeMightHaveChildren(row.node)) return;
    const isExpanded = expanded.has(row.id);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (isExpanded) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    if (!isExpanded && !hasAddressRefs(row.node)) {
      setLoadStatusById((previous) => ({ ...previous, [row.id]: "pending" }));
      onBrowseNode(row.id);
    }
  };

  return (
    <div className="ec-panel-result" data-testid="panel-address-tree">
      <div className="ec-panel-result-meta ec-panel-result-meta--address-tree">
        <div className="ec-panel-result-meta__items">
          <span>
            Instance <span className="ec-mono">{instance}</span>
          </span>
          <span>{loadedRefCount} hierarchical refs loaded</span>
          {latestRefCount !== undefined && latestRefCount !== loadedRefCount && <span>{latestRefCount} refs in latest browse</span>}
          {depth !== undefined && <span>Depth {depth}</span>}
          {truncated && (
            <Tag size="sm" type="gray" className="ec-tag">
              More available
            </Tag>
          )}
        </div>
        <div className="ec-panel-tree-status" aria-live="polite" data-testid="panel-tree-status">
          {loadingLabel !== undefined ? (
            <InlineLoading className="ec-panel-tree-status__loading" description={loadingLabel} />
          ) : failureLabel !== undefined ? (
            <span className="ec-panel-error">{failureLabel}</span>
          ) : (
            <span className="ec-panel-tree-status__idle" aria-hidden="true">
              &nbsp;
            </span>
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="ec-dim">Browse returned no hierarchical address-space refs.</p>
      ) : (
        <div className="ec-panel-tree" role="treegrid" aria-label="Address space browse results">
          <div className="ec-panel-tree__row ec-panel-tree__row--head" role="row">
            <span role="columnheader">Node</span>
            <span role="columnheader">Node ID</span>
            <span role="columnheader">Namespace</span>
            <span role="columnheader">Class</span>
            <span role="columnheader">Reference</span>
            <span role="columnheader">Data type</span>
          </div>
          {rows.map((row) => {
            const refs = nodeReferences(row.node);
            const expandable = addressNodeMightHaveChildren(row.node);
            const isExpanded = expanded.has(row.id);
            return (
              <div className="ec-panel-tree__group" key={row.pathKey}>
                <div
                  className="ec-panel-tree__row"
                  role="row"
                  aria-level={row.depth + 1}
                  aria-expanded={expandable ? isExpanded : undefined}
                  data-testid="panel-address-node"
                >
                  <span
                    className="ec-panel-tree__cell ec-panel-tree__name"
                    role="gridcell"
                    style={{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }}
                  >
                    <button
                      type="button"
                      className={`ec-panel-tree__twisty${expandable ? "" : " ec-panel-tree__twisty--leaf"}`}
                      aria-label={addressNodeActionLabel(row, isExpanded)}
                      aria-expanded={expandable ? isExpanded : undefined}
                      disabled={!expandable}
                      onClick={() => toggleNode(row)}
                    >
                      {expandable ? (
                        isExpanded ? (
                          <ChevronDown size={16} />
                        ) : (
                          <ChevronRight size={16} />
                        )
                      ) : (
                        <span aria-hidden="true" />
                      )}
                    </button>
                    <span>{nodeName(row.node)}</span>
                    {refs.length > 0 && <span className="ec-dim">{refs.length} refs</span>}
                  </span>
                  <span className="ec-panel-tree__cell ec-mono" role="gridcell">
                    {addressNodeId(row.node)}
                  </span>
                  <span className="ec-panel-tree__cell" role="gridcell">
                    {nodeNamespace(row.node)}
                  </span>
                  <span className="ec-panel-tree__cell" role="gridcell">
                    {displayValue(row.node["nodeClass"])}
                  </span>
                  <span className="ec-panel-tree__cell" role="gridcell">
                    {addressReferenceLabel(row)}
                  </span>
                  <span className="ec-panel-tree__cell" role="gridcell">
                    {displayValue(row.node["dataType"])}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SignalGridResult({
  entry,
  empty,
}: {
  entry: LatestCommandEntry;
  empty: string;
}): React.JSX.Element {
  const gate = commandResultGate(entry, empty);
  if (gate !== undefined) return gate;

  const result = objectRecord(entry?.result);
  const signals = recordsFromProp(result, "signals");
  if (result === undefined) return <CommandResultPreview entry={entry} empty={empty} />;

  const instance = propString(result, "id", "instance") ?? "default";
  return (
    <div className="ec-panel-result" data-testid="panel-signal-grid">
      <div className="ec-panel-result-meta">
        <span>
          Instance <span className="ec-mono">{instance}</span>
        </span>
        <span>{signals.length} subscribed signals</span>
      </div>
      {signals.length === 0 ? (
        <p className="ec-dim">No subscribed signals were reported.</p>
      ) : (
        <div className="ec-panel-table-wrap">
          <table className="ec-panel-table">
            <thead>
              <tr>
                <th scope="col">Signal</th>
                <th scope="col">Namespace</th>
                <th scope="col">ID type</th>
                <th scope="col">Match</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal, index) => (
                <tr key={`${nodeId(signal)}-${index}`} data-testid="panel-signal-row">
                  <td className="ec-mono">{nodeId(signal)}</td>
                  <td>
                    <div>{nodeNamespace(signal)}</div>
                    {propString(signal, "namespaceUri", "namespaceURI", "namespaceUrl") !== undefined && (
                      <div className="ec-dim">{propString(signal, "namespaceUri", "namespaceURI", "namespaceUrl")}</div>
                    )}
                  </td>
                  <td>{displayValue(signal["idType"])}</td>
                  <td>{displayValue(signal["match"])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryWidget({ widget }: { widget: PanelWidgetDescriptor }): React.JSX.Element {
  const rows = arrayProp(widget, "rows").filter(
    (row): row is { label: string; value: unknown } =>
      typeof row === "object" &&
      row !== null &&
      !Array.isArray(row) &&
      typeof (row as { label?: unknown }).label === "string",
  );
  return (
    <div className="ec-panel-widget" data-testid={`panel-widget-${widget.id ?? "summary"}`}>
      <h4>{widget.title ?? "Summary"}</h4>
      {rows.length === 0 ? (
        <p className="ec-dim">{typeof widget.description === "string" ? widget.description : "Descriptor summary"}</p>
      ) : (
        <div className="ec-slist ec-panel-kv">
          {rows.map((row) => (
            <div className="ec-slist__r" key={row.label}>
              <span className="ec-slist__k">{row.label}</span>
              <span className="ec-slist__v">{String(row.value ?? "—")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandSummaryWidget({
  widget,
  manifest,
}: {
  widget: PanelWidgetDescriptor;
  manifest: ComponentDescribeManifest;
}): React.JSX.Element {
  const listed = arrayProp(widget, "verbs")
    .map((v) => (typeof v === "string" ? v : undefined))
    .filter((v): v is string => v !== undefined);
  const verbs = listed.length > 0 ? listed : commandCapabilities(manifest).map((c) => c.verb);
  return (
    <div className="ec-panel-widget" data-testid={`panel-widget-${widget.id ?? "commands"}`}>
      <h4>{widget.title ?? "Command availability"}</h4>
      <div className="ec-panel-command-list">
        {verbs.map((verb) => {
          const available = hasCommand(manifest, verb);
          return (
            <div className="ec-panel-command" key={verb}>
              <span className="ec-mono">cmd/{verb}</span>
              <Tag size="sm" type={available ? "green" : "gray"} className="ec-tag">
                {available ? "Available" : "Unavailable"}
              </Tag>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TreeBrowserWidget({
  widget,
  manifest,
  comp,
  detailKey,
  commands,
  onInvoke,
}: {
  widget: PanelWidgetDescriptor;
  manifest: ComponentDescribeManifest;
  comp: ComponentView;
  detailKey: ComponentKey;
  commands: ClientState["commands"];
  onInvoke: InvokeCommand;
}): React.JSX.Element {
  const browseVerb = stringProp(widget, "browseVerb") ?? stringProp(widget, "verb");
  const readVerb = stringProp(widget, "readVerb");
  const writeVerb = stringProp(widget, "writeVerb");
  const scoped = widget.scope === "instance" || widget["scope"] === "instance";
  const entry = latestCommand(commands, detailKey, browseVerb);
  const rootRef = stringProp(widget, "rootRef") ?? "root";
  const depth = propNumber(widget, "depth", "defaultDepth") ?? 1;
  const maxRefs = propNumber(widget, "maxRefs");
  const canBrowse = hasCommand(manifest, browseVerb);
  const browseArgs = (ref: string): Record<string, unknown> => ({
    ...firstInstanceArg(comp, scoped),
    ref,
    depth,
    ...(maxRefs !== undefined ? { maxRefs } : {}),
  });
  return (
    <div className="ec-panel-widget ec-panel-widget--tree" data-testid={`panel-widget-${widget.id ?? "tree"}`}>
      <div className="ec-panel-widget__head">
        <div>
          <h4>{widget.title ?? "Address space"}</h4>
          <p className="ec-dim">
            Bound to <span className="ec-mono">{browseVerb !== undefined ? `cmd/${browseVerb}` : "no browse verb"}</span>
            {" · hierarchical refs"}
          </p>
        </div>
        <Button
          kind="tertiary"
          size="sm"
          disabled={!canBrowse}
          data-testid="panel-browse-load"
          onClick={() => {
            if (browseVerb !== undefined) {
              onInvoke(detailKey, browseVerb, browseArgs(rootRef));
            }
          }}
        >
          Load
        </Button>
      </div>
      {!canBrowse ? (
        <CapabilityUnavailable verb={browseVerb} />
      ) : (
        <AddressSpaceResult
          key={`${componentKeyId(detailKey)}::${browseVerb ?? "browse"}::${rootRef}`}
          entry={entry}
          empty="Load the address-space root to inspect hierarchical refs."
          onBrowseNode={(ref) => {
            if (browseVerb !== undefined) onInvoke(detailKey, browseVerb, browseArgs(ref));
          }}
        />
      )}
      <div className="ec-panel-binding-row">
        {hasCommand(manifest, readVerb) ? (
          <Tag size="sm" type="blue" className="ec-tag">
            Read enabled
          </Tag>
        ) : (
          <Tag size="sm" type="gray" className="ec-tag">
            Read unavailable
          </Tag>
        )}
        {hasCommand(manifest, writeVerb) ? (
          <Tag size="sm" type="gray" className="ec-tag" title="Write safety modal and pre-dispatch audit are not wired yet">
            Write guarded
          </Tag>
        ) : (
          <Tag size="sm" type="gray" className="ec-tag">
            Write unavailable
          </Tag>
        )}
      </div>
    </div>
  );
}

function SignalGridWidget({
  widget,
  manifest,
  comp,
  detailKey,
  commands,
  onInvoke,
}: {
  widget: PanelWidgetDescriptor;
  manifest: ComponentDescribeManifest;
  comp: ComponentView;
  detailKey: ComponentKey;
  commands: ClientState["commands"];
  onInvoke: InvokeCommand;
}): React.JSX.Element {
  const subscriptionsVerb = stringProp(widget, "subscriptionsVerb") ?? stringProp(widget, "verb") ?? "sb/subscriptions";
  const scoped = widget.scope === "instance" || widget["scope"] === "instance";
  const entry = latestCommand(commands, detailKey, subscriptionsVerb);
  const available = hasCommand(manifest, subscriptionsVerb);
  return (
    <div className="ec-panel-widget" data-testid={`panel-widget-${widget.id ?? "signals"}`}>
      <div className="ec-panel-widget__head">
        <div>
          <h4>{widget.title ?? "Signals"}</h4>
          <p className="ec-dim">
            Bound to <span className="ec-mono">cmd/{subscriptionsVerb}</span>
          </p>
        </div>
        <Button
          kind="tertiary"
          size="sm"
          disabled={!available}
          data-testid="panel-signals-load"
          onClick={() => onInvoke(detailKey, subscriptionsVerb, firstInstanceArg(comp, scoped))}
        >
          Load
        </Button>
      </div>
      {!available ? (
        <CapabilityUnavailable verb={subscriptionsVerb} />
      ) : (
        <SignalGridResult entry={entry} empty="Load subscriptions to inspect configured signals." />
      )}
    </div>
  );
}

function DescriptorWidget({
  widget,
  manifest,
  comp,
  detailKey,
  commands,
  onInvoke,
}: {
  widget: PanelWidgetDescriptor;
  manifest: ComponentDescribeManifest;
  comp: ComponentView;
  detailKey: ComponentKey;
  commands: ClientState["commands"];
  onInvoke: InvokeCommand;
}): React.JSX.Element {
  switch (widget.kind) {
    case "summary":
    case "keyValueList":
    case "metricStrip":
      return <SummaryWidget widget={widget} />;
    case "commandSummary":
      return <CommandSummaryWidget widget={widget} manifest={manifest} />;
    case "treeBrowser":
      return (
        <TreeBrowserWidget
          widget={widget}
          manifest={manifest}
          comp={comp}
          detailKey={detailKey}
          commands={commands}
          onInvoke={onInvoke}
        />
      );
    case "signalGrid":
      return (
        <SignalGridWidget
          widget={widget}
          manifest={manifest}
          comp={comp}
          detailKey={detailKey}
          commands={commands}
          onInvoke={onInvoke}
        />
      );
    default:
      return (
        <div className="ec-panel-widget ec-panel-widget--unsupported" data-testid="panel-widget-unsupported">
          <Tag size="sm" type="gray" className="ec-tag">
            Unsupported widget
          </Tag>
          <span className="ec-mono">{widget.kind}</span>
        </div>
      );
  }
}

function DescriptorPanel({
  entry,
  detailKey,
  comp,
  commands,
  onRefreshDescriptor,
  onInvoke,
}: {
  entry: DescriptorEntryView | undefined;
  detailKey: ComponentKey;
  comp: ComponentView;
  commands: ClientState["commands"];
  onRefreshDescriptor?: (key: ComponentKey) => void;
  onInvoke: InvokeCommand;
}): React.JSX.Element {
  const manifest = entry?.manifest;
  const orderedViews = useMemo(() => {
    const views = manifest?.panels?.views ?? [];
    return [...views].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || viewTitle(a).localeCompare(viewTitle(b)));
  }, [manifest]);
  const defaultView = manifest?.panels?.defaultView;
  const [selectedView, setSelectedView] = useState<string | undefined>(undefined);
  const active =
    orderedViews.find((v) => v.id === selectedView) ??
    orderedViews.find((v) => v.id === defaultView) ??
    orderedViews[0];

  if (entry === undefined || (entry.phase === "loading" && manifest === undefined)) {
    return (
      <div className="ec-pending" data-testid="descriptor-loading">
        <InlineLoading description="Discovering component panels..." />
        <p className="ec-dim">
          The console is requesting <span className="ec-mono">cmd/describe</span> through the gateway.
        </p>
      </div>
    );
  }

  if (entry.phase === "unavailable" && manifest === undefined) {
    return (
      <div className="ec-pending" data-testid="descriptor-unavailable">
        <div className="ec-pending__badge">Descriptor unavailable</div>
        <h3 className="ec-pending__title">Component panels</h3>
        <p className="ec-dim">
          <span className="ec-mono">cmd/describe</span> did not return a panel manifest
          {entry.code !== undefined ? ` (${entry.code})` : ""}: {entry.reason ?? "not reported"}.
        </p>
        {onRefreshDescriptor !== undefined && (
          <Button kind="tertiary" size="sm" onClick={() => onRefreshDescriptor(detailKey)}>
            Reload panel
          </Button>
        )}
      </div>
    );
  }

  if (manifest === undefined || active === undefined) {
    return (
      <div className="ec-pending" data-testid="descriptor-empty">
        <div className="ec-pending__badge">No panel views</div>
        <h3 className="ec-pending__title">Component panels</h3>
        <p className="ec-dim">
          The component answered <span className="ec-mono">cmd/describe</span>, but did not advertise
          descriptor panel views.
        </p>
      </div>
    );
  }

  const provider = manifest.panels?.provider ?? manifest.component?.component ?? manifest.component?.name ?? comp.key.component;
  const widgets = viewWidgets(active);
  return (
    <div className="ec-panel" data-testid="descriptor-panel">
      <div className="ec-panel-cap">
        <span>
          provided by {provider} · {manifest.panels?.renderer ?? "descriptor"} · v2
          {entry.phase === "unavailable"
            ? ` · refresh failed${entry.code !== undefined ? ` (${entry.code})` : ""}`
            : entry.refreshing
              ? " · refreshing"
              : ""}
        </span>
        {onRefreshDescriptor !== undefined && (
          <Button kind="ghost" size="sm" onClick={() => onRefreshDescriptor(detailKey)} data-testid="reload-panel">
            Reload panel
          </Button>
        )}
      </div>
      <div className="ec-panel-subtabs" role="tablist" aria-label="Component-provided panel views" data-testid="panel-subtabs">
        {orderedViews.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={view.id === active.id}
            className={`ec-panel-subtab${view.id === active.id ? " ec-panel-subtab--active" : ""}`}
            onClick={() => setSelectedView(view.id)}
          >
            {viewTitle(view)}
          </button>
        ))}
      </div>
      <div className="ec-panel-body" data-testid={`panel-view-${active.id}`}>
        {widgets.length === 0 ? (
          <p className="ec-dim">This descriptor view has no console-owned widgets.</p>
        ) : (
          widgets.map((widget, i) => (
            <DescriptorWidget
              key={widget.id ?? `${widget.kind}-${i}`}
              widget={widget}
              manifest={manifest}
              comp={comp}
              detailKey={detailKey}
              commands={commands}
              onInvoke={onInvoke}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** The Health tab. */
function HealthTab({
  comp,
  attrs,
  openAlarms,
  nowServerMs,
}: {
  comp: ComponentView;
  attrs: ClientState["attributes"]["byId"][string] | undefined;
  openAlarms: number;
  nowServerMs: number;
}): React.JSX.Element {
  const cpuSeries = attrs?.cpuSeries;
  const hasDisk =
    attrs?.diskTotalGb !== undefined ||
    attrs?.diskUsedGb !== undefined ||
    attrs?.diskFreeGb !== undefined;
  const hasCounts =
    attrs?.threads !== undefined || attrs?.openFiles !== undefined || attrs?.fds !== undefined;
  const uptimeSecs = detailUptimeSecs(comp, nowServerMs);
  const lastState =
    comp.lastStateAt !== undefined
      ? `${formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt))} ago`
      : "no state yet";
  const checks = healthChecks(comp, attrs, openAlarms);
  const connection = connectionStateCheck(comp, attrs);
  return (
    <>
      <div className="ec-health-summary">
        <HealthStateStrip
          label="Liveness"
          value={<StatusTag liveness={comp.liveness} size="md" />}
          detail={`Last state ${lastState}; expected every ${comp.expectedIntervalSecs}s (${comp.cadenceSource})`}
          testId="liveness-state"
        />
        <HealthStateStrip
          label="Connection state"
          value={
            connection.tone === "plain" ? (
              <span className={connection.pending === true ? "ec-dim" : undefined}>{connection.value}</span>
            ) : (
              <Tag
                size="md"
                {...(connection.tone === "ok" ? { type: "green" as const } : connection.tone === "err" ? { type: "red" as const } : connection.tone === "unknown" ? { type: "gray" as const } : {})}
                className={connection.tone === "warn" ? "ec-tag ec-tag--warn" : "ec-tag"}
                renderIcon={CircleFilled}
              >
                {connection.value}
              </Tag>
            )
          }
          tone={connection.tone}
          detail={connection.detail ?? "Instance state not reported"}
          testId="health-connection-state"
        />
      </div>

      <div className="ec-tiles ec-health-tiles" data-testid="health-tiles">
        <Tile className="ec-tile">
          <div className="ec-tile__label">
            CPU{" "}
            {attrs?.cpuPercent !== undefined && (
              <Tag size="sm" type="blue" className="ec-tag" renderIcon={CircleFilled}>
                Live
              </Tag>
            )}
          </div>
          <div className="ec-tile__busrow">
            <div className="ec-tile__num ec-tile__num--md ec-tnum">
              {attrs?.cpuPercent !== undefined ? `${Math.round(attrs.cpuPercent)}%` : <span className="ec-dim">—</span>}
            </div>
            {cpuSeries !== undefined && cpuSeries.length > 1 && (
              <Sparkline
                points={cpuSeries.map((value, at) => ({ at, value }))}
                width={80}
                height={28}
                ariaLabel={`${comp.key.component} cpu trend`}
                formatValue={(v) => `${Math.round(v)}%`}
              />
            )}
          </div>
        </Tile>
        <Tile className="ec-tile">
          <div className="ec-tile__label">Memory</div>
          <div className="ec-tile__num ec-tile__num--md ec-tnum">
            {attrs?.memoryMb !== undefined ? (
              <>
                {Math.round(attrs.memoryMb)}
                <small>MB</small>
              </>
            ) : (
              <span className="ec-dim">—</span>
            )}
          </div>
        </Tile>
        <Tile className="ec-tile">
          <div className="ec-tile__label">Disk</div>
          <div className="ec-tile__num ec-tile__num--md ec-tnum">
            {hasDisk ? (
              <>
                {gbOrDash(attrs?.diskUsedGb)} / {gbOrDash(attrs?.diskTotalGb)}
                <small>GB</small>
              </>
            ) : (
              <span className="ec-dim">—</span>
            )}
          </div>
          <div className="ec-tile__foot">
            {attrs?.diskFreeGb !== undefined ? `${Math.round(attrs.diskFreeGb)} GB free` : "Free space not reported"}
          </div>
        </Tile>
        <Tile className="ec-tile">
          <div className="ec-tile__label">Threads / Files / FDs</div>
          <div className="ec-tile__num ec-tile__num--md ec-tnum">
            {hasCounts ? (
              `${countOrDash(attrs?.threads)} / ${countOrDash(attrs?.openFiles)} / ${countOrDash(attrs?.fds)}`
            ) : (
              <span className="ec-dim">—</span>
            )}
          </div>
          <div className="ec-tile__foot">File counts vary by platform</div>
        </Tile>
        <Tile className="ec-tile">
          <div className="ec-tile__label">Uptime</div>
          <div className="ec-tile__num ec-tile__num--md ec-tnum" data-testid="health-uptime">
            {uptimeSecs !== undefined ? formatDurationSecs(uptimeSecs) : <span className="ec-dim">—</span>}
          </div>
          <div className="ec-tile__foot">
            {comp.restarts > 0 ? `${comp.restarts} restart${comp.restarts === 1 ? "" : "s"} observed` : "No restarts observed"}
          </div>
        </Tile>
      </div>

      <HealthChecks checks={checks} />
    </>
  );
}

/**
 * The Instances tab — per-instance connectivity from the component's `state.instances[]` (#1c):
 * every configured instance (an OPC UA server, a Modbus slave, a file-replicator source directory)
 * with its connected/disconnected status. The list is config-complete — the library provider
 * reports every configured instance — so it is driven by config + state, never by bus traffic.
 */
function InstancesTab({ instances }: { instances: InstanceStatus[] }): React.JSX.Element {
  if (instances.length === 0) {
    return (
      <p className="ec-dim ec-detail-note" data-testid="instances-empty">
        This component reports no per-instance connectivity — it runs as a single{" "}
        <span className="ec-mono">main</span> instance. Multi-instance components (one adapter per
        upstream server, or one replication instance per source directory) list every configured
        instance here with its connection status.
      </p>
    );
  }
  return (
    <div className="ec-slist" data-testid="instances-list">
      <div className="ec-slist__r ec-slist__r--hd">
        <span className="ec-slist__k">Instance</span>
        <span className="ec-slist__v ec-dim">status · detail</span>
      </div>
      {instances.map((inst) => (
        <div className="ec-slist__r" key={inst.instance} data-testid={`instance-${inst.instance}`}>
          <span className="ec-slist__k ec-mono">{inst.instance}</span>
          <span className="ec-slist__v ec-instance-status">
            <Tag
              size="sm"
              type={inst.connected ? "green" : "red"}
              className="ec-tag"
              renderIcon={CircleFilled}
            >
              {inst.connected ? "connected" : "disconnected"}
            </Tag>
            {inst.detail !== undefined && inst.detail !== "" && (
              <span className="ec-dim ec-mono">{inst.detail}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The embedded full Configuration inspector. */
function ConfigTab({
  comp,
  detailKey,
  entry,
  nowServerMs,
  onRefreshConfig,
}: {
  comp: ComponentView;
  detailKey: ComponentKey;
  entry: ClientState["configs"]["entriesById"][string] | undefined;
  nowServerMs: number;
  onRefreshConfig?: (key: ComponentKey) => void;
}): React.JSX.Element {
  return (
    <div data-testid="config-embed">
      <ConfigInspector
        comp={comp}
        selectedKey={detailKey}
        entry={entry}
        nowServerMs={nowServerMs}
        {...(onRefreshConfig !== undefined ? { onRefresh: onRefreshConfig } : {})}
      />
    </div>
  );
}

/** The Events tab — this component's filtered evt/alarm slice. */
function EventsTab({
  comp,
  events,
  activeAlarms,
  nowServerMs,
  onOpenEvents,
}: {
  comp: ComponentView;
  events: ClientState["events"]["entries"];
  activeAlarms: number;
  nowServerMs: number;
  onOpenEvents?: () => void;
}): React.JSX.Element {
  const id = comp.id;
  const mine = events.filter((e) => componentKeyId(e.key) === id).slice(0, 50);
  const link = onOpenEvents !== undefined && (
    <Button kind="ghost" size="sm" renderIcon={ArrowRight} data-testid="view-full-events" onClick={onOpenEvents}>
      Open in Events &amp; Alarms
    </Button>
  );
  return (
    <div data-testid="events-embed">
      <div className="ec-detail-head__actions ec-detail-head__actions--right">
        <span className="ec-dim">
          {activeAlarms} open alarm{activeAlarms === 1 ? "" : "s"} · {mine.length} recent event
          {mine.length === 1 ? "" : "s"}
        </span>
        {link}
      </div>
      {mine.length === 0 ? (
        <Tile className="ec-empty" data-testid="events-embed-empty">
          <p className="ec-dim">
            No recent <code>evt</code> from this component. Events appear the moment it publishes
            on its <code>evt</code> class — nothing is polled.
          </p>
        </Tile>
      ) : (
        <div className="ec-slist" data-testid="events-embed-list">
          {mine.map((e) => (
            <div className="ec-slist__r ec-evt-embed-row" key={e.id} data-testid={`events-embed-row-${e.id}`}>
              <span className="ec-evt-embed-row__lead">
                <SeverityTag event={e} />
                <span className="ec-mono ec-tnum ec-dim">{formatClockTime(e.receivedAt)}</span>
              </span>
              <span className="ec-evt-embed-row__body">
                <span className="ec-pri">{e.type}</span>
                <span className="ec-dim"> {summarizeBody(e.body)}</span>
              </span>
              <span className="ec-dim ec-tnum ec-evt-embed-row__age">
                {formatDurationMs(Math.max(0, nowServerMs - e.receivedAt))} ago
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricsTab({
  series,
  detailKey,
  nowServerMs,
}: {
  series: MetricSeriesSnapshot[];
  detailKey: ComponentKey;
  nowServerMs: number;
}): React.JSX.Element {
  const mine = customMetricsForComponent(series, detailKey);
  return (
    <div data-testid="metrics-tab">
      <div className="ec-detail-head__actions ec-detail-head__actions--right">
        <span className="ec-dim">
          {mine.length} custom metric series
        </span>
      </div>
      {mine.length === 0 ? (
        <Tile className="ec-empty" data-testid="metrics-empty">
          <p className="ec-dim">
            No custom component metrics have been published on the bus. System metrics stay in Health.
          </p>
        </Tile>
      ) : (
        <div className="ec-panel-table-wrap" data-testid="metrics-table">
          <table className="ec-panel-table ec-metrics-table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Measure</th>
                <th scope="col">Latest</th>
                <th scope="col">Instance</th>
                <th scope="col">Updated</th>
                <th scope="col">Trend</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((m) => (
                <tr key={`${m.instance}/${m.metric}/${m.measure}`} data-testid="metrics-row">
                  <td className="ec-mono">{m.metric}</td>
                  <td>{m.measure}</td>
                  <td className="ec-tnum">{metricValue(m.latest)}</td>
                  <td className="ec-mono">{m.instance}</td>
                  <td>
                    <div>{formatDurationMs(Math.max(0, nowServerMs - m.receivedAt))} ago</div>
                    {m.sourceTimestamp !== undefined && <div className="ec-dim">{m.sourceTimestamp}</div>}
                  </td>
                  <td>
                    {m.points.length > 1 ? (
                      <Sparkline
                        points={m.points}
                        width={88}
                        height={28}
                        ariaLabel={`${m.metric} ${m.measure} trend`}
                        formatValue={metricValue}
                      />
                    ) : (
                      <span className="ec-dim">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogsTab({
  records,
  unavailable,
  dropped,
  detailKey,
  canSetLogLevel,
  onInvoke,
}: {
  records: ConsoleLogRecord[];
  unavailable?: { code: "FORBIDDEN" | "UNAVAILABLE"; reason: string };
  dropped?: number;
  detailKey: ComponentKey;
  canSetLogLevel: boolean;
  onInvoke: InvokeCommand;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [level, setLevel] = useState<"all" | LogLevel>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [clearedBeforeId, setClearedBeforeId] = useState(0);
  const [runtimeLevel, setRuntimeLevel] = useState<LogLevel>("info");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records
      .filter((r) => r.id > clearedBeforeId)
      .filter((r) => level === "all" || r.level === level)
      .filter((r) => {
        if (q === "") return true;
        return (
          r.message.toLowerCase().includes(q) ||
          r.logger.toLowerCase().includes(q) ||
          (r.thread?.toLowerCase().includes(q) ?? false)
        );
      });
  }, [clearedBeforeId, level, query, records]);

  useEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (el !== null) el.scrollTop = 0;
  }, [filtered.length, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    setFollow(el.scrollTop < 12);
  };

  const applyRuntimeLevel = () => {
    if (!canSetLogLevel) return;
    onInvoke(detailKey, "set-log-level", {
      level: runtimeLevel.toUpperCase(),
      ttlSecs: 300,
      publish: true,
    });
  };

  if (unavailable !== undefined) {
    return (
      <Tile className="ec-empty" data-testid="logs-unavailable">
        <h3>Logs unavailable</h3>
        <p className="ec-dim">{unavailable.reason}</p>
      </Tile>
    );
  }

  return (
    <div className="ec-logs" data-testid="logs-tab">
      <div className="ec-log-toolbar">
        <div className="ec-log-toolbar__group">
          <select
            className="ec-log-control"
            value={level}
            aria-label="Filter log level"
            data-testid="logs-level-filter"
            onChange={(e) => setLevel(e.target.value as "all" | LogLevel)}
          >
            <option value="all">All levels</option>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {logLevelLabel(l)}
              </option>
            ))}
          </select>
          <input
            className="ec-log-filter"
            value={query}
            placeholder="Filter logs"
            aria-label="Filter logs"
            data-testid="logs-text-filter"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button kind="ghost" size="sm" onClick={() => setFollow((v) => !v)} data-testid="logs-follow">
            {follow ? "Pause" : "Follow"}
          </Button>
          <Button
            kind="ghost"
            size="sm"
            onClick={() => setClearedBeforeId(records[0]?.id ?? clearedBeforeId)}
            data-testid="logs-clear"
          >
            Clear
          </Button>
        </div>
        <div className="ec-log-toolbar__group ec-log-toolbar__group--right">
          <span className="ec-dim">{records.length} retained</span>
          {dropped !== undefined && dropped > 0 && (
            <Tag size="sm" type="gray" className="ec-tag">
              {dropped} dropped
            </Tag>
          )}
          <select
            className="ec-log-control"
            value={runtimeLevel}
            aria-label="Temporary runtime log level"
            data-testid="logs-runtime-level"
            disabled={!canSetLogLevel}
            title={
              canSetLogLevel
                ? "Set the component runtime log level for five minutes"
                : "Unavailable until the component advertises cmd/set-log-level"
            }
            onChange={(e) => setRuntimeLevel(e.target.value as LogLevel)}
          >
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {logLevelLabel(l)}
              </option>
            ))}
          </select>
          <Button
            kind="ghost"
            size="sm"
            disabled={!canSetLogLevel}
            title={
              canSetLogLevel
                ? "Set the component runtime log level for five minutes"
                : "Unavailable until the component advertises cmd/set-log-level"
            }
            onClick={applyRuntimeLevel}
            data-testid="logs-apply-level"
          >
            Apply 5 min
          </Button>
        </div>
      </div>

      {records.length === 0 ? (
        <Tile className="ec-empty" data-testid="logs-empty">
          <p className="ec-dim">
            No bus-published log records have been received for this component.
          </p>
        </Tile>
      ) : filtered.length === 0 ? (
        <Tile className="ec-empty" data-testid="logs-filter-empty">
          <p className="ec-dim">No retained log records match the current filters.</p>
        </Tile>
      ) : (
        <div className="ec-log-tail" ref={listRef} onScroll={onScroll} data-testid="logs-tail">
          {filtered.map((r) => (
            <details className={`ec-log-row ec-log-row--${r.level}`} key={r.id} data-testid="logs-row">
              <summary>
                <span className="ec-mono ec-tnum ec-log-row__time">
                  {formatClockTime(r.receivedAt)}
                </span>
                <Tag size="sm" type={logLevelTagType(r.level)} className="ec-tag ec-log-row__level">
                  {logLevelLabel(r.level)}
                </Tag>
                <span className="ec-mono ec-log-row__logger">{r.logger}</span>
                <span className="ec-log-row__message">{r.message}</span>
              </summary>
              <div className="ec-log-row__detail">
                <div className="ec-slist__r">
                  <span className="ec-slist__k">Instance</span>
                  <span className="ec-slist__v ec-mono">{r.instance}</span>
                </div>
                {r.sourceTimestamp !== undefined && (
                  <div className="ec-slist__r">
                    <span className="ec-slist__k">Source time</span>
                    <span className="ec-slist__v ec-mono">{r.sourceTimestamp}</span>
                  </div>
                )}
                {r.sequence !== undefined && (
                  <div className="ec-slist__r">
                    <span className="ec-slist__k">Sequence</span>
                    <span className="ec-slist__v ec-mono">{r.sequence}</span>
                  </div>
                )}
                {r.thread !== undefined && (
                  <div className="ec-slist__r">
                    <span className="ec-slist__k">Thread</span>
                    <span className="ec-slist__v ec-mono">{r.thread}</span>
                  </div>
                )}
                {r.truncated === true && (
                  <div className="ec-slist__r">
                    <span className="ec-slist__k">Record</span>
                    <span className="ec-slist__v">Truncated by publisher</span>
                  </div>
                )}
                {r.fields !== undefined && (
                  <pre className="ec-panel-json">{JSON.stringify(r.fields, null, 2)}</pre>
                )}
                {r.error !== undefined && (
                  <pre className="ec-panel-json">{JSON.stringify(r.error, null, 2)}</pre>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ComponentDetailViewProps {
  state: ClientState;
  now: number;
  detailKey: ComponentKey;
  /** Render inside another screen's pane; hides breadcrumb/toasts and tightens spacing. */
  embedded?: boolean;
  /** Back to the Components screen (breadcrumb "Components"). */
  onBack?: () => void;
  /** To the Overview screen (breadcrumb "Overview"). */
  onOpenOverview?: () => void;
  /** Refresh/re-announce the selected component's effective configuration. */
  onRefreshConfig?: (key: ComponentKey) => void;
  /** Refresh the selected component's descriptor/panel manifest. */
  onRefreshDescriptor?: (key: ComponentKey) => void;
  /** To the Events & Alarms screen (the events tab link). */
  onOpenEvents?: () => void;
  /** To the Signals screen, scoped to this component (the header "Signals" deep-link). */
  onOpenSignals?: () => void;
  /** Fire a C4 command (the header Ping / Get config); defaults to a no-op. */
  onInvoke?: InvokeCommand;
}

export function ComponentDetailView({
  state,
  now,
  detailKey,
  embedded = false,
  onBack,
  onOpenOverview,
  onRefreshConfig,
  onRefreshDescriptor,
  onOpenEvents,
  onOpenSignals,
  onInvoke = NO_INVOKE,
}: ComponentDetailViewProps): React.JSX.Element {
  const { fleet, attributes, alarms } = state;
  const nowServerMs = now - fleet.clockOffsetMs;
  const comp = findComponent(fleet, detailKey);
  const id = componentKeyId(detailKey);

  const crumbs = (
    <div className="ec-crumbs" data-testid="detail-crumbs">
      <a role="link" tabIndex={0} data-testid="crumb-overview" onClick={() => onOpenOverview?.()}>
        Overview
      </a>
      <span className="ec-crumbs__sep">/</span>
      <a role="link" tabIndex={0} data-testid="crumb-components" onClick={() => onBack?.()}>
        Components
      </a>
      {(comp !== undefined ? componentDetailPath(comp) : [detailKey.device]).map((seg) => (
        <span key={seg} className="ec-crumbs__mid">
          <span className="ec-crumbs__sep">/</span>
          <span>{seg}</span>
        </span>
      ))}
      <span className="ec-crumbs__sep">/</span>
      <b>{detailKey.component}</b>
    </div>
  );

  if (comp === undefined) {
    return (
      <div className={`ec-detail${embedded ? " ec-detail--embedded" : ""}`}>
        {!embedded && crumbs}
        <h1 className="ec-ph">{detailKey.component}</h1>
        <Tile className="ec-empty" data-testid="detail-not-found">
          <h3>Component no longer in the fleet</h3>
          <p className="ec-dim">
            <span className="ec-mono">{id}</span> is not in the current fleet view — it may have
            been undiscovered after a console restart, or dropped off the bus.{" "}
            <a role="link" tabIndex={0} onClick={() => onBack?.()}>
              Back to Components
            </a>
            .
          </p>
        </Tile>
      </div>
    );
  }

  const instances = comp.instances ?? [];
  const openAlarms = alarmsForComponent(alarms.active, detailKey);
  const attrs = attributes.byId[id];
  const configEntry = state.configs.entriesById[id];
  const descriptorEntry = state.descriptions.entriesById[id];
  const descriptorManifest = descriptorEntry?.manifest;
  const panelViewCount = descriptorManifest?.panels?.views.length ?? 0;
  const canSetLogLevel = hasCommand(descriptorManifest, "set-log-level");
  const metricSeries = customMetricsForComponent(state.metrics.series, detailKey);
  const logEntry = state.logs.byId[id];
  const logCount = logEntry?.records.length ?? 0;
  const implementationParts = [
    descriptorManifest?.component?.implementation,
    descriptorManifest?.component?.version,
  ].filter((part): part is string => typeof part === "string" && part !== "");
  const subtitle = detailSubtitleParts(comp, attrs, Math.max(1, instances.length), nowServerMs);

  return (
    <div className={`ec-detail${embedded ? " ec-detail--embedded" : ""}`}>
      {!embedded && crumbs}
      <div className="ec-detail-head">
        <div>
          <h1 className="ec-ph">
            {comp.key.component} <StatusTag liveness={comp.liveness} size="md" />
          </h1>
          <div className="ec-ph-sub">
            <span>{subtitle.join(" · ")}</span>
            <Tag
              size="sm"
              type="outline"
              className="ec-tag"
              title={
                implementationParts.length > 0
                  ? "Advertised by cmd/describe"
                  : "Component did not advertise implementation metadata"
              }
            >
              {implementationParts.length > 0 ? implementationParts.join(" · ") : "implementation pending (describe)"}
            </Tag>
          </div>
        </div>
        <div className="ec-detail-head__actions">
          <Button kind="ghost" size="sm" onClick={() => onInvoke(comp.key, "ping")}>
            Ping
          </Button>
          <Button
            kind="ghost"
            size="sm"
            title="Ask the component for its effective configuration over the command path."
            onClick={() => onInvoke(comp.key, "get-configuration")}
          >
            Get config
          </Button>
          <Button
            kind="ghost"
            size="sm"
            data-testid="detail-open-signals"
            onClick={() => onOpenSignals?.()}
          >
            Signals
          </Button>
        </div>
      </div>

      <Tabs>
        <TabList aria-label="Component detail" className="ec-detail-tabs">
          <Tab data-testid="tab-health">Health</Tab>
          <Tab data-testid="tab-panel">Panel{panelViewCount > 0 ? ` · ${panelViewCount} views` : ""}</Tab>
          <Tab data-testid="tab-instances">Instances{instances.length > 1 ? ` · ${instances.length}` : ""}</Tab>
          <Tab data-testid="tab-config">Configuration</Tab>
          <Tab data-testid="tab-events">Events</Tab>
          <Tab data-testid="tab-metrics">Metrics{metricSeries.length > 0 ? ` · ${metricSeries.length}` : ""}</Tab>
          <Tab data-testid="tab-logs">Logs{logCount > 0 ? ` · ${logCount}` : ""}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <HealthTab comp={comp} attrs={attrs} openAlarms={openAlarms.length} nowServerMs={nowServerMs} />
          </TabPanel>
          <TabPanel>
            <DescriptorPanel
              entry={descriptorEntry}
              detailKey={detailKey}
              comp={comp}
              commands={state.commands}
              onRefreshDescriptor={onRefreshDescriptor}
              onInvoke={onInvoke}
            />
          </TabPanel>
          <TabPanel>
            <InstancesTab instances={instances} />
          </TabPanel>
          <TabPanel>
            <ConfigTab
              comp={comp}
              detailKey={detailKey}
              entry={configEntry}
              nowServerMs={nowServerMs}
              {...(onRefreshConfig !== undefined ? { onRefreshConfig } : {})}
            />
          </TabPanel>
          <TabPanel>
            <EventsTab
              comp={comp}
              events={state.events.entries}
              activeAlarms={openAlarms.length}
              nowServerMs={nowServerMs}
              {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
            />
          </TabPanel>
          <TabPanel>
            <MetricsTab series={metricSeries} detailKey={detailKey} nowServerMs={nowServerMs} />
          </TabPanel>
          <TabPanel className="ec-detail-panel--logs">
            <LogsTab
              records={logEntry?.records ?? []}
              unavailable={logEntry?.unavailable}
              dropped={logEntry?.dropped}
              detailKey={detailKey}
              canSetLogLevel={canSetLogLevel}
              onInvoke={onInvoke}
            />
          </TabPanel>
        </TabPanels>
      </Tabs>
      {!embedded && <CommandToasts commands={state.commands} />}
    </div>
  );
}

/**
 * The live container: binds the detail to the shared {@link FleetClient}. It requests the
 * component's effective cfg (the embedded Configuration tab) and subscribes the event/metric streams
 * while mounted — all keyed on the connection status, so a reconnect
 * re-issues them (server-side interest is per-connection). Unmounting unsubscribes events.
 */
export function ConnectedComponentDetailView({
  client,
  detailKey,
  onBack,
  onOpenOverview,
  onOpenEvents,
  onOpenSignals,
}: {
  client: FleetClient;
  detailKey: ComponentKey;
  onBack?: () => void;
  onOpenOverview?: () => void;
  onOpenEvents?: () => void;
  onOpenSignals?: () => void;
}): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const status = state.status;
  const keyId = componentKeyId(detailKey);

  useEffect(() => {
    // keyId (not the object) keys the effect so a same-identity re-render doesn't re-request.
    if (status === "connected") client.requestConfig(detailKey);
  }, [client, keyId, status, detailKey]);

  useEffect(() => {
    if (status === "connected") client.requestDescriptor(detailKey);
  }, [client, keyId, status, detailKey]);

  useEffect(() => {
    if (status === "connected") client.subscribeEvents();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeEvents(), [client]);
  useEffect(() => {
    if (status === "connected") client.subscribeMetrics();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeMetrics(), [client]);
  useEffect(() => {
    if (status === "connected") client.subscribeLogs(detailKey, { limit: 500 });
  }, [client, keyId, status, detailKey]);
  useEffect(() => () => client.unsubscribeLogs(detailKey), [client, keyId, detailKey]);

  return (
    <ComponentDetailView
      state={state}
      now={now}
      detailKey={detailKey}
      onInvoke={(key, verb, args) => client.invokeCommand(key, verb, args)}
      onRefreshConfig={(key) => client.refreshConfig(key)}
      onRefreshDescriptor={(key) => client.refreshDescriptor(key)}
      {...(onBack !== undefined ? { onBack } : {})}
      {...(onOpenOverview !== undefined ? { onOpenOverview } : {})}
      {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
      {...(onOpenSignals !== undefined ? { onOpenSignals } : {})}
    />
  );
}
