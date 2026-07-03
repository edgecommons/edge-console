/**
 * The Events view (slice C6) — the mockup's "Events & alerts" screen scoped to what
 * exists today: the live component `evt` feed (the console-alert and operator-audit
 * rows land with C4's CommandGateway; raise/clear alarm STATE lands with the
 * deferred `events()` facade, so no Ack/State columns ship yet — no dead UI).
 *
 * Layout follows the signed-off hi-fi: page header with a live-tail chip, the
 * three summary tiles (recent count + severity legend · events/min sparkline ·
 * noisiest source), then the newest-first log — severity chip, wall-clock time +
 * age, source identity, event name + body summary, and a per-row expander with the
 * full detail (channel, timestamps, tags, pretty-printed body). Rows LIVE-APPEND
 * as `event` frames fold into the store; filtering by component and/or severity
 * is client-side over the rolling history.
 *
 * `EventsView` is purely presentational (state in, DOM out);
 * `ConnectedEventsView` binds it to the shared {@link FleetClient} and owns the
 * subscribe-on-connect / unsubscribe-on-unmount lifecycle.
 */
import { useEffect, useState } from "react";
import {
  Dropdown,
  InlineLoading,
  InlineNotification,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
} from "@carbon/react";
import {
  ChevronDown,
  ChevronRight,
  CircleFilled,
  ErrorFilled,
  InformationFilled,
  WarningAltFilled,
  WarningFilled,
} from "@carbon/react/icons";
import type { ConsoleEvent } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import { formatDurationMs } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { Sparkline } from "../metrics/Sparkline";
import type { EventFilters, SeverityFilter } from "./selectors";
import {
  eventSourceIds,
  eventsPerMinute,
  filterEvents,
  formatClockTime,
  noisiestSource,
  prettyBody,
  severityBucket,
  severityCounts,
  summarizeBody,
} from "./selectors";

/** Severity bucket -> Carbon tag treatment (status colors are semantic, never decorative). */
const SEVERITY_STYLE: Record<
  SeverityFilter,
  { label: string; tagType?: "red" | "magenta" | "blue" | "cool-gray" | "outline"; className?: string; Icon: React.ElementType }
> = {
  critical: { label: "Critical", tagType: "red", Icon: ErrorFilled },
  error: { label: "Error", tagType: "magenta", Icon: WarningFilled },
  warning: { label: "Warning", className: "ec-tag--warn", Icon: WarningAltFilled },
  info: { label: "Info", tagType: "blue", Icon: InformationFilled },
  debug: { label: "Debug", tagType: "cool-gray", Icon: CircleFilled },
  other: { label: "Event", tagType: "outline", Icon: CircleFilled },
};

/** One event's severity chip: bucket colors, RAW token as the label when present. */
export function SeverityTag({ event }: { event: ConsoleEvent }): React.JSX.Element {
  const bucket = severityBucket(event);
  const style = SEVERITY_STYLE[bucket];
  return (
    <Tag
      size="sm"
      type={style.tagType ?? "gray"}
      renderIcon={style.Icon}
      className={`ec-tag ${style.className ?? ""}`.trim()}
    >
      {event.severity ?? style.label}
    </Tag>
  );
}

const COLUMNS = ["Severity", "Time", "Source", "Event", ""] as const;

/** All-items sentinel for the two filter dropdowns. */
const ALL = "__all__";

function EventRow({
  event,
  nowServerMs,
  expanded,
  onToggle,
}: {
  event: ConsoleEvent;
  nowServerMs: number;
  expanded: boolean;
  onToggle: (id: number) => void;
}): React.JSX.Element {
  return (
    <>
      <TableRow data-testid={`event-row-${event.id}`}>
        <TableCell>
          <SeverityTag event={event} />
        </TableCell>
        <TableCell>
          <span className="ec-mono ec-tnum">{formatClockTime(event.receivedAt)}</span>{" "}
          <span className="ec-dim ec-tnum ec-evt-age">
            {formatDurationMs(Math.max(0, nowServerMs - event.receivedAt))} ago
          </span>
        </TableCell>
        <TableCell>
          <span className="ec-pri">{event.key.component}</span>
          {event.key.instance !== "main" && (
            <Tag size="sm" type="outline" className="ec-instance">
              {event.key.instance}
            </Tag>
          )}
          <span className="ec-dim ec-mono ec-evt-device">{event.key.device}</span>
        </TableCell>
        <TableCell>
          <span className="ec-pri">{event.type}</span>
          <span className="ec-dim ec-evt-summary">{summarizeBody(event.body)}</span>
        </TableCell>
        <TableCell className="ec-evt-expandcell">
          <button
            type="button"
            className="ec-evt-expand"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} event ${event.id} detail`}
            data-testid={`event-expand-${event.id}`}
            onClick={() => onToggle(event.id)}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="ec-evt-detail" data-testid={`event-detail-${event.id}`}>
          <TableCell colSpan={COLUMNS.length}>
            <div className="ec-evt-detail__meta">
              <span>
                source <span className="ec-mono">{componentKeyId(event.key)}</span>
              </span>
              {event.channel !== undefined && (
                <span>
                  channel <span className="ec-mono">evt/{event.channel}</span>
                </span>
              )}
              {event.sourceTimestamp !== undefined && (
                <span>
                  publisher timestamp <span className="ec-mono">{event.sourceTimestamp}</span>
                </span>
              )}
              {event.tags !== undefined && Object.keys(event.tags).length > 0 && (
                <span>
                  tags <span className="ec-mono">{JSON.stringify(event.tags)}</span>
                </span>
              )}
            </div>
            <pre className="ec-json-pane">{prettyBody(event.body)}</pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export interface EventsViewProps {
  state: ClientState;
  /** Client-clock ms (the 1 Hz tick) — drives the ticking age cells. */
  now: number;
  filters: EventFilters;
  onFiltersChange: (filters: EventFilters) => void;
}

export function EventsView({
  state,
  now,
  filters,
  onFiltersChange,
}: EventsViewProps): React.JSX.Element {
  const { events, status, fatalError } = state;
  const nowServerMs = now - state.fleet.clockOffsetMs;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(new Set());
  const toggle = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const entries = events.entries;
  const filtered = filterEvents(entries, filters);
  const counts = severityCounts(entries);
  const noisiest = noisiestSource(entries, nowServerMs);
  const perMinute = eventsPerMinute(entries, nowServerMs);
  const sources = eventSourceIds(entries);

  const live = status === "connected";

  return (
    <div className="ec-events">
      <h1 className="ec-ph">Events</h1>
      <div className="ec-ph-sub">
        <span>
          Component events — the UNS <code>evt</code> class, rolling recent history,
          newest first.
        </span>
        <Tag
          size="sm"
          type={live ? "green" : "gray"}
          renderIcon={CircleFilled}
          className="ec-tag"
          data-testid="live-tail"
        >
          {live ? "Live tail" : "Tail paused"}
        </Tag>
      </div>

      {fatalError !== undefined && (
        <InlineNotification
          kind="error"
          hideCloseButton
          title="Protocol version mismatch"
          subtitle={`${fatalError} — reload the page to pick up the current console UI.`}
        />
      )}
      {fatalError === undefined && entries.length > 0 && !live && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Gateway connection lost — reconnecting"
          subtitle="Showing the last-received events; the stream resumes automatically."
        />
      )}

      {entries.length === 0 ? (
        <Tile className="ec-empty" data-testid="events-empty">
          {fatalError === undefined && (status === "connecting" || status === "reconnecting") ? (
            <InlineLoading description="Connecting to the console gateway…" />
          ) : (
            <>
              <h3>No events yet</h3>
              <p className="ec-dim">
                Events appear here the moment any component publishes on its{" "}
                <code>evt</code> class (<span className="ec-mono">evt/{"{severity}"}/{"{type}"}</span>).
                The console keeps a rolling recent history — nothing is polled.
              </p>
            </>
          )}
        </Tile>
      ) : (
        <>
          <div className="ec-tiles ec-tiles--3">
            <Tile className="ec-tile">
              <div className="ec-tile__label">Recent events</div>
              <div className="ec-tile__num">{entries.length}</div>
              <div className="ec-legend">
                {(["critical", "error", "warning", "info"] as const).map(
                  (bucket) =>
                    counts[bucket] > 0 && (
                      <Tag
                        key={bucket}
                        size="sm"
                        type={SEVERITY_STYLE[bucket].tagType ?? "gray"}
                        className={`ec-tag ${SEVERITY_STYLE[bucket].className ?? ""}`.trim()}
                      >
                        {counts[bucket]} {bucket}
                      </Tag>
                    ),
                )}
              </div>
            </Tile>
            <Tile className="ec-tile">
              <div className="ec-tile__label">Events / min</div>
              <Sparkline
                points={perMinute}
                width={220}
                height={40}
                ariaLabel="events per minute"
              />
            </Tile>
            <Tile className="ec-tile">
              <div className="ec-tile__label">Noisiest source · 5 min</div>
              {noisiest !== undefined ? (
                <>
                  <div className="ec-tile__num ec-tile__num--md">
                    {noisiest.componentId.split("/")[1]}
                  </div>
                  <div className="ec-tile__foot">
                    <span className="ec-mono">{noisiest.componentId}</span> ·{" "}
                    {noisiest.count} event{noisiest.count === 1 ? "" : "s"}
                  </div>
                </>
              ) : (
                <div className="ec-tile__num ec-tile__num--md ec-dim">—</div>
              )}
            </Tile>
          </div>

          <div className="ec-filters">
            <Dropdown
              id="event-component-filter"
              size="sm"
              titleText="Component"
              label="All components"
              items={[ALL, ...sources]}
              itemToString={(item) => (item === ALL ? "All components" : (item ?? ""))}
              selectedItem={filters.componentId ?? ALL}
              onChange={({ selectedItem }) =>
                onFiltersChange({
                  ...filters,
                  ...(selectedItem === ALL || selectedItem === null
                    ? { componentId: undefined }
                    : { componentId: selectedItem }),
                })
              }
            />
            <Dropdown
              id="event-severity-filter"
              size="sm"
              titleText="Severity"
              label="All severities"
              items={[ALL, "critical", "error", "warning", "info", "debug", "other"]}
              itemToString={(item) =>
                item === ALL ? "All severities" : (SEVERITY_STYLE[item as SeverityFilter]?.label ?? "")
              }
              selectedItem={filters.severity ?? ALL}
              onChange={({ selectedItem }) =>
                onFiltersChange({
                  ...filters,
                  ...(selectedItem === ALL || selectedItem === null
                    ? { severity: undefined }
                    : { severity: selectedItem as SeverityFilter }),
                })
              }
            />
            {filtered.length !== entries.length && (
              <span className="ec-dim ec-filters__count" data-testid="filter-count">
                {filtered.length} of {entries.length} events
              </span>
            )}
          </div>

          {filtered.length === 0 ? (
            <Tile className="ec-empty" data-testid="events-filtered-empty">
              <h3>No events match the filters</h3>
              <p className="ec-dim">Widen the component or severity filter to see the rest of the history.</p>
            </Tile>
          ) : (
            <TableContainer className="ec-fleet">
              <div className="ec-tablewrap">
                <Table size="lg" aria-label="Recent component events, newest first">
                  <TableHead>
                    <TableRow>
                      {COLUMNS.map((col, i) => (
                        <TableHeader key={i}>{col}</TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody data-testid="events-table">
                    {filtered.map((event) => (
                      <EventRow
                        key={event.id}
                        event={event}
                        nowServerMs={nowServerMs}
                        expanded={expandedIds.has(event.id)}
                        onToggle={toggle}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TableContainer>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The live container: subscribes the event stream while mounted. Server-side
 * interest dies with the connection, so the subscribe effect keys on the
 * connection status — that is the whole reconnect story (the fresh backlog on
 * re-subscribe self-heals the log). Unmounting unsubscribes (the shared socket
 * stays up for the other views).
 */
export function ConnectedEventsView({ client }: { client: FleetClient }): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const [filters, setFilters] = useState<EventFilters>({});
  const status = state.status;

  useEffect(() => {
    if (status === "connected") client.subscribeEvents();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeEvents(), [client]);

  return <EventsView state={state} now={now} filters={filters} onFiltersChange={setFilters} />;
}
