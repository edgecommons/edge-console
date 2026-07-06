/**
 * The Signals view (slice R5) — the mockup's "Signals" screen: the DATA-plane browser
 * over the UNS `data` class (telemetry / business signals on `data/{signal}`). A
 * filterable table of every `(component, signal)` series the console has seen, each row
 * showing the latest value, its data quality, a trend sparkline, and how long ago it
 * last updated — live, as `signal` frames arrive.
 *
 * Faithful to the signed-off hi-fi (Signal / Latest / Quality / Age + a per-row Read
 * action), enriched with a Trend sparkline column from the bounded recent series the
 * SignalStore carries (hand-rolled SVG, the shared {@link Sparkline}). The app-bar search
 * filters the rows (signal / component); a component-scope dropdown (and a Component-Detail
 * deep-link) narrows to one component.
 *
 * HONEST about what the wire carries: the `data()` facade publishes `{value, quality}` (its
 * GOOD default is real), so value + quality + trend + age are all live. Engineering UNITS, a
 * friendly display NAME, and alarm LIMITS are NOT on the `data` body (they would come from
 * the signal body or a `describe` the console does not consume yet) — the view says so rather
 * than inventing them. The "Read" on-demand southbound re-read rides the same C4 command
 * surface as the Component Detail actions (honest result via the toast feed).
 *
 * `SignalsView` is purely presentational (state in, DOM out); `ConnectedSignalsView` binds it
 * to the shared {@link FleetClient} and owns the subscribe lifecycle + the search/scope wiring.
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
  CircleFilled,
  ErrorFilled,
  WarningAltFilled,
} from "@carbon/react/icons";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import { formatUptimeShort } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { useSearch } from "../shell/search";
import { Sparkline } from "../common/Sparkline";
import { CommandToasts } from "../health/CommandToasts";
import type { QualityBucket, SignalRow } from "./selectors";
import { filterSignalRows, signalComponentIds, signalRows } from "./selectors";

/** Quality bucket -> Carbon tag treatment (status colors are semantic, never decorative). */
const QUALITY_STYLE: Record<
  Exclude<QualityBucket, "none">,
  { label: string; tagType?: "green" | "red" | "cool-gray"; className?: string; Icon: React.ElementType }
> = {
  good: { label: "GOOD", tagType: "green", Icon: Checkmark },
  uncertain: { label: "UNCERTAIN", className: "ec-tag--warn", Icon: WarningAltFilled },
  bad: { label: "BAD", tagType: "red", Icon: ErrorFilled },
  other: { label: "—", tagType: "cool-gray", Icon: CircleFilled },
};

/** One signal's quality chip; `none` (no token on the wire) renders an honest em dash. */
function QualityCell({ row }: { row: SignalRow }): React.JSX.Element {
  if (row.qualityBucket === "none") {
    return (
      <span className="ec-dim" title="no quality token on the data body" data-testid="quality-none">
        —
      </span>
    );
  }
  const style = QUALITY_STYLE[row.qualityBucket];
  // The raw token is the label when present (so a non-canonical token shows verbatim).
  const label = row.quality ?? style.label;
  return (
    <Tag
      size="sm"
      type={style.tagType ?? "gray"}
      renderIcon={style.Icon}
      className={`ec-tag ${style.className ?? ""}`.trim()}
      data-testid={`quality-${row.qualityBucket}`}
    >
      {label}
    </Tag>
  );
}

const COLUMNS = ["Signal", "Latest", "Quality", "Trend", "Age", ""] as const;

/** All-components sentinel for the scope dropdown. */
const ALL = "__all__";

function SignalRowView({
  row,
  nowServerMs,
  onRead,
}: {
  row: SignalRow;
  nowServerMs: number;
  onRead: (key: ComponentKey, signal: string) => void;
}): React.JSX.Element {
  const ageMs = Math.max(0, nowServerMs - row.receivedAt);
  return (
    <TableRow data-testid={`signal-row-${row.id}`}>
      <TableCell>
        <span className="ec-pri">
          {row.device} / {row.signal}
        </span>
        {row.instance !== "main" && (
          <Tag size="sm" type="outline" className="ec-instance">
            {row.instance}
          </Tag>
        )}
        <span className="ec-dim ec-mono ec-signal-owner">{row.component}</span>
      </TableCell>
      <TableCell className="ec-signal-latest">
        {row.value !== undefined ? (
          <span className="ec-tnum">{row.value}</span>
        ) : (
          <span className="ec-dim" title="no displayable value on the latest sample">
            —
          </span>
        )}
      </TableCell>
      <TableCell>
        <QualityCell row={row} />
      </TableCell>
      <TableCell className="ec-signal-trend">
        {row.series.length > 0 ? (
          <Sparkline
            points={row.series}
            width={120}
            height={28}
            ariaLabel={`${row.signal} trend`}
          />
        ) : (
          <span className="ec-dim" title="no numeric samples to plot">
            —
          </span>
        )}
      </TableCell>
      <TableCell>
        <span className="ec-mono ec-tnum ec-dim" data-testid={`signal-age-${row.id}`}>
          {formatUptimeShort(ageMs / 1000)}
        </span>
      </TableCell>
      <TableCell className="ec-signal-actioncell">
        <Button
          kind="ghost"
          size="sm"
          data-testid={`signal-read-${row.id}`}
          onClick={() => onRead(row.key, row.signal)}
        >
          Read
        </Button>
      </TableCell>
    </TableRow>
  );
}

function SignalCardView({
  row,
  nowServerMs,
  onRead,
}: {
  row: SignalRow;
  nowServerMs: number;
  onRead: (key: ComponentKey, signal: string) => void;
}): React.JSX.Element {
  const ageMs = Math.max(0, nowServerMs - row.receivedAt);
  return (
    <article className="ec-card ec-signal-card" data-testid={`signal-card-${row.id}`}>
      <div className="ec-card__head">
        <div className="ec-card__title">
          <span className="ec-pri">
            {row.device} / {row.signal}
          </span>
          <span className="ec-dim ec-mono">
            {row.component}
            {row.instance !== "main" ? ` · ${row.instance}` : ""}
          </span>
        </div>
        <QualityCell row={row} />
      </div>
      <dl className="ec-card__metrics">
        <div className="ec-kv">
          <dt>Latest</dt>
          <dd className="ec-signal-latest">
            {row.value !== undefined ? (
              <span className="ec-tnum">{row.value}</span>
            ) : (
              <span className="ec-dim" title="no displayable value on the latest sample">
                —
              </span>
            )}
          </dd>
        </div>
        <div className="ec-kv">
          <dt>Age</dt>
          <dd>
            <span className="ec-mono ec-tnum ec-dim" data-testid={`signal-card-age-${row.id}`}>
              {formatUptimeShort(ageMs / 1000)}
            </span>
          </dd>
        </div>
        <div className="ec-kv ec-kv--wide">
          <dt>Trend</dt>
          <dd className="ec-signal-trend">
            {row.series.length > 0 ? (
              <Sparkline
                points={row.series}
                width={180}
                height={36}
                ariaLabel={`${row.signal} trend`}
              />
            ) : (
              <span className="ec-dim" title="no numeric samples to plot">
                —
              </span>
            )}
          </dd>
        </div>
      </dl>
      <div className="ec-card__actions">
        <Button
          kind="ghost"
          size="sm"
          data-testid={`signal-card-read-${row.id}`}
          onClick={() => onRead(row.key, row.signal)}
        >
          Read
        </Button>
      </div>
    </article>
  );
}

export interface SignalsViewProps {
  state: ClientState;
  /** Client-clock ms (the 1 Hz tick) — drives the ticking Age cells. */
  now: number;
  /** The app-bar search query (filters signal / component). */
  query: string;
  /** The active component scope (canonical id), or undefined for the whole fleet. */
  componentScope?: string;
  onComponentScopeChange: (componentId: string | undefined) => void;
  /** On-demand southbound re-read of one signal (fires the C4 `sb.read` command). */
  onRead: (key: ComponentKey, signal: string) => void;
}

export function SignalsView({
  state,
  now,
  query,
  componentScope,
  onComponentScopeChange,
  onRead,
}: SignalsViewProps): React.JSX.Element {
  const { signals, status, fatalError } = state;
  const nowServerMs = now - state.fleet.clockOffsetMs;

  const rows = signalRows(signals.series);
  const scopes = signalComponentIds(rows);
  const filtered = filterSignalRows(rows, {
    ...(query.trim() !== "" ? { query } : {}),
    ...(componentScope !== undefined ? { componentId: componentScope } : {}),
  });

  const live = status === "connected";

  return (
    <div className="ec-signals">
      <h1 className="ec-ph">Signals</h1>
      <div className="ec-ph-sub">
        <span>
          Data-plane browser — the UNS <code>data</code> class ({" "}
          <code>data/&#123;signal&#125;</code>): latest value, quality, and trend per signal.
        </span>
        <Tag
          size="sm"
          type={live ? "green" : "gray"}
          renderIcon={CircleFilled}
          className="ec-tag"
          data-testid="signals-live"
        >
          {live ? "Live" : "Paused"}
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
          subtitle="Showing the last-received signals; the stream resumes automatically."
        />
      )}

      {rows.length === 0 ? (
        <Tile className="ec-empty" data-testid="signals-empty">
          {fatalError === undefined && (status === "connecting" || status === "reconnecting") ? (
            <InlineLoading description="Connecting to the console gateway…" />
          ) : (
            <>
              <h3>No signals yet</h3>
              <p className="ec-dim">
                Signals land the moment a component publishes on its <code>data</code> class
                (<code>data/&#123;signal&#125;</code>) — the adapters&apos; southbound readings and
                the processors&apos; derived values. Nothing is polled.
              </p>
            </>
          )}
        </Tile>
      ) : (
        <>
          <div className="ec-filters">
            <Dropdown
              id="signal-component-scope"
              size="sm"
              titleText="Component"
              label="All components"
              items={[ALL, ...scopes]}
              itemToString={(item) => (item === ALL ? "All components" : (item ?? ""))}
              selectedItem={componentScope ?? ALL}
              onChange={({ selectedItem }) =>
                onComponentScopeChange(
                  selectedItem === ALL || selectedItem === null ? undefined : selectedItem,
                )
              }
            />
            {filtered.length !== rows.length && (
              <span className="ec-dim ec-filters__count" data-testid="signal-filter-count">
                {filtered.length} of {rows.length} signals
              </span>
            )}
            <span className="ec-dim ec-filters__count ec-signals__pending" data-testid="signals-pending-note">
              units · display name · limits pending (needs <code>describe</code>)
            </span>
          </div>

          {filtered.length === 0 ? (
            <Tile className="ec-empty" data-testid="signals-filtered-empty">
              <h3>No signals match</h3>
              <p className="ec-dim">Clear the search or widen the component scope to see the rest.</p>
            </Tile>
          ) : (
            <TableContainer className="ec-fleet">
              <div className="ec-tablewrap ec-signals-tablewrap">
                <Table size="lg" aria-label="Signals, by component">
                  <TableHead>
                    <TableRow>
                      {COLUMNS.map((col, i) => (
                        <TableHeader key={i}>{col}</TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody data-testid="signals-table">
                    {filtered.map((row) => (
                      <SignalRowView
                        key={row.id}
                        row={row}
                        nowServerMs={nowServerMs}
                        onRead={onRead}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="ec-tablecards" data-testid="signals-card-list">
                {filtered.map((row) => (
                  <SignalCardView
                    key={row.id}
                    row={row}
                    nowServerMs={nowServerMs}
                    onRead={onRead}
                  />
                ))}
              </div>
            </TableContainer>
          )}
        </>
      )}
      <CommandToasts commands={state.commands} />
    </div>
  );
}

/**
 * The live container: subscribes the signal stream while mounted (the C5/C6 interest
 * pattern — the subscribe effect keys on the connection status, so a fresh snapshot on
 * re-subscribe self-heals after a reconnect); unsubscribes on unmount. The app-bar search
 * drives the free-text filter; the component scope is local state, seeded from an optional
 * deep-link (`initialComponentId`, set when the Component Detail links here for one
 * component) and re-seeded whenever that link target changes. "Read" fires the on-demand
 * `sb.read` command for the row's signal (honest result via the toast feed).
 */
export function ConnectedSignalsView({
  client,
  initialComponentId,
}: {
  client: FleetClient;
  initialComponentId?: string;
}): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const { query } = useSearch();
  const [componentScope, setComponentScope] = useState<string | undefined>(initialComponentId);
  const status = state.status;

  useEffect(() => {
    if (status === "connected") client.subscribeSignals();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeSignals(), [client]);

  // Re-seed the scope whenever the deep-link target changes (a new Component-Detail link,
  // or a plain nav that clears it) — mount-only initial state would go stale otherwise.
  useEffect(() => {
    setComponentScope(initialComponentId);
  }, [initialComponentId]);

  const onRead = (key: ComponentKey, signal: string) =>
    client.invokeCommand(key, "sb.read", { signal });

  return (
    <SignalsView
      state={state}
      now={now}
      query={query}
      {...(componentScope !== undefined ? { componentScope } : {})}
      onComponentScopeChange={setComponentScope}
      onRead={onRead}
    />
  );
}

/** Canonical component id from a key (deep-link helper for the app shell). */
export function scopeIdFor(key: ComponentKey): string {
  return componentKeyId(key);
}
