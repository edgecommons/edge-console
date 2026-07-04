/**
 * The Events & Alarms view (slice R4) — the mockup's "Events & Alerts" screen, now
 * with the REAL alarm State/Ack lifecycle beside the informational event feed.
 *
 * Two data sources, one chronological table (see `alarm-selectors.ts`):
 *  - ALARMS (stateful, ackable) from the R0 AlarmTracker `alarms` snapshot — each
 *    carries a lifecycle STATE (Active / Acked / Contained) and, while Active, an
 *    Ack action wired to the `ack-alarm` frame; the server re-pushes a fresh
 *    snapshot so the row flips to Acked without a refetch. Containment ("the road
 *    is down, not the houses") is reused from R0.
 *  - EVENTS (informational) from the EventStore — the NON-alarming `evt`s; the
 *    alarming ones are represented as their alarm (no double-listing).
 *
 * Layout follows the signed-off hi-fi: header with a live-tail chip, three summary
 * tiles (active-alarm rollup · events/min sparkline · noisiest source), the
 * component/severity filters, then the newest-first merged table — Severity / Time /
 * Source / Event / State / action, with a per-row expander for the full detail
 * (alarms: raise/ack audit; events: channel, timestamps, tags, pretty body). The
 * acked-by/at audit is CONSOLE-side state (this console's own Ack action).
 *
 * `EventsView` is purely presentational (state in, DOM out); `ConnectedEventsView`
 * binds it to the shared {@link FleetClient} and owns the subscribe lifecycle + the
 * console-side ack audit.
 */
import { useEffect, useState } from "react";
import {
  Button,
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
  Checkmark,
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
import { Sparkline } from "../common/Sparkline";
import type { EventFilters, SeverityFilter } from "./selectors";
import {
  eventsPerMinute,
  formatClockTime,
  noisiestSource,
  prettyBody,
  severityBucket,
} from "./selectors";
import type { AckAudit, FeedRow } from "./alarm-selectors";
import { FEED_STATE_LABEL, feedRows, feedSourceIds, filterFeed } from "./alarm-selectors";

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

/** A severity chip for a given bucket + display label. */
function SeverityChip({ bucket, label }: { bucket: SeverityFilter; label: string }): React.JSX.Element {
  const style = SEVERITY_STYLE[bucket];
  return (
    <Tag
      size="sm"
      type={style.tagType ?? "gray"}
      renderIcon={style.Icon}
      className={`ec-tag ${style.className ?? ""}`.trim()}
    >
      {label}
    </Tag>
  );
}

/** One event's severity chip (kept exported — the Component Detail embeds it). */
export function SeverityTag({ event }: { event: ConsoleEvent }): React.JSX.Element {
  const bucket = severityBucket(event);
  return <SeverityChip bucket={bucket} label={event.severity ?? SEVERITY_STYLE[bucket].label} />;
}

/** One feed row's severity chip (alarm or event — the raw token is the label when present). */
function FeedSeverityTag({ row }: { row: FeedRow }): React.JSX.Element {
  const raw = row.event?.severity ?? row.alarm?.severity;
  return <SeverityChip bucket={row.severity} label={raw ?? SEVERITY_STYLE[row.severity].label} />;
}

/** The State column: an alarm's lifecycle chip, or the informational event marker. */
function FeedStateCell({ row }: { row: FeedRow }): React.JSX.Element {
  if (row.kind === "event") {
    return <span className="ec-dim ec-feed-state">{FEED_STATE_LABEL.event}</span>;
  }
  if (row.state === "acked") {
    return (
      <Tag size="sm" type="green" renderIcon={Checkmark} className="ec-tag">
        {FEED_STATE_LABEL.acked}
      </Tag>
    );
  }
  if (row.state === "contained") {
    return (
      <Tag size="sm" type="gray" className="ec-tag ec-tag--unreach">
        {FEED_STATE_LABEL.contained}
      </Tag>
    );
  }
  return (
    <Tag size="sm" type="gray" className="ec-tag ec-feed-state--active">
      <span className="ec-feed-dot" aria-hidden="true" />
      {FEED_STATE_LABEL.active}
    </Tag>
  );
}

/** The expanded detail — an alarm's raise/ack audit, or an event's full envelope. */
function FeedDetail({ row, ackAudit }: { row: FeedRow; ackAudit: AckAudit }): React.JSX.Element {
  if (row.kind === "alarm" && row.alarm !== undefined) {
    const a = row.alarm;
    const audit = ackAudit[a.id];
    return (
      <>
        <div className="ec-evt-detail__meta">
          <span>
            alarm <span className="ec-mono">{a.id}</span>
          </span>
          <span>
            raised <span className="ec-mono">{formatClockTime(a.raisedAt)}</span>
          </span>
          <span>
            last raise <span className="ec-mono">{formatClockTime(a.lastAt)}</span>
          </span>
          <span>
            raises <span className="ec-mono">{a.count}</span>
          </span>
          {a.channel !== undefined && (
            <span>
              channel <span className="ec-mono">evt/{a.channel}</span>
            </span>
          )}
          {a.contained && <span className="ec-overdue">contained under an UNREACHABLE device</span>}
          {a.acked && (
            <span data-testid={`ack-audit-${a.id}`}>
              acked
              {audit !== undefined
                ? ` ${formatClockTime(audit.at)}${audit.by !== undefined ? ` by ${audit.by}` : ""}`
                : " (by another session)"}
            </span>
          )}
        </div>
        {a.message !== undefined && a.message !== "" && (
          <pre className="ec-json-pane">{a.message}</pre>
        )}
      </>
    );
  }
  const e = row.event;
  if (e === undefined) return <></>;
  return (
    <>
      <div className="ec-evt-detail__meta">
        <span>
          source <span className="ec-mono">{componentKeyId(e.key)}</span>
        </span>
        {e.channel !== undefined && (
          <span>
            channel <span className="ec-mono">evt/{e.channel}</span>
          </span>
        )}
        {e.sourceTimestamp !== undefined && (
          <span>
            publisher timestamp <span className="ec-mono">{e.sourceTimestamp}</span>
          </span>
        )}
        {e.tags !== undefined && Object.keys(e.tags).length > 0 && (
          <span>
            tags <span className="ec-mono">{JSON.stringify(e.tags)}</span>
          </span>
        )}
      </div>
      <pre className="ec-json-pane">{prettyBody(e.body)}</pre>
    </>
  );
}

const COLUMNS = ["Severity", "Time", "Source", "Event", "State", ""] as const;

/** All-items sentinel for the two filter dropdowns. */
const ALL = "__all__";

function FeedRowView({
  row,
  nowServerMs,
  expanded,
  ackAudit,
  onToggle,
  onAck,
}: {
  row: FeedRow;
  nowServerMs: number;
  expanded: boolean;
  ackAudit: AckAudit;
  onToggle: (id: string) => void;
  onAck: (alarmId: string) => void;
}): React.JSX.Element {
  return (
    <>
      <TableRow data-testid={`feed-row-${row.id}`} className={row.kind === "alarm" ? "ec-feed-row--alarm" : undefined}>
        <TableCell>
          <FeedSeverityTag row={row} />
        </TableCell>
        <TableCell>
          <span className="ec-mono ec-tnum">{formatClockTime(row.at)}</span>{" "}
          <span className="ec-dim ec-tnum ec-evt-age">
            {formatDurationMs(Math.max(0, nowServerMs - row.at))} ago
          </span>
        </TableCell>
        <TableCell>
          <span className="ec-pri">{row.key.component}</span>
          {row.instance !== undefined && row.instance !== "main" && (
            <Tag size="sm" type="outline" className="ec-instance">
              {row.instance}
            </Tag>
          )}
          <span className="ec-dim ec-mono ec-evt-device">{row.key.device}</span>
        </TableCell>
        <TableCell>
          <span className="ec-pri">{row.title}</span>
          {row.kind === "alarm" && row.count !== undefined && row.count > 1 && (
            <Tag size="sm" type="gray" className="ec-tag ec-feed-count">
              ×{row.count}
            </Tag>
          )}
          <span className="ec-dim ec-evt-summary">{row.summary}</span>
        </TableCell>
        <TableCell>
          <FeedStateCell row={row} />
        </TableCell>
        <TableCell className="ec-feed-actioncell">
          {row.ackable && row.alarm !== undefined && (
            <Button
              kind="ghost"
              size="sm"
              data-testid={`ack-${row.alarm.id}`}
              onClick={() => onAck(row.alarm!.id)}
            >
              Ack
            </Button>
          )}
          <button
            type="button"
            className="ec-evt-expand"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${row.id} detail`}
            data-testid={`feed-expand-${row.id}`}
            onClick={() => onToggle(row.id)}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="ec-evt-detail" data-testid={`feed-detail-${row.id}`}>
          <TableCell colSpan={COLUMNS.length}>
            <FeedDetail row={row} ackAudit={ackAudit} />
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
  /** Acknowledge an active alarm (fires the `ack-alarm` frame). */
  onAck: (alarmId: string) => void;
  /** Console-side ack audit (who/when this console acked) — display only. */
  ackAudit: AckAudit;
}

export function EventsView({
  state,
  now,
  filters,
  onFiltersChange,
  onAck,
  ackAudit,
}: EventsViewProps): React.JSX.Element {
  const { events, alarms, status, fatalError } = state;
  const nowServerMs = now - state.fleet.clockOffsetMs;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = feedRows(alarms.active, events.entries);
  const filtered = filterFeed(rows, filters);
  const sources = feedSourceIds(rows);
  const counts = alarms.counts;
  const noisiest = noisiestSource(events.entries, nowServerMs);
  const perMinute = eventsPerMinute(events.entries, nowServerMs);

  const live = status === "connected";

  return (
    <div className="ec-events">
      <h1 className="ec-ph">Events &amp; Alarms</h1>
      <div className="ec-ph-sub">
        <span>
          Console alarms (stateful, ackable) and the informational component{" "}
          <code>evt</code> feed — newest first.
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
      {fatalError === undefined && rows.length > 0 && !live && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Gateway connection lost — reconnecting"
          subtitle="Showing the last-received alarms and events; the stream resumes automatically."
        />
      )}

      {rows.length === 0 ? (
        <Tile className="ec-empty" data-testid="events-empty">
          {fatalError === undefined && (status === "connecting" || status === "reconnecting") ? (
            <InlineLoading description="Connecting to the console gateway…" />
          ) : (
            <>
              <h3>No events or alarms yet</h3>
              <p className="ec-dim">
                Alarms are raised from alarming-severity <code>evt</code>s (critical / error /
                warning) and cleared by a normal-severity follow-up; the feed also carries the
                informational <code>evt</code>s. Nothing is polled — rows land the moment a
                component publishes.
              </p>
            </>
          )}
        </Tile>
      ) : (
        <>
          <div className="ec-tiles ec-tiles--3">
            <Tile className="ec-tile">
              <div className="ec-tile__label">Active alarms</div>
              <div className="ec-tile__num" data-testid="active-alarm-count">
                {counts.active}
              </div>
              <div className="ec-tile__foot">
                {counts.critical} crit · {counts.warning} warn
                {counts.contained > 0 ? ` · +${counts.contained} contained` : ""}
                {counts.acked > 0 ? ` · ${counts.acked} acked` : ""}
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
            {filtered.length !== rows.length && (
              <span className="ec-dim ec-filters__count" data-testid="filter-count">
                {filtered.length} of {rows.length} rows
              </span>
            )}
          </div>

          {filtered.length === 0 ? (
            <Tile className="ec-empty" data-testid="events-filtered-empty">
              <h3>No rows match the filters</h3>
              <p className="ec-dim">Widen the component or severity filter to see the rest.</p>
            </Tile>
          ) : (
            <TableContainer className="ec-fleet">
              <div className="ec-tablewrap">
                <Table size="lg" aria-label="Alarms and events, newest first">
                  <TableHead>
                    <TableRow>
                      {COLUMNS.map((col, i) => (
                        <TableHeader key={i}>{col}</TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody data-testid="events-table">
                    {filtered.map((row) => (
                      <FeedRowView
                        key={row.id}
                        row={row}
                        nowServerMs={nowServerMs}
                        expanded={expandedIds.has(row.id)}
                        ackAudit={ackAudit}
                        onToggle={toggle}
                        onAck={onAck}
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
 * The live container: subscribes the event stream while mounted (the alarm surface is
 * subscribed globally by the app shell — the notifications badge is fleet-wide). The
 * subscribe effect keys on the connection status (the whole reconnect story — a fresh
 * backlog on re-subscribe self-heals the log). Ack fires the `ack-alarm` frame AND
 * records the console-side who/when audit (this console's own action).
 */
export function ConnectedEventsView({ client }: { client: FleetClient }): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const [filters, setFilters] = useState<EventFilters>({});
  const [ackAudit, setAckAudit] = useState<AckAudit>({});
  const status = state.status;
  const role = state.role;

  useEffect(() => {
    if (status === "connected") client.subscribeEvents();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeEvents(), [client]);

  const onAck = (alarmId: string) => {
    client.ackAlarm(alarmId);
    setAckAudit((prev) => ({
      ...prev,
      [alarmId]: { at: Date.now(), ...(role !== undefined ? { by: role } : {}) },
    }));
  };

  return (
    <EventsView
      state={state}
      now={now}
      filters={filters}
      onFiltersChange={setFilters}
      onAck={onAck}
      ackAudit={ackAudit}
    />
  );
}
