/**
 * The Signals view (R5 — the rev-4 mockup) — the DATA-plane browser over the UNS `data`
 * class (telemetry / business signals on `data/{signal}`). Every signal the console has seen,
 * grouped by its signal path so a plant of hundreds reads as a handful of sticky headers; each
 * row is name-led (canonical `signal.name`, mono channel fallback) with the latest value, its
 * data quality (with the native `qualityRaw` on hover), a trend sparkline, and its receipt
 * freshness over a publish-lag line. A row expands to identity, the protocol-native address,
 * the labeled timestamps + lag, a larger trend with min/max/avg/Δ, and a link to Component
 * Detail (where commanding lives — this observation surface carries no write action).
 *
 * Scale answers: groups load collapsed past five signals; each expanded group renders a bounded
 * page (first 50 rows, +200 per "Show more") so the DOM stays small; collapsed headers still
 * bubble up bad/uncertain pills (hover names the worst offender), the group's msg/s (a 10 s
 * sliding window over live updates), and its freshest update. When the gateway advertises the
 * `signalsSummary` capability the screen subscribes in summary mode (series + latest, no points)
 * and backfills points on demand as groups/rows expand; otherwise it falls back to a full
 * subscribe. Live `signal` frames stream points regardless, so anything on screen self-fills.
 *
 * HONEST about what the wire carries: units and alarm limits are NOT on the `data` body (they
 * would come from a `describe` the console does not consume yet) — the view marks them pending
 * rather than inventing them.
 *
 * `SignalsView` is purely presentational (state in, DOM out); `ConnectedSignalsView` binds it to
 * the shared {@link FleetClient} and owns the subscribe lifecycle, the device→component cascade,
 * the summary/points-fetch capability gating, and the msg/s meter.
 */
import { useEffect, useRef, useState } from "react";
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
import { Checkmark, CircleFilled, ErrorFilled, WarningAltFilled } from "@carbon/react/icons";
import type { ComponentKey, SignalPointSelector } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import { formatUptimeShort } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { useSearch } from "../shell/search";
import { Sparkline } from "../common/Sparkline";
import type { QualityBucket, QualityCounts, SignalGroup, SignalGroupBy, SignalRow } from "./selectors";
import {
  LAG_WARN_MS,
  SignalRateMeter,
  cascadeComponentScope,
  componentDeviceOf,
  filterSignalRows,
  groupSignals,
  pointSelector,
  qualityCounts,
  signalComponentOptions,
  signalDevices,
  signalRows,
  signalStats,
} from "./selectors";

/** All-devices / all-components sentinel for the scope dropdowns. */
const ALL = "__all__";
/** First-page size + the "Show more" step (keeps the DOM bounded without a virtualization dep). */
const PAGE_SIZE = 50;
const PAGE_STEP = 200;

/** The Group-by dropdown options (label ↔ axis). */
const GROUP_BY_OPTIONS: { id: SignalGroupBy; label: string }[] = [
  { id: "path", label: "Signal path" },
  { id: "component", label: "Component" },
  { id: "source", label: "Source" },
  { id: "none", label: "None" },
];
const GROUP_BY_LABEL: Record<SignalGroupBy, string> = {
  path: "Signal path",
  component: "Component",
  source: "Source",
  none: "None",
};

const COLUMNS = ["Signal", "Latest", "Quality", "Trend", "Updated"] as const;
const COLSPAN = COLUMNS.length;

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
function QualityChip({ row }: { row: SignalRow }): React.JSX.Element {
  if (row.qualityBucket === "none") {
    return (
      <span className="ec-dim" title="no quality token on the data body" data-testid="quality-none">
        —
      </span>
    );
  }
  const style = QUALITY_STYLE[row.qualityBucket];
  const label = row.quality ?? style.label;
  return (
    <Tag
      size="sm"
      type={style.tagType ?? "gray"}
      renderIcon={style.Icon}
      className={`ec-tag ${style.className ?? ""}`.trim()}
      data-testid={`quality-${row.qualityBucket}`}
      {...(row.qualityRaw !== undefined ? { title: `raw: ${row.qualityRaw}` } : {})}
    >
      {label}
    </Tag>
  );
}

/** The latest-value cell (typography keyed on value kind; value-less renders an em dash). */
function LatestValue({ row }: { row: SignalRow }): React.JSX.Element {
  if (row.value === undefined) {
    return (
      <span className="ec-dim" title="no displayable value on the latest sample">
        —
      </span>
    );
  }
  return <span className={`ec-latest ec-latest--${row.valueKind}`}>{row.value}</span>;
}

/** The trend sparkline, or an honest em dash (non-numeric samples, or none fetched yet). */
function TrendCell({ row, width, height }: { row: SignalRow; width: number; height: number }): React.JSX.Element {
  if (row.series.length > 0) {
    return <Sparkline points={row.series} width={width} height={height} ariaLabel={`${row.name ?? row.leaf} trend`} />;
  }
  const why = row.valueKind === "number" ? "no numeric samples in the trend window" : "non-numeric samples — no trend to plot";
  return (
    <span className="ec-dim" title={why}>
      —
    </span>
  );
}

/** The receipt-freshness + publish-lag cell. */
function UpdatedCell({ row, nowServerMs }: { row: SignalRow; nowServerMs: number }): React.JSX.Element {
  const ageMs = Math.max(0, nowServerMs - row.receivedAt);
  const warn = row.lagMs !== undefined && row.lagMs >= LAG_WARN_MS;
  return (
    <span className="ec-upd">
      {formatUptimeShort(ageMs / 1000)}
      <span
        className={`ec-lag${warn ? " ec-lag--warn" : ""}`}
        data-testid={`signal-lag-${row.id}`}
        {...(warn ? { title: "publish lag over 5 s — the adapter is publishing a stale read" } : {})}
      >
        {row.lagMs !== undefined ? `lag ${formatLagSecs(row.lagMs)}` : "lag —"}
      </span>
    </span>
  );
}

/** The name-led first cell: canonical name (or mono channel fallback) + id line + owner. */
function SignalIdentity({ row, expanded }: { row: SignalRow; expanded: boolean }): React.JSX.Element {
  const hasName = row.name !== undefined && row.name !== "";
  const idLine =
    row.signalId !== undefined
      ? hasName
        ? `${row.signalId} · ${row.channel}`
        : row.signalId
      : hasName
        ? row.channel
        : undefined;
  return (
    <span className="ec-sig-name">
      <span className={`ec-sig-nm${hasName ? "" : " ec-sig-nm--fallback"}`}>
        <span className="ec-sig-exp" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        {hasName ? row.name : row.channel}
      </span>
      {idLine !== undefined && <span className="ec-sig-id">{idLine}</span>}
      <span className="ec-sig-owner">
        {row.device} / {row.component}
        {row.instance !== "main" && <span className="ec-sig-inst">{row.instance}</span>}
      </span>
    </span>
  );
}

/** The expansion body — identity, latest sample (labeled timestamps + lag), larger trend + stats. */
function SignalDetail({
  row,
  onOpenComponentDetail,
}: {
  row: SignalRow;
  onOpenComponentDetail?: (key: ComponentKey) => void;
}): React.JSX.Element {
  const stats = signalStats(row.series);
  const source =
    row.adapter !== undefined
      ? `${row.adapter}${row.endpoint !== undefined ? ` · ${row.endpoint}` : ""}`
      : undefined;
  return (
    <div className="ec-sig-detail-grid">
      <div className="ec-sig-dsec">
        <h4>Identity</h4>
        <dl className="ec-sig-kv">
          <dt>Canonical id</dt>
          <dd>{row.signalId ?? "—"}</dd>
          <dt>Channel</dt>
          <dd>{row.channel}</dd>
          <dt>Source</dt>
          <dd className="ec-sig-kv--sans">{source ?? "—"}</dd>
          <dt>Owner</dt>
          <dd className="ec-sig-kv--sans">
            {row.device} / {row.component}
            {row.instance !== "main" ? ` · ${row.instance}` : ""}
          </dd>
        </dl>
        {row.address !== undefined && (
          <pre className="ec-sig-addr" data-testid={`signal-address-${row.id}`}>
            {safeJson(row.address)}
          </pre>
        )}
      </div>
      <div className="ec-sig-dsec">
        <h4>Latest sample</h4>
        <dl className="ec-sig-kv">
          <dt>Value</dt>
          <dd>{row.value ?? "—"}</dd>
          <dt>Quality</dt>
          <dd className="ec-sig-kv--sans">
            <QualityChip row={row} />
          </dd>
          <dt>Raw status</dt>
          <dd>{row.qualityRaw ?? "—"}</dd>
          <dt>Source ts</dt>
          <dd data-testid={`signal-source-ts-${row.id}`}>
            {row.sourceTs ?? "—"} <span className="ec-dim">measured</span>
          </dd>
          <dt>Server ts</dt>
          <dd data-testid={`signal-server-ts-${row.id}`}>
            {row.serverTs ?? "—"} <span className="ec-dim">server refresh</span>
          </dd>
          <dt>Published</dt>
          <dd>
            {row.publishedTs ?? "—"} <span className="ec-dim">adapter → bus</span>
          </dd>
          <dt>Received</dt>
          <dd>
            {new Date(row.receivedAt).toISOString()} <span className="ec-dim">console</span>
          </dd>
          <dt>Lag</dt>
          <dd data-testid={`signal-detail-lag-${row.id}`}>
            {row.lagMs !== undefined ? `${formatLagSecs(row.lagMs)}` : "—"}{" "}
            <span className="ec-dim">published − measured</span>
          </dd>
        </dl>
      </div>
      <div className="ec-sig-dsec">
        <h4>Trend — retained window (≤60 samples)</h4>
        {row.series.length > 0 ? (
          <>
            <Sparkline points={row.series} width={320} height={72} ariaLabel={`${row.name ?? row.leaf} retained trend`} />
            {stats !== undefined && (
              <div className="ec-sig-statrow">
                <span>
                  min <b>{round2(stats.min)}</b>
                </span>
                <span>
                  max <b>{round2(stats.max)}</b>
                </span>
                <span>
                  avg <b>{round2(stats.avg)}</b>
                </span>
                <span>
                  Δ window <b>{`${stats.delta >= 0 ? "+" : ""}${round2(stats.delta)}`}</b>
                </span>
              </div>
            )}
          </>
        ) : (
          <p className="ec-dim">No numeric trend for this signal.</p>
        )}
        <div className="ec-sig-detail-actions">
          <button
            type="button"
            className="ec-linkish"
            data-testid={`signal-open-detail-${row.id}`}
            onClick={() => onOpenComponentDetail?.(row.key)}
          >
            Open component detail →
          </button>
        </div>
      </div>
    </div>
  );
}

export interface SignalsViewProps {
  state: ClientState;
  /** Client-clock ms (the 1 Hz tick) — drives the ticking Updated cells + rate readout. */
  now: number;
  /** The app-bar search query (filters + auto-expands matching groups). */
  query: string;
  /** The active device scope (UNS gateway device), or undefined for all devices. */
  deviceScope?: string;
  /** The active component scope (canonical id), or undefined for all components. */
  componentScope?: string;
  onDeviceScopeChange: (device: string | undefined) => void;
  onComponentScopeChange: (componentId: string | undefined) => void;
  /** Navigate to Component Detail for a row's component (the expansion link). */
  onOpenComponentDetail?: (key: ComponentKey) => void;
  /** Backfill points for the given rows (summary mode) — called as groups/rows expand. */
  onRequestPoints?: (rows: SignalRow[]) => void;
  /** Bumps when the points baseline resets (reconnect) — re-triggers the backfill sweep. */
  pointsEpoch?: number;
  /** Per-group msg/s (client 10 s window); undefined ⇒ no rate shown (no meter wired). */
  rateFor?: (seriesIds: string[]) => number;
}

export function SignalsView({
  state,
  now,
  query,
  deviceScope,
  componentScope,
  onDeviceScopeChange,
  onComponentScopeChange,
  onOpenComponentDetail,
  onRequestPoints,
  pointsEpoch,
  rateFor,
}: SignalsViewProps): React.JSX.Element {
  const { signals, status, fatalError } = state;
  const nowServerMs = now - state.fleet.clockOffsetMs;
  const live = status === "connected";

  const [groupBy, setGroupBy] = useState<SignalGroupBy>("path");
  const [quality, setQuality] = useState<QualityBucket | undefined>(undefined);
  // Per-group user overrides (true = expanded, false = collapsed; absent = the default rule).
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  // Per-group visible-row count (paging).
  const [visible, setVisible] = useState<Map<string, number>>(() => new Map());
  // Rows expanded to their detail panel.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

  // A fresh grouping axis invalidates the per-group collapse + paging state.
  useEffect(() => {
    setOverrides(new Map());
    setVisible(new Map());
  }, [groupBy]);

  const rows = signalRows(signals.series);
  const devices = signalDevices(rows);
  const showDeviceDropdown = devices.length > 1;
  const componentOptions = signalComponentOptions(rows, deviceScope);

  const base = filterSignalRows(rows, {
    ...(deviceScope !== undefined ? { deviceId: deviceScope } : {}),
    ...(componentScope !== undefined ? { componentId: componentScope } : {}),
    ...(query.trim() !== "" ? { query } : {}),
  });
  const counts = qualityCounts(base);
  const filtered = quality !== undefined ? base.filter((r) => r.qualityBucket === quality) : base;
  const groups = groupSignals(filtered, groupBy);
  const searchActive = query.trim() !== "";

  const baseExpanded = (g: SignalGroup): boolean =>
    g.headerless || (overrides.get(g.key) ?? !g.defaultCollapsed);
  const isExpanded = (g: SignalGroup): boolean => (searchActive ? true : baseExpanded(g));
  const visibleCount = (g: SignalGroup): number => visible.get(g.key) ?? PAGE_SIZE;

  const toggleGroup = (g: SignalGroup): void => {
    const next = !baseExpanded(g);
    setOverrides((prev) => new Map(prev).set(g.key, next));
    if (next) onRequestPoints?.(g.rows.slice(0, visibleCount(g)));
  };
  const collapseAll = (): void => {
    setOverrides(() => {
      const map = new Map<string, boolean>();
      for (const g of groups) if (!g.headerless) map.set(g.key, false);
      return map;
    });
  };
  const showMore = (g: SignalGroup): void => {
    const from = visibleCount(g);
    const to = from + PAGE_STEP;
    setVisible((prev) => new Map(prev).set(g.key, to));
    onRequestPoints?.(g.rows.slice(from, to));
  };
  const toggleRow = (row: SignalRow): void => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else {
        next.add(row.id);
        onRequestPoints?.([row]);
      }
      return next;
    });
  };

  // Backfill sweep: request points for everything currently visible in an expanded group (covers
  // default-expanded small fleets + search-expanded groups + a fresh baseline after reconnect).
  const visibleExpandedRows: SignalRow[] = [];
  for (const g of groups) if (isExpanded(g)) visibleExpandedRows.push(...g.rows.slice(0, visibleCount(g)));
  const visibleSig = visibleExpandedRows.map((r) => r.id).join("|");
  const backfill = useRef<{ fn?: (rows: SignalRow[]) => void; rows: SignalRow[] }>({ rows: [] });
  backfill.current = { ...(onRequestPoints !== undefined ? { fn: onRequestPoints } : {}), rows: visibleExpandedRows };
  useEffect(() => {
    const { fn, rows: pending } = backfill.current;
    if (pending.length > 0) fn?.(pending);
  }, [visibleSig, pointsEpoch]);

  return (
    <div className="ec-signals">
      <h1 className="ec-ph">Signals</h1>
      <div className="ec-ph-sub">
        <span>
          Live data plane — every signal on the site bus (<code>data/&#123;signal&#125;</code>). Signals
          routed only to durable stream targets do not pass here.
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
                (<code>data/&#123;signal&#125;</code>) — the adapters&apos; southbound readings and the
                processors&apos; derived values. Nothing is polled.
              </p>
            </>
          )}
        </Tile>
      ) : (
        <>
          <TriageStrip counts={counts} selected={quality} onSelect={setQuality} />

          <div className="ec-signals-filters">
            <Dropdown
              id="signals-groupby"
              size="sm"
              titleText="Group by"
              type="inline"
              label="Group by"
              items={GROUP_BY_OPTIONS.map((o) => o.id)}
              itemToString={(item) => (item !== null ? GROUP_BY_LABEL[item as SignalGroupBy] : "")}
              selectedItem={groupBy}
              onChange={({ selectedItem }) => selectedItem !== null && setGroupBy(selectedItem as SignalGroupBy)}
              data-testid="signals-groupby"
            />
            {showDeviceDropdown && (
              <Dropdown
                id="signals-device"
                size="sm"
                titleText="Device"
                type="inline"
                label="All devices"
                items={[ALL, ...devices]}
                itemToString={(item) => (item === ALL ? "All devices" : (item ?? ""))}
                selectedItem={deviceScope ?? ALL}
                onChange={({ selectedItem }) =>
                  onDeviceScopeChange(selectedItem === ALL || selectedItem === null ? undefined : selectedItem)
                }
                data-testid="signals-device"
              />
            )}
            <Dropdown
              id="signals-component"
              size="sm"
              titleText="Component"
              type="inline"
              label="All components"
              items={[ALL, ...componentOptions.map((o) => o.id)]}
              itemToString={(item) =>
                item === ALL || item === null
                  ? "All components"
                  : (componentOptions.find((o) => o.id === item)?.label ?? item)
              }
              selectedItem={componentScope ?? ALL}
              onChange={({ selectedItem }) =>
                onComponentScopeChange(selectedItem === ALL || selectedItem === null ? undefined : selectedItem)
              }
              data-testid="signals-component"
            />
            <span className="ec-dim ec-signals__pending" data-testid="signals-pending-note">
              units · limits pending (needs <code>describe</code>)
            </span>
            <span className="ec-signals-filters__spacer" />
            {filtered.length !== rows.length && (
              <span className="ec-dim ec-filters__count" data-testid="signal-filter-count">
                {filtered.length} of {rows.length} signals
              </span>
            )}
            <button
              type="button"
              className="ec-collapse-all"
              data-testid="signals-collapse-all"
              onClick={collapseAll}
            >
              Collapse all
            </button>
          </div>

          {filtered.length === 0 ? (
            <Tile className="ec-empty" data-testid="signals-filtered-empty">
              <h3>No signals match</h3>
              <p className="ec-dim">Clear the search or widen the device / component / quality scope.</p>
            </Tile>
          ) : (
            <TableContainer className="ec-fleet">
              <div className="ec-tablewrap ec-signals-tablewrap">
                <Table size="lg" aria-label="Signals, grouped">
                  <TableHead>
                    <TableRow>
                      {COLUMNS.map((col) => (
                        <TableHeader key={col}>{col}</TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody data-testid="signals-table">
                    {groups.map((g) => (
                      <GroupRows
                        key={g.key}
                        group={g}
                        expanded={isExpanded(g)}
                        visibleCount={visibleCount(g)}
                        nowServerMs={nowServerMs}
                        expandedRows={expandedRows}
                        {...(rateFor !== undefined ? { rateFor } : {})}
                        {...(onOpenComponentDetail !== undefined ? { onOpenComponentDetail } : {})}
                        onToggleGroup={toggleGroup}
                        onShowMore={showMore}
                        onToggleRow={toggleRow}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="ec-tablecards" data-testid="signals-card-list">
                {groups.map((g) => (
                  <GroupCards
                    key={g.key}
                    group={g}
                    expanded={isExpanded(g)}
                    visibleCount={visibleCount(g)}
                    nowServerMs={nowServerMs}
                    expandedRows={expandedRows}
                    {...(rateFor !== undefined ? { rateFor } : {})}
                    {...(onOpenComponentDetail !== undefined ? { onOpenComponentDetail } : {})}
                    onToggleGroup={toggleGroup}
                    onShowMore={showMore}
                    onToggleRow={toggleRow}
                  />
                ))}
              </div>
            </TableContainer>
          )}
        </>
      )}
    </div>
  );
}

/** Shared props threaded down to the group/row renderers. */
interface GroupRenderProps {
  group: SignalGroup;
  expanded: boolean;
  visibleCount: number;
  nowServerMs: number;
  expandedRows: Set<string>;
  rateFor?: (seriesIds: string[]) => number;
  onOpenComponentDetail?: (key: ComponentKey) => void;
  onToggleGroup: (g: SignalGroup) => void;
  onShowMore: (g: SignalGroup) => void;
  onToggleRow: (row: SignalRow) => void;
}

/** The collapsed-header rollups (bad/uncertain pills + msg/s + freshest update). */
function GroupRollups({
  group,
  nowServerMs,
  rateFor,
}: {
  group: SignalGroup;
  nowServerMs: number;
  rateFor?: (seriesIds: string[]) => number;
}): React.JSX.Element {
  const rate = rateFor?.(group.rows.map((r) => r.id));
  return (
    <>
      <span className="ec-sig-gcount" data-testid={`group-count-${group.key}`}>
        {group.count} signal{group.count === 1 ? "" : "s"}
      </span>
      {(group.bad > 0 || group.uncertain > 0) && (
        <span className="ec-sig-groll">
          {group.bad > 0 && (
            <span className="ec-gpill ec-gpill--bad" title={offenderTitle(group.worstBad)} data-testid={`group-bad-${group.key}`}>
              {group.bad} BAD
            </span>
          )}
          {group.uncertain > 0 && (
            <span className="ec-gpill ec-gpill--unc" title={offenderTitle(group.worstUncertain)} data-testid={`group-unc-${group.key}`}>
              {group.uncertain} UNCERTAIN
            </span>
          )}
        </span>
      )}
      <span className="ec-sig-gstats">
        {rate !== undefined && <span data-testid={`group-rate-${group.key}`}>{rate.toFixed(1)} msg/s</span>}
        <span>updated {formatUptimeShort(Math.max(0, nowServerMs - group.freshestAt) / 1000)}</span>
      </span>
    </>
  );
}

/** One group's table rows: a sticky header (unless headerless), the visible signal rows + details, and a "Show more" row. */
function GroupRows(props: GroupRenderProps): React.JSX.Element {
  const { group, expanded, visibleCount, nowServerMs, expandedRows, rateFor, onOpenComponentDetail, onToggleGroup, onShowMore, onToggleRow } = props;
  const shown = group.rows.slice(0, visibleCount);
  const remaining = group.rows.length - shown.length;
  return (
    <>
      {!group.headerless && (
        <TableRow className="ec-sig-group" data-testid={`signal-group-${group.key}`}>
          <TableCell colSpan={COLSPAN}>
            <div className="ec-sig-ghead">
              <button
                type="button"
                className="ec-sig-gtoggle"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label} signals`}
                data-testid={`group-toggle-${group.key}`}
                onClick={() => onToggleGroup(group)}
              >
                {expanded ? "▾" : "▸"}
              </button>
              <span className="ec-sig-gname">{group.label}</span>
              <GroupRollups group={group} nowServerMs={nowServerMs} {...(rateFor !== undefined ? { rateFor } : {})} />
            </div>
          </TableCell>
        </TableRow>
      )}
      {expanded &&
        shown.map((row) => {
          const rowOpen = expandedRows.has(row.id);
          return (
            <RowFragment
              key={row.id}
              row={row}
              open={rowOpen}
              nowServerMs={nowServerMs}
              {...(onOpenComponentDetail !== undefined ? { onOpenComponentDetail } : {})}
              onToggleRow={onToggleRow}
            />
          );
        })}
      {expanded && remaining > 0 && (
        <TableRow className="ec-sig-more" data-testid={`signal-more-${group.key}`}>
          <TableCell colSpan={COLSPAN}>
            <button type="button" className="ec-sig-more-btn" onClick={() => onShowMore(group)}>
              Show {Math.min(PAGE_STEP, remaining)} more {group.label} signals
            </button>{" "}
            <span className="ec-dim">· only the first {visibleCount} render — the DOM stays bounded</span>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** One signal row + (when open) its detail row. */
function RowFragment({
  row,
  open,
  nowServerMs,
  onOpenComponentDetail,
  onToggleRow,
}: {
  row: SignalRow;
  open: boolean;
  nowServerMs: number;
  onOpenComponentDetail?: (key: ComponentKey) => void;
  onToggleRow: (row: SignalRow) => void;
}): React.JSX.Element {
  return (
    <>
      <TableRow className={`ec-sig ec-sig--${row.qualityBucket}`} data-testid={`signal-row-${row.id}`}>
        <TableCell className="ec-sig-namecell">
          <button
            type="button"
            className="ec-sig-expand"
            aria-expanded={open}
            data-testid={`signal-expand-${row.id}`}
            onClick={() => onToggleRow(row)}
          >
            <SignalIdentity row={row} expanded={open} />
          </button>
        </TableCell>
        <TableCell className="ec-sig-latest">
          <LatestValue row={row} />
        </TableCell>
        <TableCell>
          <QualityChip row={row} />
        </TableCell>
        <TableCell className="ec-sig-trend">
          <TrendCell row={row} width={120} height={28} />
        </TableCell>
        <TableCell>
          <UpdatedCell row={row} nowServerMs={nowServerMs} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="ec-sig-detail" data-testid={`signal-detail-${row.id}`}>
          <TableCell colSpan={COLSPAN}>
            <SignalDetail row={row} {...(onOpenComponentDetail !== undefined ? { onOpenComponentDetail } : {})} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** One group's mobile cards: the same header rollups + row cards + "Show more", following the grouping. */
function GroupCards(props: GroupRenderProps): React.JSX.Element {
  const { group, expanded, visibleCount, nowServerMs, expandedRows, rateFor, onOpenComponentDetail, onToggleGroup, onShowMore, onToggleRow } = props;
  const shown = group.rows.slice(0, visibleCount);
  const remaining = group.rows.length - shown.length;
  return (
    <section className="ec-sig-cardgroup" data-testid={`signal-cardgroup-${group.key}`}>
      {!group.headerless && (
        <button
          type="button"
          className="ec-sig-cardgroup__toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label} signals`}
          onClick={() => onToggleGroup(group)}
        >
          <span className="ec-sig-exp" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="ec-sig-gname">{group.label}</span>
          <GroupRollups group={group} nowServerMs={nowServerMs} {...(rateFor !== undefined ? { rateFor } : {})} />
        </button>
      )}
      {expanded && (
        <div className="ec-sig-cardgroup__body">
          {shown.map((row) => {
            const open = expandedRows.has(row.id);
            return (
              <article className={`ec-card ec-sig-card ec-sig-card--${row.qualityBucket}`} key={row.id} data-testid={`signal-card-${row.id}`}>
                <button type="button" className="ec-sig-card__head" aria-expanded={open} onClick={() => onToggleRow(row)}>
                  <SignalIdentity row={row} expanded={open} />
                  <QualityChip row={row} />
                </button>
                <dl className="ec-card__metrics">
                  <div className="ec-kv">
                    <dt>Latest</dt>
                    <dd className="ec-sig-latest">
                      <LatestValue row={row} />
                    </dd>
                  </div>
                  <div className="ec-kv">
                    <dt>Updated</dt>
                    <dd>
                      <UpdatedCell row={row} nowServerMs={nowServerMs} />
                    </dd>
                  </div>
                  <div className="ec-kv ec-kv--wide">
                    <dt>Trend</dt>
                    <dd className="ec-sig-trend">
                      <TrendCell row={row} width={200} height={36} />
                    </dd>
                  </div>
                </dl>
                {open && <SignalDetail row={row} {...(onOpenComponentDetail !== undefined ? { onOpenComponentDetail } : {})} />}
              </article>
            );
          })}
          {remaining > 0 && (
            <button type="button" className="ec-sig-more-btn" data-testid={`signal-card-more-${group.key}`} onClick={() => onShowMore(group)}>
              Show {Math.min(PAGE_STEP, remaining)} more {group.label} signals
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The quality-triage strip: live counts (fold-aware) that also filter the rows on click. */
function TriageStrip({
  counts,
  selected,
  onSelect,
}: {
  counts: QualityCounts;
  selected: QualityBucket | undefined;
  onSelect: (q: QualityBucket | undefined) => void;
}): React.JSX.Element {
  const chip = (
    bucket: QualityBucket | undefined,
    label: string,
    n: number,
    sw?: string,
  ): React.JSX.Element => {
    const active = selected === bucket || (bucket === undefined && selected === undefined);
    return (
      <button
        type="button"
        className={`ec-qchip${active ? " ec-qchip--sel" : ""}`}
        data-testid={`triage-${bucket ?? "all"}`}
        aria-pressed={active}
        onClick={() => onSelect(bucket)}
      >
        {sw !== undefined && <span className={`ec-qsw ec-qsw--${sw}`} />}
        {label} <span className="ec-qchip__n">{n}</span>
      </button>
    );
  };
  return (
    <div className="ec-triage" role="group" aria-label="Filter by quality">
      {chip(undefined, "All", counts.all)}
      {chip("good", "Good", counts.good, "good")}
      {chip("uncertain", "Uncertain", counts.uncertain, "unc")}
      {chip("bad", "Bad", counts.bad, "bad")}
      {chip("none", "No quality", counts.none, "none")}
    </div>
  );
}

/**
 * The live container: subscribes the signal stream while mounted (the interest pattern — a fresh
 * snapshot on re-subscribe self-heals after reconnect); unsubscribes on unmount. Owns the
 * device→component cascade (seeded from an optional Component-Detail deep-link), the summary-mode
 * + points-fetch capability gating, and the per-group msg/s meter.
 */
export function ConnectedSignalsView({
  client,
  initialComponentId,
  onOpenComponentDetail,
}: {
  client: FleetClient;
  initialComponentId?: string;
  onOpenComponentDetail?: (key: ComponentKey) => void;
}): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const { query } = useSearch();
  const status = state.status;
  const summaryMode = state.settings?.capabilities?.signalsSummary === true;

  const [deviceScope, setDeviceScope] = useState<string | undefined>(
    initialComponentId !== undefined ? componentDeviceOf(initialComponentId) : undefined,
  );
  const [componentScope, setComponentScope] = useState<string | undefined>(initialComponentId);

  // Re-seed the scope whenever the deep-link target changes (a new Component-Detail link, or a
  // plain nav that clears it) — mount-only initial state would go stale otherwise.
  useEffect(() => {
    setComponentScope(initialComponentId);
    setDeviceScope(initialComponentId !== undefined ? componentDeviceOf(initialComponentId) : undefined);
  }, [initialComponentId]);

  // Backfill dedupe + baseline generation (cleared/bumped on every (re)subscribe).
  const requested = useRef<Set<string>>(new Set());
  const [pointsEpoch, setPointsEpoch] = useState(0);
  const meter = useRef(new SignalRateMeter());

  useEffect(() => {
    if (status === "connected") {
      // Omit the mode for the full fallback (the wire treats absent == full) — only ask for
      // summary when the gateway advertised the capability.
      client.subscribeSignals(summaryMode ? "summary" : undefined);
      requested.current = new Set();
      setPointsEpoch((e) => e + 1);
    }
  }, [client, status, summaryMode]);
  useEffect(() => () => client.unsubscribeSignals(), [client]);

  // Record live `signal` arrivals for the per-group msg/s meter (the state-change seam collapses
  // batches, losing the count).
  useEffect(() => {
    return client.onSignalUpdate((updates) => {
      const at = Date.now();
      meter.current.prune(at);
      const perSeries = new Map<string, number>();
      for (const u of updates) {
        const id = `${componentKeyId(u.key)}/${u.instance} ${u.signal}`;
        perSeries.set(id, (perSeries.get(id) ?? 0) + 1);
      }
      for (const [id, count] of perSeries) meter.current.record(id, count, at);
    });
  }, [client]);

  const onDeviceScopeChange = (device: string | undefined): void => {
    setDeviceScope(device);
    setComponentScope((c) => cascadeComponentScope(c, device));
  };

  const requestPoints = (rows: SignalRow[]): void => {
    if (!summaryMode) return;
    const selectors: SignalPointSelector[] = [];
    for (const r of rows) {
      if (r.pointCount > 0 || requested.current.has(r.id)) continue;
      requested.current.add(r.id);
      selectors.push(pointSelector(r));
    }
    if (selectors.length > 0) client.getSignalPoints(selectors);
  };

  const rateFor = (ids: string[]): number => meter.current.ratePerSec(ids, now);

  return (
    <SignalsView
      state={state}
      now={now}
      query={query}
      {...(deviceScope !== undefined ? { deviceScope } : {})}
      {...(componentScope !== undefined ? { componentScope } : {})}
      onDeviceScopeChange={onDeviceScopeChange}
      onComponentScopeChange={setComponentScope}
      {...(onOpenComponentDetail !== undefined ? { onOpenComponentDetail } : {})}
      onRequestPoints={requestPoints}
      pointsEpoch={pointsEpoch}
      rateFor={rateFor}
    />
  );
}

/** Canonical component id from a key (deep-link helper for the app shell). */
export function scopeIdFor(key: ComponentKey): string {
  return componentKeyId(key);
}

/** Publish lag in seconds, mockup-style: `0.18 s` under a second, `8.3 s` above. */
function formatLagSecs(ms: number): string {
  const secs = ms / 1000;
  return `${Math.abs(secs) < 1 ? secs.toFixed(2) : secs.toFixed(1)} s`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function offenderTitle(offender?: { label: string; raw?: string }): string | undefined {
  if (offender === undefined) return undefined;
  return offender.raw !== undefined ? `${offender.label} — ${offender.raw}` : offender.label;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
