/**
 * The Site-Topology graph model (slice R3) — the PURE derivation behind the custom SVG
 * connectivity graph (`docs/mockups-hifi.html`, `#screen-topology`). No React, no IO, no
 * clock: fleet + configs + attributes in, a logical graph model out, then a deterministic
 * coordinate LAYOUT out. Both halves are unit-tested over several hier shapes and cfg
 * endpoint shapes; the SVG in {@link module:TopologyView} is the view.
 *
 * Topology is IDENTITY-driven and cfg-fed — both already on the wire, no new data:
 *  - the graph STRUCTURE (site → …intermediate hier levels… → device → component nesting)
 *    comes straight from each component's identity `hier` — the SAME dynamic-hierarchy the
 *    Overview grouping and the Components tree use (never a hardcoded "line"/"adapter" tier);
 *  - the connectivity EDGES (a component → the external endpoint it talks to) come from each
 *    component's effective `cfg` in the ConfigStore — an adapter's config already declares its
 *    OPC UA server / Modbus slave, a processor's its northbound stream target.
 *
 * HONESTLY derivable-only (surfaced, not faked):
 *  - the mockup also draws blue **internal-dataflow** edges component→component (adapter →
 *    telemetry-processor). That inter-component flow is NOT derivable from identity+cfg today
 *    (it needs flow metadata the components don't yet publish), so it is rendered as an
 *    explicit pending layer — see {@link TopologyModel.crossComponentFlow} — never inferred;
 *  - per-edge throughput (the mockup's "· 41 sig/s") needs per-endpoint signal attribution the
 *    console doesn't hold, so southbound edges carry the protocol + a live status hint, not a
 *    fabricated rate;
 *  - the component-node sublabel the mockup shows as the implementation LANGUAGE ("rust"/"java")
 *    needs the deferred `describe` manifest — we show the instance token instead, never invent one.
 */
import type { ComponentKey, Liveness, RuntimeAttributes } from "@edgecommons/edge-console-protocol";
import type { ComponentView, FleetView } from "../fleet/store";
import type { ConfigView } from "../fleet/config-store";
import type { AttributesView } from "../fleet/attribute-store";
import { connLevel } from "../fleet/grouping";
import { effectiveConfig } from "../configreview/selectors";

/* ------------------------------------------------------------------ endpoint parsing */

/** Which way a connection points relative to the site bus. */
export type EndpointDirection = "southbound" | "northbound";

/** One external endpoint parsed from a component's effective cfg. */
export interface ParsedEndpoint {
  /** Stable dedup id (shared endpoints across components merge into ONE node). */
  id: string;
  direction: EndpointDirection;
  /** Short protocol/target kind — "OPC UA" / "Modbus" / "Kinesis" / "AWS IoT Core" / … */
  kind: string;
  /** Headline (host[:port] / target name). */
  label: string;
  /** Sublabel ("OPC UA server · field" / "stream · northbound"). */
  sublabel: string;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Extract `host[:port]` from a scheme URL (`opc.tcp://host:port/path` → `host:port`). */
export function hostFromUrl(url: string): string {
  const m = /^[a-z0-9.+-]+:\/\/([^/?#]+)/i.exec(url);
  return m?.[1] ?? url;
}

/** Title-case a token ("GREENGRASS" → "Greengrass", "iot-core" → "Iot Core"). */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Friendly names for the northbound stream/cloud kinds the ecosystem ships. */
const CLOUD_KIND_LABELS: Record<string, string> = {
  kinesis: "Kinesis",
  "iot-core": "AWS IoT Core",
  iotcore: "AWS IoT Core",
  iot: "AWS IoT Core",
  s3: "S3",
  firehose: "Firehose",
  kafka: "Kafka",
  cloudwatch: "CloudWatch",
  mqtt: "MQTT northbound",
};

function cloudLabel(kind: string): string {
  return CLOUD_KIND_LABELS[kind.toLowerCase()] ?? titleCase(kind);
}

function mkEndpoint(
  direction: EndpointDirection,
  kind: string,
  label: string,
  sublabel: string,
): ParsedEndpoint {
  return { id: `${direction}:${kind}:${label}`.toLowerCase(), direction, kind, label, sublabel };
}

/** A southbound endpoint from an `{url}` or `{host,port}` endpoint/server object. */
function southboundFromEndpoint(obj: Record<string, unknown>): ParsedEndpoint | undefined {
  const url = asString(obj.url);
  if (url !== undefined) {
    const isOpc = /^opc\.tcp:/i.test(url);
    const kind = isOpc ? "OPC UA" : "Endpoint";
    return mkEndpoint("southbound", kind, hostFromUrl(url), `${kind} server · field`);
  }
  const host = asString(obj.host);
  if (host !== undefined) {
    const port = asNumber(obj.port);
    const label = port !== undefined ? `${host}:${port}` : host;
    return mkEndpoint("southbound", "Endpoint", label, "server · field");
  }
  return undefined;
}

/** A southbound Modbus endpoint from a `{host,port,unitId}` slave object. */
function southboundFromSlave(obj: Record<string, unknown>): ParsedEndpoint | undefined {
  const host = asString(obj.host);
  if (host === undefined) return undefined;
  const port = asNumber(obj.port);
  const unit = asNumber(obj.unitId) ?? asNumber(obj.unit);
  const label = port !== undefined ? `${host}:${port}` : host;
  const sub = unit !== undefined ? `Modbus unit ${unit} · field` : "Modbus slave · field";
  return mkEndpoint("southbound", "Modbus", label, sub);
}

/**
 * A southbound endpoint from a reference-adapter `connection` block — the REAL shipped shape
 * (`component.instances[].connection`): OPC UA carries a `endpoint` URL string
 * (`opc.tcp://host:port/`); Modbus carries `{host,port,unitId}` (a `unitId`/`transport` marks
 * it Modbus, else it is a generic host endpoint). This is the path that makes the graph's
 * arrows appear against the live adapters (the flatter `endpoint`/`slave` shapes above are the
 * synthetic-demo / test shapes).
 */
function southboundFromConnection(conn: Record<string, unknown>): ParsedEndpoint | undefined {
  const endpoint = asString(conn.endpoint);
  if (endpoint !== undefined) {
    const isOpc = /^opc\.tcp:/i.test(endpoint);
    const kind = isOpc ? "OPC UA" : "Endpoint";
    return mkEndpoint("southbound", kind, hostFromUrl(endpoint), `${kind} server · field`);
  }
  const host = asString(conn.host);
  if (host === undefined) return undefined;
  const port = asNumber(conn.port);
  const unit = asNumber(conn.unitId) ?? asNumber(conn.unit);
  const label = port !== undefined ? `${host}:${port}` : host;
  const transport = asString(conn.transport)?.toLowerCase();
  const isModbus = unit !== undefined || transport === "tcp" || transport === "rtu";
  return isModbus
    ? mkEndpoint("southbound", "Modbus", label, unit !== undefined ? `Modbus unit ${unit} · field` : "Modbus slave · field")
    : mkEndpoint("southbound", "Endpoint", label, "server · field");
}

/**
 * Parse the external endpoints a component connects to from its EFFECTIVE cfg (already
 * unwrapped from the `{config:{…}}` envelope). Lenient — every shape is optional, never
 * throws, unknown shapes yield nothing. Covers the reference adapters/processors:
 *  - `endpoint`/`endpoints[]`/`server`  → southbound server (OPC UA when `opc.tcp://`);
 *  - `slave`/`slaves[]`                 → southbound Modbus unit;
 *  - `instances[]` each `{endpoint|server|slave}` → the multi-server adapter shape;
 *  - `streams.*`/`northbound`/`targets[]` (a `kind`, or a bare url target) → northbound.
 */
export function parseEndpoints(effective: unknown): ParsedEndpoint[] {
  const out: ParsedEndpoint[] = [];
  const push = (e: ParsedEndpoint | undefined): void => {
    if (e !== undefined) out.push(e);
  };
  const cfg = asObject(effective);
  if (cfg === undefined) return out;

  // --- southbound: endpoint / endpoints[] / server / slave / slaves[] ---
  const endpointObj = asObject(cfg.endpoint);
  if (endpointObj !== undefined) push(southboundFromEndpoint(endpointObj));
  for (const e of asArray(cfg.endpoints)) {
    const o = asObject(e);
    if (o !== undefined) push(southboundFromEndpoint(o));
  }
  const serverObj = asObject(cfg.server);
  if (serverObj !== undefined) push(southboundFromEndpoint(serverObj));
  const slaveObj = asObject(cfg.slave);
  if (slaveObj !== undefined) push(southboundFromSlave(slaveObj));
  for (const s of asArray(cfg.slaves)) {
    const o = asObject(s);
    if (o !== undefined) push(southboundFromSlave(o));
  }
  // multi-server adapter: instances[] each carry an endpoint/server/slave
  for (const inst of asArray(cfg.instances)) {
    const o = asObject(inst);
    if (o === undefined) continue;
    const ep = asObject(o.endpoint);
    if (ep !== undefined) push(southboundFromEndpoint(ep));
    const sv = asObject(o.server);
    if (sv !== undefined) push(southboundFromEndpoint(sv));
    const sl = asObject(o.slave);
    if (sl !== undefined) push(southboundFromSlave(sl));
  }
  // REAL reference-adapter shape: component.instances[].connection.{endpoint | host,port,unitId}
  const component = asObject(cfg.component);
  if (component !== undefined) {
    for (const inst of asArray(component.instances)) {
      const o = asObject(inst);
      if (o === undefined) continue;
      const conn = asObject(o.connection);
      if (conn !== undefined) push(southboundFromConnection(conn));
    }
  }

  // REAL telemetry shape: streaming.streams[].sink.type — a cloud sink is northbound; a local
  // file sink is NOT an external node (it stays on the device), so skip it (no faked cloud edge).
  const streaming = asObject(cfg.streaming);
  if (streaming !== undefined) {
    for (const s of asArray(streaming.streams)) {
      const o = asObject(s);
      if (o === undefined) continue;
      const sink = asObject(o.sink);
      const type = asString(sink?.type) ?? asString(o.type);
      const t = type?.toLowerCase();
      if (t !== undefined && t !== "file" && t !== "local") push(northboundFromKind(type!));
    }
  }

  // --- northbound: streams.* (a named/kinded stream) / northbound / targets[] ---
  const streams = asObject(cfg.streams);
  if (streams !== undefined) {
    for (const [name, val] of Object.entries(streams)) {
      const o = asObject(val);
      if (o === undefined) continue;
      const kind = asString(o.kind);
      if (name.toLowerCase() === "northbound" || kind !== undefined) {
        push(northboundFromKind(kind ?? name));
      }
    }
  }
  const nb = asObject(cfg.northbound);
  if (nb !== undefined) {
    const kind = asString(nb.kind);
    const url = asString(nb.url);
    if (kind !== undefined) push(northboundFromKind(kind));
    else if (url !== undefined) push(mkEndpoint("northbound", "Target", hostFromUrl(url), "target · northbound"));
  }
  for (const t of asArray(cfg.targets)) {
    const o = asObject(t);
    if (o === undefined) continue;
    const kind = asString(o.kind);
    const url = asString(o.url);
    if (kind !== undefined) push(northboundFromKind(kind));
    else if (url !== undefined) push(mkEndpoint("northbound", "Target", hostFromUrl(url), "target · northbound"));
  }

  // dedup by id (a shared endpoint referenced twice = one node) — keep first-seen.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

function northboundFromKind(kind: string): ParsedEndpoint {
  const label = cloudLabel(kind);
  return mkEndpoint("northbound", label, label, "stream · northbound");
}

/* ------------------------------------------------------------------ the graph model */

/** The severity a node/edge carries (drives its color, the mockup's ok/warn/err palette). */
export type TopoStatus = "ok" | "warn" | "err" | "stopped" | "contained" | "neutral";

/** The four node types (mockup: `n-comp` / `n-field` / `n-cloud` / `n-infra`). */
export type TopoNodeKind = "component" | "field" | "cloud" | "bus";

/** One logical node (no coordinates — {@link layoutTopology} places it). */
export interface TopoNode {
  id: string;
  kind: TopoNodeKind;
  label: string;
  sublabel?: string;
  status: TopoStatus;
  /** Hover title. */
  title: string;
  /** The device the component runs on (component nodes only). */
  device?: string;
  /** The component key (component nodes only) — the click-to-Detail target. */
  componentKey?: ComponentKey;
}

/** Edge type (mockup: southbound / northbound / the gray `bus` relay). */
export type TopoEdgeKind = "southbound" | "northbound" | "bus";

/** One logical edge. */
export interface TopoEdge {
  id: string;
  from: string;
  to: string;
  kind: TopoEdgeKind;
  status: TopoStatus;
  label?: string;
  /** A down link (dashed + the ✕ marker) — "the fault is pinned to the exact edge". */
  disconnected?: boolean;
}

/** One device grouping rectangle (mockup `.grp`/`.grplab`) — dynamic from identity. */
export interface TopoGroup {
  device: string;
  /** "stamping · press-gw-01 · Greengrass" — intermediate hier values · device · platform. */
  label: string;
  /** The component-node ids inside this group (in fleet order). */
  componentIds: string[];
  /** The whole device is UNREACHABLE (containment — the down bridge contains its subtree). */
  unreachable: boolean;
}

/** The honest cross-component-flow state (the derivable-only flag). */
export interface CrossComponentFlow {
  /** Always false today — inter-component dataflow is not on the wire. */
  derivable: boolean;
  note: string;
}

/** Summary counts (the page's stat strip). */
export interface TopoStats {
  components: number;
  fieldEndpoints: number;
  cloudEndpoints: number;
  devices: number;
  edges: number;
}

/** The whole logical graph model. */
export interface TopologyModel {
  site?: string;
  groups: TopoGroup[];
  /** Component nodes, then field, then cloud, then the single bus node. */
  nodes: TopoNode[];
  edges: TopoEdge[];
  bus: TopoNode;
  crossComponentFlow: CrossComponentFlow;
  stats: TopoStats;
}

export interface TopologyInputs {
  fleet: FleetView;
  configs: ConfigView;
  attributes: AttributesView;
  /** The site-bus broker host (from `ConsoleSelf.broker`) — the bus node's foot. */
  broker?: string;
}

const CROSS_COMPONENT_FLOW_NOTE =
  "Component-to-component data flow (e.g. adapter → telemetry-processor) needs flow metadata " +
  "the components do not publish yet — it is shown as pending, never inferred.";

/** Liveness → a node's status color. */
export function livenessStatus(l: Liveness): TopoStatus {
  switch (l) {
    case "FRESH":
      return "ok";
    case "WARN":
    case "STALE":
      return "warn";
    case "OFFLINE":
      return "err";
    case "STOPPED":
      return "stopped";
    case "UNREACHABLE":
      return "contained";
  }
}

/** Liveness → the human word the hover title uses. */
function livenessWord(l: Liveness): string {
  switch (l) {
    case "FRESH":
      return "Healthy";
    case "WARN":
      return "Degraded";
    case "STALE":
      return "Stale";
    case "OFFLINE":
      return "Offline";
    case "STOPPED":
      return "Stopped";
    case "UNREACHABLE":
      return "Unreachable (device)";
  }
}

const STATUS_RANK: Record<TopoStatus, number> = {
  neutral: 0,
  ok: 1,
  stopped: 2,
  warn: 3,
  contained: 4,
  err: 5,
};

/** The worse of two statuses (err/contained beat warn beat ok beat neutral). */
export function worstStatus(a: TopoStatus, b: TopoStatus): TopoStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * The southbound edge status: the adapter's live `connectionState` wins (an adapter can be
 * UP while its device link is DOWN — the mockup's ✕'d edge), falling back to the component's
 * own liveness when it publishes no southbound_health.
 */
function southboundEdgeStatus(
  comp: ComponentView,
  attrs: RuntimeAttributes | undefined,
): { status: TopoStatus; disconnected: boolean } {
  if (comp.liveness === "UNREACHABLE") return { status: "contained", disconnected: true };
  const lvl = connLevel(attrs?.connectionState);
  if (lvl !== "unknown") {
    if (lvl === "ok") return { status: "ok", disconnected: false };
    if (lvl === "warn") return { status: "warn", disconnected: false };
    return { status: "err", disconnected: true };
  }
  switch (comp.liveness) {
    case "FRESH":
      return { status: "ok", disconnected: false };
    case "WARN":
    case "STALE":
      return { status: "warn", disconnected: false };
    case "OFFLINE":
      return { status: "err", disconnected: true };
    case "STOPPED":
      return { status: "neutral", disconnected: false };
    default:
      return { status: "ok", disconnected: false };
  }
}

/** The southbound edge label: protocol + a live status hint (no fabricated rate). */
function southboundLabel(ep: ParsedEndpoint, comp: ComponentView, attrs: RuntimeAttributes | undefined): string {
  const lvl = connLevel(attrs?.connectionState);
  if (lvl === "err" || comp.liveness === "OFFLINE" || comp.liveness === "UNREACHABLE") {
    return `${ep.kind} · DISCONNECTED`;
  }
  if (attrs?.readErrors !== undefined && attrs.readErrors > 0) return `${ep.kind} · read errors`;
  if (lvl === "warn") return `${ep.kind} · reconnecting`;
  return ep.kind;
}

/** Prettify a platform token for the group caption (keep HOST upper; title-case the rest). */
function prettyPlatform(platform: string): string {
  if (platform.toUpperCase() === "HOST") return "HOST";
  return titleCase(platform);
}

/** The device group caption: intermediate hier values · device · platform (all dynamic). */
function groupLabel(first: ComponentView, device: string, platform: string | undefined): string {
  const parts: string[] = [];
  if (first.hier.length > 2) {
    for (const lvl of first.hier.slice(1, first.hier.length - 1)) parts.push(lvl.value);
  }
  parts.push(device);
  if (platform !== undefined && platform !== "") parts.push(prettyPlatform(platform));
  return parts.join(" · ");
}

/** The most frequent site value across the fleet (one console = one site in practice). */
function deriveSite(fleet: FleetView): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const d of fleet.devices) {
    for (const c of d.components) {
      const site = c.hier[0]?.value;
      if (site === undefined) continue;
      const n = (counts.get(site) ?? 0) + 1;
      counts.set(site, n);
      if (n > bestN) {
        bestN = n;
        best = site;
      }
    }
  }
  return best;
}

/**
 * Build the logical topology graph from the fleet (identity → structure) and the retained
 * configs (cfg → connectivity edges), with runtime attributes coloring the southbound edges.
 * Pure — the SAME dynamic-hierarchy discipline as the Overview grouping / Components tree.
 */
export function buildTopologyModel(inputs: TopologyInputs): TopologyModel {
  const { fleet, configs, attributes } = inputs;
  const componentNodes: TopoNode[] = [];
  const groups: TopoGroup[] = [];
  const edges: TopoEdge[] = [];
  const fieldById = new Map<string, TopoNode>();
  const cloudById = new Map<string, TopoNode>();
  /** cloud node id → the statuses of the components streaming to it (for the bus→cloud edge). */
  const cloudContrib = new Map<string, TopoStatus[]>();
  /** component node ids that publish a northbound stream (they get a component→bus edge). */
  const busComponents = new Set<string>();

  for (const device of fleet.devices) {
    if (device.components.length === 0) continue;
    const first = device.components[0]!;
    const platform = attributes.byId[first.id]?.platform;
    const componentIds: string[] = [];

    for (const comp of device.components) {
      const cid = `comp:${comp.id}`;
      componentIds.push(cid);
      const node: TopoNode = {
        id: cid,
        kind: "component",
        label: comp.key.component,
        status: livenessStatus(comp.liveness),
        title: `${comp.key.component} — ${livenessWord(comp.liveness)}`,
        device: device.device,
        componentKey: comp.key,
        ...(comp.key.instance !== "main" ? { sublabel: comp.key.instance } : {}),
      };
      componentNodes.push(node);

      const entry = configs.entriesById[comp.id];
      const eff = entry !== undefined && entry.phase === "loaded" ? effectiveConfig(entry.body) : undefined;
      const eps = eff !== undefined ? parseEndpoints(eff) : [];
      const attrs = attributes.byId[comp.id];

      for (const ep of eps) {
        if (ep.direction === "southbound") {
          const fid = `field:${ep.id}`;
          if (!fieldById.has(fid)) {
            fieldById.set(fid, {
              id: fid,
              kind: "field",
              label: ep.label,
              sublabel: ep.sublabel,
              status: "neutral",
              title: `${ep.label} — ${ep.kind} (southbound target)`,
            });
          }
          const est = southboundEdgeStatus(comp, attrs);
          if (est.disconnected) fieldById.get(fid)!.status = "err";
          edges.push({
            id: `e:${cid}->${fid}`,
            from: cid,
            to: fid,
            kind: "southbound",
            status: est.status,
            label: southboundLabel(ep, comp, attrs),
            ...(est.disconnected ? { disconnected: true } : {}),
          });
        } else {
          const clid = `cloud:${ep.id}`;
          if (!cloudById.has(clid)) {
            cloudById.set(clid, {
              id: clid,
              kind: "cloud",
              label: ep.label,
              sublabel: ep.sublabel,
              status: "ok",
              title: `${ep.label} — northbound target`,
            });
          }
          busComponents.add(cid);
          const nst = livenessStatus(comp.liveness);
          cloudContrib.set(clid, [...(cloudContrib.get(clid) ?? []), nst]);
        }
      }
    }

    groups.push({ device: device.device, label: groupLabel(first, device.device, platform), componentIds, unreachable: device.unreachable });
  }

  const bus: TopoNode = {
    id: "bus",
    kind: "bus",
    label: inputs.broker !== undefined && inputs.broker !== "" ? `Site UNS broker · ${inputs.broker}` : "Site UNS broker",
    sublabel: "edge-console observes all classes",
    status: "neutral",
    title: "Site UNS broker — the console subscribes every UNS class here",
  };

  // component → bus (the gray relay) for every northbound-publishing component…
  for (const cid of busComponents) {
    edges.push({ id: `e:${cid}->bus`, from: cid, to: "bus", kind: "bus", status: "neutral" });
  }
  // …then bus → cloud (northbound), colored by the worst of its contributing components.
  for (const [clid, statuses] of cloudContrib) {
    const st = statuses.reduce(worstStatus, "ok" as TopoStatus);
    const disconnected = st === "err" || st === "contained";
    edges.push({
      id: `e:bus->${clid}`,
      from: "bus",
      to: clid,
      kind: "northbound",
      status: st,
      label: "northbound",
      ...(disconnected ? { disconnected: true } : {}),
    });
    cloudById.get(clid)!.status = disconnected ? "err" : "ok";
  }

  const nodes = [...componentNodes, ...fieldById.values(), ...cloudById.values(), bus];
  const site = deriveSite(fleet);
  return {
    ...(site !== undefined ? { site } : {}),
    groups,
    nodes,
    edges,
    bus,
    crossComponentFlow: { derivable: false, note: CROSS_COMPONENT_FLOW_NOTE },
    stats: {
      components: componentNodes.length,
      fieldEndpoints: fieldById.size,
      cloudEndpoints: cloudById.size,
      devices: groups.length,
      edges: edges.length,
    },
  };
}

/* ------------------------------------------------------------------ the coordinate layout */

/** A placed node (logical node + box geometry). */
export interface PlacedNode extends TopoNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A placed device group rectangle. */
export interface PlacedGroup extends TopoGroup {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A placed edge (endpoints + the label/✕ midpoint). */
export interface PlacedEdge extends TopoEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  midX: number;
  midY: number;
}

/** One right-aligned layer caption (mockup `.layerlab`). */
export interface LayerCaption {
  label: string;
  y: number;
}

/** The laid-out graph the SVG view renders. */
export interface TopologyLayout {
  width: number;
  height: number;
  groups: PlacedGroup[];
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  captions: LayerCaption[];
}

/** Layout geometry (mockup-matched band positions + node sizes). */
export const LAYOUT = {
  height: 660,
  marginL: 48,
  marginR: 24,
  cloudY: 34,
  busY: 126,
  compY: 250,
  fieldY: 560,
  comp: { w: 152, h: 46, gap: 24 },
  field: { w: 162, h: 52, gap: 18 },
  cloud: { w: 152, h: 42, gap: 20 },
  bus: { w: 300, h: 48 },
  groupPadX: 22,
  groupGap: 44,
  minWidth: 940,
} as const;

function rowWidth(count: number, w: number, gap: number): number {
  return count <= 0 ? 0 : count * w + (count - 1) * gap;
}

/** Pull the target end back toward the source by `by` px (so the arrowhead clears the node). */
function shorten(x1: number, y1: number, x2: number, y2: number, by: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len <= by || len === 0) return [x2, y2];
  return [x2 - (dx / len) * by, y2 - (dy / len) * by];
}

/**
 * Deterministically lay the model out into a layered graph (cloud · site-bus · components ·
 * field), grouped by device left→right. Pure — same input, same coordinates every time.
 */
export function layoutTopology(model: TopologyModel): TopologyLayout {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const placed = new Map<string, PlacedNode>();
  const groups: PlacedGroup[] = [];

  // Which field endpoints hang under which group: assign each to the FIRST group whose
  // component connects to it (shared endpoints render once, under that group).
  const fieldTargetsByComp = new Map<string, string[]>();
  for (const e of model.edges) {
    if (e.kind !== "southbound") continue;
    const list = fieldTargetsByComp.get(e.from) ?? [];
    list.push(e.to);
    fieldTargetsByComp.set(e.from, list);
  }
  const assignedFields = new Set<string>();

  let cursor = LAYOUT.marginL;
  for (const group of model.groups) {
    const compNodes = group.componentIds.map((id) => byId.get(id)).filter((n): n is TopoNode => n !== undefined);
    const fieldIds: string[] = [];
    for (const cid of group.componentIds) {
      for (const fid of fieldTargetsByComp.get(cid) ?? []) {
        if (assignedFields.has(fid)) continue;
        assignedFields.add(fid);
        fieldIds.push(fid);
      }
    }
    const fieldNodes = fieldIds.map((id) => byId.get(id)).filter((n): n is TopoNode => n !== undefined);

    const compRowW = rowWidth(compNodes.length, LAYOUT.comp.w, LAYOUT.comp.gap);
    const fieldRowW = rowWidth(fieldNodes.length, LAYOUT.field.w, LAYOUT.field.gap);
    const innerW = Math.max(compRowW, fieldRowW, LAYOUT.comp.w);
    const groupW = innerW + 2 * LAYOUT.groupPadX;
    const groupX0 = cursor;

    const compStart = groupX0 + LAYOUT.groupPadX + (innerW - compRowW) / 2;
    compNodes.forEach((n, i) => {
      placed.set(n.id, {
        ...n,
        x: compStart + i * (LAYOUT.comp.w + LAYOUT.comp.gap),
        y: LAYOUT.compY,
        w: LAYOUT.comp.w,
        h: LAYOUT.comp.h,
      });
    });
    const fieldStart = groupX0 + LAYOUT.groupPadX + (innerW - fieldRowW) / 2;
    fieldNodes.forEach((n, i) => {
      placed.set(n.id, {
        ...n,
        x: fieldStart + i * (LAYOUT.field.w + LAYOUT.field.gap),
        y: LAYOUT.fieldY,
        w: LAYOUT.field.w,
        h: LAYOUT.field.h,
      });
    });

    groups.push({
      ...group,
      x: groupX0,
      y: LAYOUT.compY - 34,
      w: groupW,
      h: LAYOUT.comp.h + 56,
    });
    cursor = groupX0 + groupW + LAYOUT.groupGap;
  }

  const contentRight = model.groups.length > 0 ? cursor - LAYOUT.groupGap : LAYOUT.marginL;
  const width = Math.max(LAYOUT.minWidth, contentRight + LAYOUT.marginR);

  // Cloud nodes: global, centered across the canvas in the northbound band.
  const cloudNodes = model.nodes.filter((n) => n.kind === "cloud");
  const cloudRowW = rowWidth(cloudNodes.length, LAYOUT.cloud.w, LAYOUT.cloud.gap);
  const cloudStart = (width - cloudRowW) / 2;
  cloudNodes.forEach((n, i) => {
    placed.set(n.id, {
      ...n,
      x: cloudStart + i * (LAYOUT.cloud.w + LAYOUT.cloud.gap),
      y: LAYOUT.cloudY,
      w: LAYOUT.cloud.w,
      h: LAYOUT.cloud.h,
    });
  });

  // The single bus node, centered in the site-bus band.
  placed.set(model.bus.id, {
    ...model.bus,
    x: (width - LAYOUT.bus.w) / 2,
    y: LAYOUT.busY,
    w: LAYOUT.bus.w,
    h: LAYOUT.bus.h,
  });

  // Edges: connect the near borders (source below→above target for southbound; the reverse
  // for the upward bus/northbound relay), trimming the arrow end clear of the node.
  const edges: PlacedEdge[] = [];
  for (const e of model.edges) {
    const from = placed.get(e.from);
    const to = placed.get(e.to);
    if (from === undefined || to === undefined) continue;
    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    if (e.kind === "southbound") {
      // component (above) → field (below)
      x1 = from.x + from.w / 2;
      y1 = from.y + from.h;
      x2 = to.x + to.w / 2;
      y2 = to.y;
    } else {
      // upward relay: component/bus (below) → bus/cloud (above)
      x1 = from.x + from.w / 2;
      y1 = from.y;
      x2 = to.x + to.w / 2;
      y2 = to.y + to.h;
    }
    const [tx, ty] = shorten(x1, y1, x2, y2, 4);
    edges.push({ ...e, x1, y1, x2: tx, y2: ty, midX: (x1 + tx) / 2, midY: (y1 + ty) / 2 });
  }

  const captions: LayerCaption[] = [
    { label: "cloud · northbound", y: LAYOUT.cloudY + 8 },
    { label: "site bus", y: LAYOUT.busY + 8 },
    { label: "field · southbound", y: LAYOUT.fieldY + 8 },
  ];

  return {
    width,
    height: LAYOUT.height,
    groups,
    nodes: [...placed.values()],
    edges,
    captions,
  };
}
