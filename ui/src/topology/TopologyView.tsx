/**
 * The Site-Topology screen (slice R3) — faithful to the signed-off hi-fi
 * (`docs/mockups-hifi.html`, `#screen-topology`): a custom, hand-rolled **SVG connectivity
 * graph** (no chart lib, like the sparklines) laid out in layers — cloud · northbound at the
 * top, the site bus, the components (grouped by device), and field · southbound devices at
 * the bottom — with arrows pointing at each endpoint a component connects to.
 *
 * All structure + edges are DERIVED, never hardcoded: the nodes/nesting come from identity
 * `hier`, the connectivity edges from each component's cfg, and the node/edge colors from
 * liveness + southbound connection state + device-UNREACHABLE containment (a down bridge
 * visually contains its subtree). See {@link buildTopologyModel}/{@link layoutTopology} for
 * the pure model.
 *
 * Honesty (surfaced, not faked): the mockup's blue component→component **internal dataflow**
 * edges are NOT derivable from identity+cfg today — they are rendered as an explicit pending
 * layer with a "needs flow metadata" note, never inferred. Clicking a component node opens its
 * Detail (a Topology chip is one of the four documented paths to a component).
 *
 * `TopologyView` is presentational (state in, DOM out); `ConnectedTopologyView` binds it to
 * the shared {@link FleetClient} and requests every component's cfg so the edges render.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InlineLoading, InlineNotification, Tag, Tile } from "@carbon/react";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import { useFleetState } from "../fleet/useFleet";
import {
  buildTopologyModel,
  layoutTopology,
} from "./topology-model";
import type {
  PlacedEdge,
  PlacedNode,
  TopoStatus,
  TopologyLayout,
} from "./topology-model";

/** Status → the node/edge color-modifier class (drives the ok/warn/err palette). */
function statusClass(status: TopoStatus): string {
  switch (status) {
    case "ok":
      return "is-ok";
    case "warn":
      return "is-warn";
    case "err":
    case "contained":
      return "is-err";
    case "stopped":
      return "is-stopped";
    case "neutral":
      return "is-neutral";
  }
}

/** The arrowhead marker id for an edge (by its effective color). */
function markerId(e: PlacedEdge): string {
  if (e.disconnected || e.status === "err" || e.status === "contained") return "ec-mk-err";
  if (e.status === "warn") return "ec-mk-warn";
  if (e.kind === "bus" || e.status === "neutral") return "ec-mk-bus";
  return "ec-mk-ok";
}

/** The edge stroke class (kind + status). */
function edgeClass(e: PlacedEdge): string {
  if (e.kind === "bus") return "ec-edge ec-edge--bus";
  if (e.disconnected || e.status === "err" || e.status === "contained") return "ec-edge ec-edge--err";
  if (e.status === "warn") return "ec-edge ec-edge--warn";
  return "ec-edge ec-edge--ok";
}

/** The arrowhead marker defs (one per color). */
function EdgeMarkers(): React.JSX.Element {
  const defs: Array<[string, string]> = [
    ["ec-mk-ok", "ec-mk--ok"],
    ["ec-mk-warn", "ec-mk--warn"],
    ["ec-mk-err", "ec-mk--err"],
    ["ec-mk-bus", "ec-mk--bus"],
  ];
  return (
    <defs>
      {defs.map(([id, cls]) => (
        <marker
          key={id}
          id={id}
          markerWidth={9}
          markerHeight={9}
          refX={7}
          refY={3}
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path className={cls} d="M0,0 L7,3 L0,6 Z" />
        </marker>
      ))}
    </defs>
  );
}

/** One graph edge (line + arrowhead), with the ✕ marker on a disconnected link. */
function GraphEdge({ edge }: { edge: PlacedEdge }): React.JSX.Element {
  return (
    <path
      className={edgeClass(edge)}
      d={`M${round(edge.x1)},${round(edge.y1)} L${round(edge.x2)},${round(edge.y2)}`}
      markerEnd={`url(#${markerId(edge)})`}
      data-testid={`topo-edge-${edge.id}`}
      data-disconnected={edge.disconnected === true ? "true" : undefined}
    >
      <title>{edge.label ?? edge.kind}</title>
    </path>
  );
}

/** One graph node — component (clickable → Detail), field, cloud, or the bus. */
function GraphNode({
  node,
  onOpenDetail,
}: {
  node: PlacedNode;
  onOpenDetail?: (key: ComponentKey) => void;
}): React.JSX.Element {
  const kindClass =
    node.kind === "component"
      ? "ec-gnode--comp"
      : node.kind === "field"
        ? "ec-gnode--field"
        : node.kind === "cloud"
          ? "ec-gnode--cloud"
          : "ec-gnode--infra";
  const clickable = node.kind === "component" && node.componentKey !== undefined;
  const key = node.componentKey;
  const textX = node.kind === "component" ? node.x + 24 : node.x + 12;
  const open = (): void => {
    if (clickable && key !== undefined) onOpenDetail?.(key);
  };
  return (
    <g
      className={`ec-gnode ${kindClass} ${statusClass(node.status)}`}
      {...(clickable
        ? {
            role: "button",
            tabIndex: 0,
            "data-goto": "detail",
            onClick: open,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            },
          }
        : {})}
      data-testid={node.kind === "component" ? `topo-comp-${node.componentKey ? keyId(node.componentKey) : node.id}` : `topo-node-${node.id}`}
    >
      <title>{node.title}</title>
      <rect className="ec-nodebox" x={round(node.x)} y={round(node.y)} width={node.w} height={node.h} rx={2} />
      {node.kind === "component" && (
        <>
          <rect className="ec-accent" x={round(node.x)} y={round(node.y)} width={4} height={node.h} />
          <circle className="ec-gdot" cx={round(node.x) + 16} cy={round(node.y) + 16} r={4} />
        </>
      )}
      <text className="ec-nlab" x={round(textX)} y={round(node.y) + (node.sublabel !== undefined ? 20 : node.h / 2 + 4)}>
        {node.label}
      </text>
      {node.sublabel !== undefined && (
        <text className="ec-nsub" x={round(textX)} y={round(node.y) + 34}>
          {node.sublabel}
        </text>
      )}
    </g>
  );
}

/** The disconnected-link ✕ overlay (mockup's crossed lines on the down edge). */
function DisconnectMark({ edge }: { edge: PlacedEdge }): React.JSX.Element {
  const s = 6;
  return (
    <g className="ec-edge-x" aria-hidden="true">
      <line x1={round(edge.midX - s)} y1={round(edge.midY - s)} x2={round(edge.midX + s)} y2={round(edge.midY + s)} />
      <line x1={round(edge.midX + s)} y1={round(edge.midY - s)} x2={round(edge.midX - s)} y2={round(edge.midY + s)} />
    </g>
  );
}

/** The graph itself (defs, groups, captions, edges, labels, nodes) inside its scroll wrap. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** The SVG "camera" (viewBox) — panning moves x/y, zooming scales w/h; graph coords are fixed. */
interface Camera {
  x: number;
  y: number;
  w: number;
  h: number;
}

function Graph({
  layout,
  onOpenDetail,
}: {
  layout: TopologyLayout;
  onOpenDetail?: (key: ComponentKey) => void;
}): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [cam, setCam] = useState<Camera>(() => ({ x: 0, y: 0, w: layout.width, h: layout.height }));
  const drag = useRef<{ x: number; y: number } | null>(null);

  const fit = useCallback((): void => {
    setCam({ x: 0, y: 0, w: layout.width, h: layout.height });
  }, [layout.width, layout.height]);

  // Zoom keeping the viewport point (px,py in 0..1) fixed. factor<1 zooms in; bounded 0.33x–3x.
  const zoomAround = useCallback(
    (factor: number, px: number, py: number): void => {
      setCam((c) => {
        const nw = clamp(c.w * factor, layout.width / 3, layout.width * 3);
        const nh = c.h * (nw / c.w);
        return { x: c.x + px * (c.w - nw), y: c.y + py * (c.h - nh), w: nw, h: nh };
      });
    },
    [layout.width],
  );

  // Native, non-passive wheel listener so preventDefault stops the page scrolling under the zoom.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const py = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      zoomAround(e.deltaY < 0 ? 0.9 : 1 / 0.9, px, py);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (drag.current === null || svgRef.current === null) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (e.clientX - drag.current.x) * (cam.w / rect.width);
    const dy = (e.clientY - drag.current.y) * (cam.h / rect.height);
    drag.current = { x: e.clientX, y: e.clientY };
    setCam((c) => ({ ...c, x: c.x - dx, y: c.y - dy }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="ec-graphwrap">
      <div className="ec-graph-controls" data-testid="topo-zoom-controls">
        <button type="button" className="ec-zoombtn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAround(0.8, 0.5, 0.5)}>
          +
        </button>
        <button type="button" className="ec-zoombtn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAround(1.25, 0.5, 0.5)}>
          −
        </button>
        <button type="button" className="ec-zoombtn ec-zoombtn--fit" aria-label="Fit graph to view" title="Fit to view" onClick={fit}>
          Fit
        </button>
      </div>
      <svg
        ref={svgRef}
        className="ec-graph ec-graph--interactive"
        viewBox={`${round(cam.x)} ${round(cam.y)} ${round(cam.w)} ${round(cam.h)}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Site connectivity graph — scroll to zoom, drag to pan"
        data-testid="topology-graph"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onDoubleClick={fit}
      >
        <EdgeMarkers />

        {layout.groups.map((g) => (
          <g key={g.device} className={`ec-graph-grp${g.unreachable ? " is-unreachable" : ""}`}>
            <rect className="ec-grp" x={round(g.x)} y={round(g.y)} width={round(g.w)} height={round(g.h)} rx={4} />
            <text className="ec-grplab" x={round(g.x) + 8} y={round(g.y) + 16}>
              {g.unreachable ? `${g.label} · UNREACHABLE` : g.label}
            </text>
          </g>
        ))}

        {layout.captions.map((c) => (
          <text key={c.label} className="ec-layerlab" x={layout.width - 8} y={c.y} textAnchor="end">
            {c.label}
          </text>
        ))}

        {layout.edges.map((e) => (
          <GraphEdge key={e.id} edge={e} />
        ))}
        {layout.edges
          .filter((e) => e.label !== undefined && e.kind === "southbound")
          .map((e) => (
            <text
              key={`lbl-${e.id}`}
              className={`ec-elab ${e.disconnected || e.status === "err" ? "is-err" : e.status === "warn" ? "is-warn" : ""}`}
              x={round(e.midX) + 8}
              y={round(e.midY)}
            >
              {e.label}
            </text>
          ))}
        {layout.edges.filter((e) => e.disconnected === true).map((e) => (
          <DisconnectMark key={`x-${e.id}`} edge={e} />
        ))}

        {layout.nodes.map((n) => (
          <GraphNode key={n.id} node={n} {...(onOpenDetail !== undefined ? { onOpenDetail } : {})} />
        ))}
      </svg>

      <div className="ec-gkey" data-testid="topo-legend">
        <span>
          <span className="ec-sw ec-sw--ok" /> connected
        </span>
        <span>
          <span className="ec-sw ec-sw--warn" /> degraded
        </span>
        <span>
          <span className="ec-sw ec-sw--err" /> disconnected
        </span>
        <span>
          <span className="ec-sw ec-sw--bus" /> bus / no data
        </span>
        <span className="ec-gkey__pending">
          <span className="ec-sw ec-sw--flow" /> internal dataflow (pending)
        </span>
        <span className="ec-dim">arrow → the target endpoint</span>
        <span className="ec-dim ec-gkey__panhint">scroll to zoom · drag to pan · Fit to reset</span>
      </div>
    </div>
  );
}

export interface TopologyViewProps {
  state: ClientState;
  onOpenDetail?: (key: ComponentKey) => void;
}

export function TopologyView({ state, onOpenDetail }: TopologyViewProps): React.JSX.Element {
  const { fleet, configs, attributes, self, status, hasSnapshot, fatalError } = state;
  const broker = self?.broker;

  const model = useMemo(
    () => buildTopologyModel({ fleet, configs, attributes, ...(broker !== undefined ? { broker } : {}) }),
    [fleet, configs, attributes, broker],
  );
  const layout = useMemo(() => layoutTopology(model), [model]);

  return (
    <div className="ec-topo">
      <h1 className="ec-ph">Site topology</h1>
      <div className="ec-ph-sub">
        <span>
          A live connectivity graph — each ggcommons <b>component</b> and the external{" "}
          <b>field</b> and <b>cloud</b> systems it talks to. Structure comes from identity, the
          endpoint arrows from each component&apos;s <code>cfg</code>.
        </span>
      </div>

      {fatalError !== undefined && (
        <InlineNotification
          kind="error"
          hideCloseButton
          title="Protocol version mismatch"
          subtitle={`${fatalError} — reload the page to pick up the current console UI.`}
        />
      )}
      {fatalError === undefined && hasSnapshot && status !== "connected" && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Gateway connection lost — reconnecting"
          subtitle="Showing the last-known topology; edges refresh as the stream resumes."
        />
      )}

      {!hasSnapshot ? (
        <Tile className="ec-empty" data-testid="empty-state">
          {fatalError === undefined && (status === "connecting" || status === "reconnecting") ? (
            <InlineLoading description="Connecting to the console gateway…" />
          ) : (
            <>
              <h3>Not connected</h3>
              <p className="ec-dim">
                The console gateway is unreachable
                {fatalError === undefined && " — retrying in the background"}. The graph appears as
                soon as the fleet stream is established.
              </p>
            </>
          )}
        </Tile>
      ) : model.stats.components === 0 ? (
        <Tile className="ec-empty" data-testid="empty-fleet">
          <h3>No components discovered yet</h3>
          <p className="ec-dim">
            The topology is built from the discovered fleet — components appear here automatically
            within one keepalive interval of coming up.
          </p>
        </Tile>
      ) : (
        <>
          <div className="ec-topo-legendrow" data-testid="topo-legendrow">
            <Tag size="sm" type="blue" className="ec-tag">
              Southbound
            </Tag>
            <Tag size="sm" type="blue" className="ec-tag">
              Northbound
            </Tag>
            <Tag size="sm" type="gray" className="ec-tag">
              Bus
            </Tag>
            <Tag size="sm" type="outline" className="ec-tag">
              Alarms only
            </Tag>
            <span className="ec-topo-legendrow__stats ec-dim" data-testid="topo-stats">
              {model.stats.components} component{model.stats.components === 1 ? "" : "s"} ·{" "}
              {model.stats.devices} device{model.stats.devices === 1 ? "" : "s"} ·{" "}
              {model.stats.fieldEndpoints} field · {model.stats.cloudEndpoints} cloud endpoint
              {model.stats.cloudEndpoints === 1 ? "" : "s"}
            </span>
            <span className="ec-topo-legendrow__hint ec-dim">
              hover a node or edge for detail · click a component to open it
            </span>
          </div>

          <Graph layout={layout} {...(onOpenDetail !== undefined ? { onOpenDetail } : {})} />

          <div className="ec-pending" data-testid="topo-flow-pending">
            <div className="ec-pending__badge">Needs flow metadata</div>
            <h3 className="ec-pending__title">Cross-component data-flow edges are pending</h3>
            <p>
              The mockup also shows blue <b>internal-dataflow</b> arrows between components (an
              adapter feeding the telemetry-processor on the same device). That inter-component
              flow is <b>not derivable</b> from identity + cfg today — it needs flow metadata the
              components do not publish yet — so it is surfaced here as pending rather than
              inferred. Everything drawn above is derived from data the console actually holds:
              the structure from identity, the endpoint arrows from each component&apos;s cfg.
            </p>
          </div>

          <div className="ec-callout">
            <b>Reading the graph.</b> Follow any arrow to its head to see the target:{" "}
            <span className="ec-mono">opcua-adapter → its OPC UA server</span> is{" "}
            <i>component (source) → southbound device (target)</i>. A red, dashed, ✕&apos;d edge
            means the adapter is <b>up</b> but its device link is <b>down</b>, so the fault is
            pinned to the exact edge, not smeared across the device. A whole <b>device</b> going
            UNREACHABLE contains its subtree (the down bridge, not each component). Field and cloud
            nodes are the external endpoints each component connects to, parsed from its cfg.
          </div>
        </>
      )}
    </div>
  );
}

/** The live container: shared client + request every component's cfg so edges render. */
export function ConnectedTopologyView({
  client,
  onOpenDetail,
}: {
  client: FleetClient;
  onOpenDetail?: (key: ComponentKey) => void;
}): React.JSX.Element {
  const state = useFleetState(client);
  const status = state.status;

  // The set of component keys (stable string; changes only when the roster changes, not on a
  // liveness tick) — request cfg for each when connected. Server-side push interest is
  // per-connection, so re-running on (re)connect is the whole reconnect story (like C5).
  const keys = useMemo(
    () => state.fleet.devices.flatMap((d) => d.components.map((c) => c.key)),
    [state.fleet],
  );
  const idsKey = useMemo(
    () => keys.map((k) => `${k.device}/${k.component}`).sort().join(","),
    [keys],
  );
  // `keys` is derived from `idsKey`; keying the effect on `idsKey` (a string) keeps it stable
  // across liveness ticks + heartbeats — it re-runs only when the roster changes or the
  // connection (re)comes up (server-side push interest is per-connection).
  useEffect(() => {
    if (status !== "connected") return;
    for (const k of keys) client.requestConfig(k);
  }, [client, status, idsKey]);

  return <TopologyView state={state} {...(onOpenDetail !== undefined ? { onOpenDetail } : {})} />;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function keyId(k: ComponentKey): string {
  return `${k.device}/${k.component}`;
}
