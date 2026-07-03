/**
 * The Metrics view (slice C6) — the generic metric browser over the UNS `metric`
 * class: one row per `(component, metric, measure)` with the LATEST value (the
 * headline — printed, in text tokens) and a small time-scaled sparkline of the
 * bounded recent series for at-a-glance trend. Values live-update as `metric`
 * frames fold into the store.
 *
 * The signed-off hi-fi has no dedicated metrics screen (its "Signals" screen is
 * the `data`-plane browser, Phase 2), so this view follows the established system:
 * the C3/C5 page-header treatment, the FleetTable's Carbon table primitives, and
 * the events view's filter row. Scannable-first: sorted by component, metric,
 * measure; filterable by component.
 *
 * `MetricsView` is purely presentational; `ConnectedMetricsView` binds it to the
 * shared {@link FleetClient} and owns subscribe-on-connect/unsubscribe-on-unmount.
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
import { CircleFilled } from "@carbon/react/icons";
import type { ClientState, FleetClient } from "../fleet/client";
import type { MetricSeriesView } from "../fleet/metric-series-store";
import { formatDurationMs } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { Sparkline } from "./Sparkline";
import { filterSeries, formatMetricValue, seriesComponentIds } from "./selectors";

const COLUMNS = ["Component", "Device", "Metric", "Measure", "Latest", "Trend", "Updated"] as const;

/** All-items sentinel for the component filter dropdown. */
const ALL = "__all__";

function SeriesRow({
  series,
  nowServerMs,
}: {
  series: MetricSeriesView;
  nowServerMs: number;
}): React.JSX.Element {
  return (
    <TableRow data-testid={`metric-row-${series.seriesId}`}>
      <TableCell>
        <span className="ec-pri">{series.key.component}</span>
        {series.key.instance !== "main" && (
          <Tag size="sm" type="outline" className="ec-instance">
            {series.key.instance}
          </Tag>
        )}
      </TableCell>
      <TableCell>
        <span className="ec-mono">{series.key.device}</span>
      </TableCell>
      <TableCell>
        <span className="ec-mono">{series.metric}</span>
      </TableCell>
      <TableCell>
        <span className="ec-mono">{series.measure}</span>
      </TableCell>
      <TableCell>
        <span className="ec-tnum ec-metric-latest" data-testid="metric-latest">
          {formatMetricValue(series.latest)}
        </span>
      </TableCell>
      <TableCell>
        <Sparkline
          points={series.points}
          ariaLabel={`${series.metric} ${series.measure} trend`}
          formatValue={formatMetricValue}
        />
      </TableCell>
      <TableCell>
        <span className="ec-dim ec-mono ec-tnum">
          {formatDurationMs(Math.max(0, nowServerMs - series.receivedAt))} ago
        </span>
      </TableCell>
    </TableRow>
  );
}

export interface MetricsViewProps {
  state: ClientState;
  /** Client-clock ms (the 1 Hz tick) — drives the ticking age cells. */
  now: number;
  componentFilter: string | undefined;
  onComponentFilterChange: (componentId: string | undefined) => void;
}

export function MetricsView({
  state,
  now,
  componentFilter,
  onComponentFilterChange,
}: MetricsViewProps): React.JSX.Element {
  const { metrics, status, fatalError } = state;
  const nowServerMs = now - state.fleet.clockOffsetMs;
  const series = metrics.series;
  const filtered = filterSeries(series, componentFilter);
  const components = seriesComponentIds(series);
  const live = status === "connected";

  return (
    <div className="ec-metrics">
      <h1 className="ec-ph">Metrics</h1>
      <div className="ec-ph-sub">
        <span>
          Numeric measures — the UNS <code>metric</code> class: latest value per
          component measure, with the recent trend.
        </span>
        <Tag
          size="sm"
          type={live ? "green" : "gray"}
          renderIcon={CircleFilled}
          className="ec-tag"
          data-testid="metrics-live"
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
      {fatalError === undefined && series.length > 0 && !live && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Gateway connection lost — reconnecting"
          subtitle="Showing last-received values; ages keep counting honestly until the stream resumes."
        />
      )}

      {series.length === 0 ? (
        <Tile className="ec-empty" data-testid="metrics-empty">
          {fatalError === undefined && (status === "connecting" || status === "reconnecting") ? (
            <InlineLoading description="Connecting to the console gateway…" />
          ) : (
            <>
              <h3>No metrics yet</h3>
              <p className="ec-dim">
                Every numeric measure a component publishes on its <code>metric</code>{" "}
                class appears here automatically — including the library&apos;s own{" "}
                <span className="ec-mono">sys</span> heartbeat measures and each
                bridge&apos;s <span className="ec-mono">relay_dropped_*</span> counters.
              </p>
            </>
          )}
        </Tile>
      ) : (
        <>
          <div className="ec-filters">
            <Dropdown
              id="metric-component-filter"
              size="sm"
              titleText="Component"
              label="All components"
              items={[ALL, ...components]}
              itemToString={(item) => (item === ALL ? "All components" : (item ?? ""))}
              selectedItem={componentFilter ?? ALL}
              onChange={({ selectedItem }) =>
                onComponentFilterChange(
                  selectedItem === ALL || selectedItem === null ? undefined : selectedItem,
                )
              }
            />
            {filtered.length !== series.length && (
              <span className="ec-dim ec-filters__count" data-testid="metrics-filter-count">
                {filtered.length} of {series.length} series
              </span>
            )}
          </div>

          <TableContainer className="ec-fleet">
            <div className="ec-tablewrap">
              <Table size="lg" aria-label="Latest metric values by component measure">
                <TableHead>
                  <TableRow>
                    {COLUMNS.map((col) => (
                      <TableHeader key={col}>{col}</TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody data-testid="metrics-table">
                  {filtered.map((s) => (
                    <SeriesRow key={s.seriesId} series={s} nowServerMs={nowServerMs} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableContainer>
        </>
      )}
    </div>
  );
}

/**
 * The live container: subscribes the metric stream while mounted; the subscribe
 * effect keys on the connection status (server-side interest is per-connection —
 * the fresh snapshot on re-subscribe self-heals). Unmounting unsubscribes.
 */
export function ConnectedMetricsView({ client }: { client: FleetClient }): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const [componentFilter, setComponentFilter] = useState<string | undefined>(undefined);
  const status = state.status;

  useEffect(() => {
    if (status === "connected") client.subscribeMetrics();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeMetrics(), [client]);

  return (
    <MetricsView
      state={state}
      now={now}
      componentFilter={componentFilter}
      onComponentFilterChange={setComponentFilter}
    />
  );
}
