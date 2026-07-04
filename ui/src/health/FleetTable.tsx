/**
 * The fleet table — the Overview's "Fleet, grouped by …" surface, faithful to the
 * signed-off hi-fi mockup's NINE columns:
 *
 *   Health · Component · Device · Heartbeat · CPU · Memory · Conn · Capabilities · (controls)
 *
 * The group rows are DYNAMIC (built from `hier` — see `fleet/grouping.ts`): one collapsible
 * header per intermediate level (line, or area→line nested), each carrying the worst-of
 * rollup tag and a device / containment summary; `[site,device]` fleets degrade to a flat
 * list of device groups. Component rows carry the Carbon status treatment, the live
 * heartbeat age, and the runtime-attribute columns (CPU / Memory / Conn from the
 * AttributeStore — "—" where a component hasn't reported that attribute, e.g. a non-adapter
 * has no connection state).
 *
 * Capabilities depends on the component `describe` / panels manifest, which is DEFERRED to
 * Phase 2 — so the column is rendered honestly as a pending "—" (no fabricated data), never
 * silently dropped. Group toggles are real buttons (keyboard-focusable); the wrapper scrolls
 * horizontally on narrow screens.
 */
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from "@carbon/react";
import { ChevronDown, ChevronRight, Settings } from "@carbon/react/icons";
import type { ComponentKey, MetricPoint, RuntimeAttributes } from "@edgecommons/edge-console-protocol";
import type { CommandView } from "../fleet/command-store";
import type { ComponentView } from "../fleet/store";
import type { AttributesView } from "../fleet/attribute-store";
import type { FleetGrouping, GroupNode } from "../fleet/grouping";
import { connLevel } from "../fleet/grouping";
import { formatDurationMs } from "../fleet/selectors";
import { Sparkline } from "../common/Sparkline";
import { RollupTag, StatusTag } from "./StatusTag";
import { CommandControls } from "./CommandControls";

/** The command surface threaded down to each row (the C4 controls). */
export interface FleetTableCommandProps {
  commands: CommandView;
  onInvoke: (key: ComponentKey, verb: string, args?: Record<string, unknown>) => void;
}

/** The nine columns (the last header is the controls / overflow column). */
const COLUMNS = [
  "Health",
  "Component",
  "Device",
  "Heartbeat",
  "CPU",
  "Memory",
  "Conn",
  "Capabilities",
  "",
] as const;
const COLSPAN = COLUMNS.length;

/** A dim em-dash placeholder cell. */
function Dash({ testid }: { testid?: string }): React.JSX.Element {
  return (
    <span className="ec-dim" {...(testid !== undefined ? { "data-testid": testid } : {})}>
      —
    </span>
  );
}

/** The live heartbeat-age cell: bare age since the last keepalive, red once overdue. */
function HeartbeatCell({
  comp,
  nowServerMs,
}: {
  comp: ComponentView;
  nowServerMs: number;
}): React.JSX.Element {
  if (comp.lastStateAt === undefined) return <Dash />;
  const age = formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt));
  if (comp.liveness === "UNREACHABLE") {
    // Frozen under the device outage — the age is dimmed (last-known).
    return <span className="ec-dim ec-mono ec-tnum">{age}</span>;
  }
  const overdue = comp.liveness === "STALE" || comp.liveness === "OFFLINE";
  return <span className={`ec-mono ec-tnum${overdue ? " ec-overdue" : ""}`}>{age}</span>;
}

/** The Conn cell: the adapter's southbound connection state as a colored chip, or "—". */
function ConnCell({ attrs }: { attrs?: RuntimeAttributes }): React.JSX.Element {
  const state = attrs?.connectionState;
  if (state === undefined) return <Dash />;
  const level = connLevel(state);
  const type = level === "ok" ? "green" : level === "err" ? "red" : level === "unknown" ? "gray" : undefined;
  const className = level === "warn" ? "ec-tag ec-tag--warn" : "ec-tag";
  return (
    <Tag size="sm" {...(type !== undefined ? { type } : {})} className={className} title={state}>
      {state}
    </Tag>
  );
}

/**
 * The CPU cell: the latest cpu% with a leading recent-trend sparkline (mockup's first-row style)
 * when the component has reported a CPU series, else the bare "—". The sparkline reuses the shared
 * {@link Sparkline} mark (the series comes from the runtime `sys` cpu metric, R1).
 */
function CpuCell({
  attrs,
  component,
}: {
  attrs?: RuntimeAttributes;
  component: string;
}): React.JSX.Element {
  if (attrs?.cpuPercent === undefined) return <Dash />;
  const series = attrs.cpuSeries;
  const points: MetricPoint[] =
    series !== undefined ? series.map((value, at) => ({ at, value })) : [];
  return (
    <span className="ec-cpu-cell">
      {points.length > 1 && (
        <Sparkline
          points={points}
          width={52}
          height={16}
          ariaLabel={`${component} cpu trend`}
          formatValue={(v) => `${Math.round(v)}%`}
        />
      )}
      <span className="ec-tnum">{Math.round(attrs.cpuPercent)}%</span>
    </span>
  );
}

function ComponentRow({
  comp,
  attrs,
  nowServerMs,
  command,
}: {
  comp: ComponentView;
  attrs?: RuntimeAttributes;
  nowServerMs: number;
  command: FleetTableCommandProps;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <TableRow data-testid={`component-row-${comp.id}`}>
        <TableCell>
          <StatusTag liveness={comp.liveness} />
        </TableCell>
        <TableCell>
          <span className="ec-pri">{comp.key.component}</span>
        </TableCell>
        <TableCell>
          <span className="ec-mono">{comp.key.device}</span>
        </TableCell>
        <TableCell>
          <HeartbeatCell comp={comp} nowServerMs={nowServerMs} />
        </TableCell>
        <TableCell>
          <CpuCell attrs={attrs} component={comp.key.component} />
        </TableCell>
        <TableCell>
          {attrs?.memoryMb !== undefined ? (
            <span className="ec-tnum">{Math.round(attrs.memoryMb)} MB</span>
          ) : (
            <Dash />
          )}
        </TableCell>
        <TableCell>
          <ConnCell attrs={attrs} />
        </TableCell>
        <TableCell>
          <Dash testid={`capabilities-${comp.id}`} />
        </TableCell>
        <TableCell className="ec-ctrl-cell">
          <button
            type="button"
            className="ec-ctrl-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} controls for ${comp.key.component}`}
            data-testid={`controls-toggle-${comp.id}`}
            onClick={() => setExpanded((e) => !e)}
          >
            <Settings size={16} />
            <span className="ec-ctrl-toggle__label">Controls</span>
          </button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="ec-ctrl-detail" data-testid={`controls-detail-${comp.id}`}>
          <TableCell colSpan={COLSPAN}>
            <CommandControls comp={comp} commands={command.commands} onInvoke={command.onInvoke} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Pretty platform label for the group annotation (mockup: `HOST` / `Greengrass`). */
function platformLabel(platform: string): string {
  switch (platform.toUpperCase()) {
    case "HOST":
      return "HOST";
    case "GREENGRASS":
      return "Greengrass";
    case "KUBERNETES":
      return "Kubernetes";
    default:
      return platform;
  }
}

/** The device / containment summary appended to a group header row. */
function groupSummary(
  node: GroupNode,
  nowServerMs: number,
  contained: number,
  platformByDevice: Record<string, string>,
): string {
  const parts: string[] = [`${node.count} component${node.count === 1 ? "" : "s"}`];
  // Show which device(s) only for an intermediate tier (a device group already names it),
  // annotated with the device's platform when advertised (mockup: `press-gw-01 (Greengrass)`).
  if (node.level !== "device" && node.devices.length > 0) {
    if (node.devices.length === 1) {
      const device = node.devices[0]!;
      const platform = platformByDevice[device];
      parts.push(platform !== undefined ? `${device} (${platformLabel(platform)})` : device);
    } else {
      parts.push(`${node.devices.length} devices`);
    }
  }
  if (node.unreachable) {
    const since =
      node.unreachableSince !== undefined
        ? `bridge offline ${formatDurationMs(Math.max(0, nowServerMs - node.unreachableSince))}`
        : "bridge offline";
    parts.push(since);
    parts.push("frozen at last-known");
    if (contained > 0) parts.push(`alarms contained (+${contained})`);
  }
  return parts.join(" · ");
}

/** One group header row + its subtree (nested groups then component rows). */
function GroupRows({
  node,
  attributes,
  nowServerMs,
  command,
  containedByDevice,
  platformByDevice,
}: {
  node: GroupNode;
  attributes: AttributesView;
  nowServerMs: number;
  command: FleetTableCommandProps;
  containedByDevice: Record<string, number>;
  platformByDevice: Record<string, string>;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const contained = node.devices.reduce((n, d) => n + (containedByDevice[d] ?? 0), 0);
  return (
    <>
      <TableRow className="ec-group" data-testid={`group-${node.key}`}>
        <TableCell colSpan={COLSPAN}>
          <button
            type="button"
            className="ec-group__toggle"
            style={{ paddingInlineStart: `${node.depth * 1.5}rem` }}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.level} ${node.value}`}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            <span className="ec-group__label">
              {node.level.toUpperCase()} · <span className="ec-mono">{node.value}</span>
            </span>
            <RollupTag level={node.rollup} />
            <span className="ec-dim ec-group__summary">
              {groupSummary(node, nowServerMs, contained, platformByDevice)}
            </span>
          </button>
        </TableCell>
      </TableRow>
      {!collapsed &&
        node.children.map((child) => (
          <GroupRows
            key={child.key}
            node={child}
            attributes={attributes}
            nowServerMs={nowServerMs}
            command={command}
            containedByDevice={containedByDevice}
            platformByDevice={platformByDevice}
          />
        ))}
      {!collapsed &&
        node.components.map((comp) => (
          <ComponentRow
            key={comp.id}
            comp={comp}
            attrs={attributes.byId[comp.id]}
            nowServerMs={nowServerMs}
            command={command}
          />
        ))}
    </>
  );
}

export function FleetTable({
  grouping,
  attributes,
  nowServerMs,
  command,
  containedByDevice = {},
  platformByDevice = {},
}: {
  grouping: FleetGrouping;
  attributes: AttributesView;
  nowServerMs: number;
  command: FleetTableCommandProps;
  containedByDevice?: Record<string, number>;
  /** Device → advertised platform, for the group-row `(HOST)`/`(Greengrass)` annotation. */
  platformByDevice?: Record<string, string>;
}): React.JSX.Element {
  return (
    <TableContainer className="ec-fleet">
      <div className="ec-tablewrap">
        <Table size="lg" aria-label="Fleet components grouped by hierarchy">
          <TableHead>
            <TableRow>
              {COLUMNS.map((col, i) => (
                <TableHeader key={col === "" ? `col-${i}` : col}>{col}</TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {grouping.groups.map((node) => (
              <GroupRows
                key={node.key}
                node={node}
                attributes={attributes}
                nowServerMs={nowServerMs}
                command={command}
                containedByDevice={containedByDevice}
                platformByDevice={platformByDevice}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </TableContainer>
  );
}
