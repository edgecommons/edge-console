/**
 * The Overview screen ("Edge health") — priority #1, the browser side of the console's
 * reason to exist. Faithful to `docs/mockups-hifi.html` (the signed-off hi-fi): the
 * page-context header (site + "N components across M <level>" + live WS/bus status), the
 * four summary tiles (Site health · Active alerts · Edge bus msgs/s · Edge node console
 * self), the inline containment notes ("the road is down, not the houses"), and the fleet
 * table — DYNAMICALLY grouped from each component's `hier` (never a hardcoded tier) into
 * the mockup's nine columns. 100 % live data from the R0 gateway — no mock content.
 *
 * `EdgeHealthView` is purely presentational (state in, DOM out — component-testable
 * without a socket); `ConnectedEdgeHealthView` binds it to a {@link FleetClient}. The
 * app-bar global search (shared {@link SearchContext}) filters the fleet here.
 */
import { useState } from "react";
import { InlineLoading, InlineNotification, Tag, Tile } from "@carbon/react";
import { CircleFilled } from "@carbon/react/icons";
import type { AttributesView } from "../fleet/attribute-store";
import type { ComponentKey, Liveness } from "@edgecommons/edge-console-protocol";
import type { ClientState, ConnectionStatus, FleetClient } from "../fleet/client";
import { alarmNotes, containmentNotes, summarize } from "../fleet/selectors";
import { formatDurationMs } from "../fleet/selectors";
import { groupFleet, pluralizeUnit } from "../fleet/grouping";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { useSearch } from "../shell/search";
import { FleetTable } from "./FleetTable";
import { IssueNotifications } from "./IssueNotifications";
import { SummaryTiles } from "./SummaryTiles";
import { CommandToasts } from "./CommandToasts";

/** Invoke a command on a component (C4). Threaded to the fleet table's per-row controls. */
export type InvokeCommand = (key: ComponentKey, verb: string, args?: Record<string, unknown>) => void;

/** A no-op used when the view is rendered without a live command seam (presentational tests). */
const NO_INVOKE: InvokeCommand = () => undefined;

/** The fleet-tools "Status ▾" filter options — a label per effective liveness (plus "All"). */
const STATUS_FILTERS: Array<{ value: Liveness | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "FRESH", label: "Healthy" },
  { value: "WARN", label: "Warning" },
  { value: "STALE", label: "Stale" },
  { value: "OFFLINE", label: "Offline" },
  { value: "STOPPED", label: "Stopped" },
  { value: "UNREACHABLE", label: "Unreachable" },
];

/** Map each device to its advertised platform (from the runtime attributes) — the group annotation. */
export function platformsByDevice(attributes: AttributesView): Record<string, string> {
  const byDevice: Record<string, string> = {};
  for (const attrs of Object.values(attributes.byId)) {
    if (attrs.platform !== undefined && byDevice[attrs.key.device] === undefined) {
      byDevice[attrs.key.device] = attrs.platform;
    }
  }
  return byDevice;
}

/** The header's connection chip (mockup: "WS Live"). */
function ConnectionTag({ status }: { status: ConnectionStatus }): React.JSX.Element {
  const map: Record<ConnectionStatus, { type: "green" | "red" | "gray"; label: string }> = {
    connected: { type: "green", label: "WS Live" },
    connecting: { type: "gray", label: "WS Connecting" },
    reconnecting: { type: "red", label: "WS Reconnecting" },
    disconnected: { type: "red", label: "WS Disconnected" },
  };
  const { type, label } = map[status];
  return (
    <Tag size="sm" type={type} renderIcon={CircleFilled} className="ec-tag" data-testid="ws-status">
      {label}
    </Tag>
  );
}

export interface EdgeHealthViewProps {
  state: ClientState;
  /** Client-clock ms (the 1 Hz tick) — drives every age/uptime cell. */
  now: number;
  /** Fire a C4 command from a component's row controls; defaults to a no-op. */
  onInvoke?: InvokeCommand;
  /** The shared global-search query (from the app-bar) — filters the fleet. */
  query?: string;
  /** Open the Events & Alarms screen (the Active alerts tile / "View" affordance). */
  onOpenEvents?: () => void;
  /** Set the shared search query (the fleet-local search box mirrors the app-bar). */
  onSearchChange?: (query: string) => void;
  /** Acknowledge an active alarm (R0 `ack-alarm`) — the per-note "Ack" action. */
  onAck?: (alarmId: string) => void;
}

export function EdgeHealthView({
  state,
  now,
  onInvoke = NO_INVOKE,
  query = "",
  onOpenEvents,
  onSearchChange,
  onAck,
}: EdgeHealthViewProps): React.JSX.Element {
  const { fleet, status, hasSnapshot, fatalError, alarms, attributes } = state;
  const counts = summarize(fleet);
  // All fleet timestamps are server-clock; render ages on the server timeline.
  const nowServerMs = now - fleet.clockOffsetMs;

  // The fleet-tools "Status ▾" filter (Overview-local); "all" = unfiltered.
  const [statusFilter, setStatusFilter] = useState<Liveness | "all">("all");
  const effectiveStatus = statusFilter === "all" ? undefined : statusFilter;

  // Per-device contained-alarm counts (the "+N suppressed" containment rollup).
  const containedByDevice: Record<string, number> = {};
  for (const a of alarms.active) {
    if (a.contained) containedByDevice[a.key.device] = (containedByDevice[a.key.device] ?? 0) + 1;
  }
  // The Overview's actionable notes: the AlarmTracker active alarms (View/Ack) + the
  // whole-device containment notes ("the road is down, not the houses").
  const alerts = alarmNotes(alarms.active, nowServerMs);
  const containment = containmentNotes(fleet, nowServerMs, containedByDevice);
  // Each device's advertised platform — the group-row `(HOST)`/`(Greengrass)` annotation.
  const platformByDevice = platformsByDevice(attributes);

  // The dynamic grouping: `meta` (unfiltered) drives the header/section labels; the table
  // renders the query- and status-filtered tree so empty groups vanish.
  const meta = groupFleet(fleet);
  const grouping =
    query.trim() === "" && effectiveStatus === undefined
      ? meta
      : groupFleet(fleet, query, effectiveStatus);
  const unitLabel = pluralizeUnit(meta.unit, meta.unitCount);

  return (
    <div className="ec-health">
      <h1 className="ec-ph">Edge health</h1>
      <div className="ec-ph-sub">
        <span>
          {meta.site !== undefined && (
            <>
              Site <b>{meta.site}</b> ·{" "}
            </>
          )}
          {counts.total} component{counts.total === 1 ? "" : "s"} across {meta.unitCount} {unitLabel}
        </span>
        <ConnectionTag status={status} />
        {status === "connected" && (
          <Tag size="sm" type="gray" className="ec-tag" data-testid="bus-status">
            Bus connected
          </Tag>
        )}
        {fleet.lastUpdatedAt !== undefined && (
          <span className="ec-dim">
            updated {formatDurationMs(Math.max(0, now - fleet.lastUpdatedAt))} ago
          </span>
        )}
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
          subtitle="Showing last-known data; ages keep counting honestly until the stream resumes."
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
                {fatalError === undefined && " — retrying in the background"}. Fleet data will
                appear as soon as the stream is established.
              </p>
            </>
          )}
        </Tile>
      ) : (
        <>
          <SummaryTiles
            counts={counts}
            alarms={alarms.counts}
            status={status}
            {...(state.busMsgsPerSec !== undefined ? { busMsgsPerSec: state.busMsgsPerSec } : {})}
            {...(state.busRecentRates !== undefined ? { busRecentRates: state.busRecentRates } : {})}
            {...(state.self !== undefined ? { self: state.self } : {})}
            wsUrl={state.wsUrl}
            {...(fleet.lastUpdatedAt !== undefined ? { lastUpdatedAt: fleet.lastUpdatedAt } : {})}
            now={now}
            {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
          />
          <IssueNotifications
            alerts={alerts}
            containment={containment}
            {...(onOpenEvents !== undefined ? { onView: onOpenEvents } : {})}
            {...(onAck !== undefined ? { onAck } : {})}
          />
          {counts.devices === 0 ? (
            <Tile className="ec-empty" data-testid="empty-fleet">
              <h3>No components discovered yet</h3>
              <p className="ec-dim">
                The gateway is live but has not seen a UNS <code>state</code> keepalive on the
                site broker yet. Components appear here automatically within one keepalive
                interval of coming up (default 5 s).
              </p>
            </Tile>
          ) : (
            <>
              <h2 className="ec-sec">
                Fleet{" "}
                <span className="ec-dim ec-sec__hint">
                  grouped by {meta.levelNames.length > 0 ? meta.levelNames.join(", ") : "device"}
                </span>
              </h2>
              <div className="ec-fleet-tools">
                <span className="ec-fleet-tools__icon" aria-hidden="true">
                  🔍
                </span>
                <input
                  className="ec-fleet-tools__search"
                  type="text"
                  placeholder="Search fleet…"
                  aria-label="Search fleet"
                  value={query}
                  onChange={(e) => onSearchChange?.(e.target.value)}
                  data-testid="fleet-search"
                />
                {/* Group-by: reflects the DYNAMIC grouping level (line/area/device), not a hardcoded tier. */}
                <button
                  type="button"
                  className="ec-fleet-tools__btn"
                  data-testid="fleet-groupby"
                  title={`Grouped by ${meta.unit} (from the dynamic UNS hierarchy)`}
                  disabled
                >
                  {capitalize(meta.unit)} ▾
                </button>
                {/* Status filter (functional): keep only components at the chosen effective liveness. */}
                <select
                  className="ec-fleet-tools__btn ec-fleet-tools__select"
                  aria-label="Filter fleet by status"
                  data-testid="fleet-status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as Liveness | "all")}
                >
                  {STATUS_FILTERS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.value === "all" ? "Status ▾" : opt.label}
                    </option>
                  ))}
                </select>
                {/* Tiles view: placeholder — a card/tile fleet layout is not in R1 scope (labeled, inert). */}
                <button
                  type="button"
                  className="ec-fleet-tools__btn"
                  data-testid="fleet-view-tiles"
                  title="Tile view — coming in a later slice (the table is the R1 fleet view)"
                  disabled
                >
                  ⊞ Tiles
                </button>
              </div>
              {grouping.total === 0 ? (
                <Tile className="ec-empty" data-testid="empty-search">
                  <h3>No components match the current filter</h3>
                  <p className="ec-dim">
                    Clear the search{effectiveStatus !== undefined ? " and status filter" : ""} to see
                    the whole fleet. Search matches component name, device, and hierarchy (site /
                    line / …).
                  </p>
                </Tile>
              ) : (
                <FleetTable
                  grouping={grouping}
                  attributes={attributes}
                  nowServerMs={nowServerMs}
                  containedByDevice={containedByDevice}
                  platformByDevice={platformByDevice}
                  command={{ commands: state.commands, onInvoke }}
                />
              )}
            </>
          )}
        </>
      )}
      <CommandToasts commands={state.commands} />
    </div>
  );
}

/**
 * The live container: binds the view to a {@link FleetClient} + the 1 Hz tick. The
 * client's lifecycle is owned by the app shell (ONE shared connection across views —
 * unmounting this view on a nav switch must not drop the socket). The app-bar global
 * search is read from the shared {@link SearchContext}; `onOpenEvents` routes the Active
 * alerts tile / issue "View" to the Events & Alarms screen.
 */
export function ConnectedEdgeHealthView({
  client,
  onOpenEvents,
}: {
  client: FleetClient;
  onOpenEvents?: () => void;
}): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const { query, setQuery } = useSearch();
  return (
    <EdgeHealthView
      state={state}
      now={now}
      onInvoke={(key, verb, args) => client.invokeCommand(key, verb, args)}
      query={query}
      onSearchChange={setQuery}
      onAck={(alarmId) => client.ackAlarm(alarmId)}
      {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
    />
  );
}

/** Capitalize a level noun for the group-by control label ("line" → "Line"). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
