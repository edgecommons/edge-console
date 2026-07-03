/**
 * The fleet table — the mockup's "Fleet, grouped by …" detail surface: one
 * collapsible group row per DEVICE (the unit of reachability containment; the
 * mockup's line-level grouping arrives with the hierarchy rollup views), then one
 * row per component with the Carbon status treatment, live last-state age, uptime,
 * keepalive cadence and restart count — every cell fed by the folded fleet view.
 *
 * Composed from Carbon's structural table primitives (no DataTable state machine —
 * grouped rows are hand-rolled, as the mockup dictates). Group toggles are real
 * buttons (keyboard-focusable); the wrapper scrolls horizontally on narrow screens.
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
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import type { CommandView } from "../fleet/command-store";
import type { ComponentView, DeviceView, FleetView } from "../fleet/store";
import {
  deviceRollup,
  displayUptimeSecs,
  formatDurationMs,
  formatDurationSecs,
  hierPrefix,
} from "../fleet/selectors";
import { RollupTag, StatusTag } from "./StatusTag";
import { CommandControls } from "./CommandControls";

/** The command surface threaded down to each row (the C4 controls). */
export interface FleetTableCommandProps {
  commands: CommandView;
  onInvoke: (key: ComponentKey, verb: string, args?: Record<string, unknown>) => void;
}

const COLUMNS = [
  "Health",
  "Component",
  "Device",
  "Last state",
  "Uptime",
  "Keepalive",
  "Restarts",
  "Controls",
] as const;

/** The live last-state cell: age since the last keepalive, red once overdue. */
function LastStateCell({
  comp,
  nowServerMs,
}: {
  comp: ComponentView;
  nowServerMs: number;
}): React.JSX.Element {
  if (comp.liveness === "UNREACHABLE") {
    // Frozen under the device outage — show the frozen age, dimmed.
    const text =
      comp.lastStateAt !== undefined
        ? `${formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt))} ago`
        : "—";
    return <span className="ec-dim ec-mono ec-tnum">{text}</span>;
  }
  if (comp.lastStateAt === undefined) {
    return <span className="ec-dim">never</span>;
  }
  const overdue = comp.liveness === "STALE" || comp.liveness === "OFFLINE";
  return (
    <span className={`ec-mono ec-tnum${overdue ? " ec-overdue" : ""}`}>
      {formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt))} ago
    </span>
  );
}

function ComponentRow({
  comp,
  nowServerMs,
  command,
}: {
  comp: ComponentView;
  nowServerMs: number;
  command: FleetTableCommandProps;
}): React.JSX.Element {
  const uptime = displayUptimeSecs(comp, nowServerMs);
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <TableRow data-testid={`component-row-${comp.id}`}>
        <TableCell>
          <StatusTag liveness={comp.liveness} />
        </TableCell>
        <TableCell>
          <span className="ec-pri">{comp.key.component}</span>
          {comp.key.instance !== "main" && (
            <Tag size="sm" type="outline" className="ec-instance">
              {comp.key.instance}
            </Tag>
          )}
        </TableCell>
        <TableCell>
          <span className="ec-mono">{comp.key.device}</span>
        </TableCell>
        <TableCell>
          <LastStateCell comp={comp} nowServerMs={nowServerMs} />
        </TableCell>
        <TableCell>
          {uptime !== undefined ? (
            <span className="ec-tnum">
              {formatDurationSecs(Math.floor(uptime))}
              {comp.status === "STOPPED" && <span className="ec-dim"> (at stop)</span>}
            </span>
          ) : (
            <span className="ec-dim">—</span>
          )}
        </TableCell>
        <TableCell>
          <span className="ec-tnum">{comp.expectedIntervalSecs}s</span>
          <span className="ec-dim ec-cadence">
            {comp.cadenceSource === "cfg" ? " · cfg" : " · default"}
          </span>
        </TableCell>
        <TableCell>
          <span className={comp.restarts > 0 ? "ec-tnum" : "ec-dim ec-tnum"}>{comp.restarts}</span>
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
          <TableCell colSpan={COLUMNS.length}>
            <CommandControls
              comp={comp}
              commands={command.commands}
              onInvoke={command.onInvoke}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function DeviceGroup({
  device,
  nowServerMs,
  command,
}: {
  device: DeviceView;
  nowServerMs: number;
  command: FleetTableCommandProps;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const level = deviceRollup(device);
  const prefix = hierPrefix(device);
  const n = device.components.length;
  return (
    <>
      <TableRow className="ec-group" data-testid={`device-group-${device.device}`}>
        <TableCell colSpan={COLUMNS.length}>
          <button
            type="button"
            className="ec-group__toggle"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} device ${device.device}`}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            <span className="ec-group__label">
              DEVICE · <span className="ec-mono">{device.device}</span>
              {prefix !== "" && <span className="ec-dim"> · {prefix}</span>}
            </span>
            <RollupTag level={level} />
            <span className="ec-dim">
              {n} component{n === 1 ? "" : "s"}
              {device.unreachable &&
                device.unreachableSince !== undefined &&
                ` · bridge offline ${formatDurationMs(Math.max(0, nowServerMs - device.unreachableSince))} · frozen at last-known`}
            </span>
          </button>
        </TableCell>
      </TableRow>
      {!collapsed &&
        device.components.map((comp) => (
          <ComponentRow key={comp.id} comp={comp} nowServerMs={nowServerMs} command={command} />
        ))}
      {!collapsed && n === 0 && (
        <TableRow>
          <TableCell colSpan={COLUMNS.length}>
            <span className="ec-dim">
              No components attributed yet — this device has only been seen through its bridge.
            </span>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function FleetTable({
  fleet,
  nowServerMs,
  command,
}: {
  fleet: FleetView;
  nowServerMs: number;
  command: FleetTableCommandProps;
}): React.JSX.Element {
  return (
    <TableContainer className="ec-fleet">
      <div className="ec-tablewrap">
        <Table size="lg" aria-label="Fleet components by device">
          <TableHead>
            <TableRow>
              {COLUMNS.map((col) => (
                <TableHeader key={col}>{col}</TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {fleet.devices.map((device) => (
              <DeviceGroup
                key={device.device}
                device={device}
                nowServerMs={nowServerMs}
                command={command}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </TableContainer>
  );
}
