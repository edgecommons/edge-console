/**
 * The Overview summary row — summary-before-detail, faithful to the signed-off hi-fi
 * mockup's four-tile header:
 *   1. Site health   — the fleet rollup donut + "N/M healthy" + counts-by-status legend;
 *   2. Active alerts  — the AlarmTracker active count + "C critical · W warning · +K contained"
 *                       (clickable → Events & Alarms);
 *   3. Edge bus       — the console's OWN bus-ingest throughput (msgs/s, from the heartbeat);
 *   4. Edge node      — the console's OWN liveness (this WS connection) — its self-health.
 *
 * Tiles 1-2 source cleanly from the fleet rollup + AlarmTracker. Tiles 3-4 are the console's
 * own runtime, surfaced over the heartbeat (R1): the Edge-bus tile shows the real msgs/s + a
 * moving sparkline (the throughput ring) + the messaging transport/broker foot, and the Edge-node
 * tile shows the console's OWN node name / platform / cpu% / memory / uptime (measured off its own
 * process) — honest live self-health, no fabricated numbers (a field the console has not reported
 * yet renders "—").
 * All presentational: state in, DOM out.
 */
import { ClickableTile, Tag, Tile } from "@carbon/react";
import type { AlarmCounts, ConsoleSelf, MetricPoint } from "@edgecommons/edge-console-protocol";
import type { FleetCounts } from "../fleet/selectors";
import type { ConnectionStatus } from "../fleet/client";
import { formatDurationMs, formatUptimeShort } from "../fleet/selectors";
import { Sparkline } from "../common/Sparkline";
import { LIVENESS_STYLE } from "./StatusTag";

/** Donut segment order + coloring (Carbon support tokens via CSS custom props). */
const DONUT_SEGMENTS = [
  { key: "ok", color: "var(--cds-support-success, #42be65)" },
  { key: "warn", color: "var(--cds-support-warning, #f1c21b)" },
  { key: "err", color: "var(--cds-support-error, #fa4d56)" },
  { key: "idle", color: "var(--cds-text-placeholder, #6f6f6f)" },
] as const;

/** Compute the donut's `[ok, warn, err, idle]` proportions from the counts. */
export function donutShares(counts: FleetCounts): number[] {
  const groups = [
    counts.byLiveness.FRESH,
    counts.byLiveness.WARN + counts.byLiveness.STALE,
    counts.byLiveness.OFFLINE,
    counts.byLiveness.UNREACHABLE + counts.byLiveness.STOPPED,
  ];
  if (counts.total === 0) return [0, 0, 0, 0];
  return groups.map((n) => (n / counts.total) * 100);
}

function HealthDonut({ counts }: { counts: FleetCounts }): React.JSX.Element {
  const shares = donutShares(counts);
  let offset = 0;
  return (
    <svg width="52" height="52" viewBox="0 0 36 36" aria-hidden="true" className="ec-donut">
      <circle
        cx="18"
        cy="18"
        r="15.9"
        fill="none"
        stroke="var(--cds-border-subtle, #393939)"
        strokeWidth="4"
      />
      {DONUT_SEGMENTS.map((seg, i) => {
        const share = shares[i] ?? 0;
        const dashOffset = -offset;
        offset += share;
        if (share <= 0) return null;
        return (
          <circle
            key={seg.key}
            cx="18"
            cy="18"
            r="15.9"
            fill="none"
            stroke={seg.color}
            strokeWidth="4"
            strokeDasharray={`${share} 100`}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 18 18)"
          />
        );
      })}
    </svg>
  );
}

/** The nonzero liveness chips with counts (the donut legend). */
function StatusLegend({ counts }: { counts: FleetCounts }): React.JSX.Element {
  const order = ["FRESH", "WARN", "STALE", "OFFLINE", "STOPPED", "UNREACHABLE"] as const;
  return (
    <div className="ec-legend">
      {order
        .filter((lv) => counts.byLiveness[lv] > 0)
        .map((lv) => {
          const style = LIVENESS_STYLE[lv];
          return (
            <Tag
              key={lv}
              size="sm"
              type={style.tagType ?? "gray"}
              renderIcon={style.Icon}
              className={`ec-tag ${style.className ?? ""}`.trim()}
              title={style.label}
            >
              {counts.byLiveness[lv]}
            </Tag>
          );
        })}
    </div>
  );
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Live",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

export interface SummaryTilesProps {
  counts: FleetCounts;
  /** Active-alarm rollup (AlarmTracker) — the Active alerts tile. */
  alarms: AlarmCounts;
  status: ConnectionStatus;
  /** The console's own bus-ingest throughput (msgs/s); undefined until a heartbeat carries it. */
  busMsgsPerSec?: number;
  /** The console's own recent per-second bus rates (the Edge-bus sparkline ring). */
  busRecentRates?: number[];
  /** The console's own self-identity + process vitals + transport (the Edge-node tile + Edge-bus foot). */
  self?: ConsoleSelf;
  wsUrl: string;
  /** Client-clock ms of the last applied fleet frame. */
  lastUpdatedAt?: number;
  /** Client-clock "now" (the 1 Hz tick). */
  now: number;
  /** Open the Events & Alarms screen (makes the Active alerts tile clickable). */
  onOpenEvents?: () => void;
}

/** Round a msgs/s rate for display: whole numbers, one decimal below 10. */
function formatRate(rate: number): string {
  return rate >= 10 || rate === 0 ? String(Math.round(rate)) : rate.toFixed(1);
}

/** The Edge-bus tile's transport foot ("MQTT · EMQX @ gateway"), from the console's own self. */
function transportFoot(self: ConsoleSelf | undefined, busMsgsPerSec: number | undefined): string {
  const parts = [self?.transport, self?.broker].filter((p): p is string => p !== undefined && p !== "");
  if (parts.length > 0) return parts.join(" · ");
  return busMsgsPerSec !== undefined ? "site bus · console ingest" : "pending — awaiting heartbeat";
}

export function SummaryTiles({
  counts,
  alarms,
  status,
  busMsgsPerSec,
  busRecentRates,
  self,
  wsUrl,
  lastUpdatedAt,
  now,
  onOpenEvents,
}: SummaryTilesProps): React.JSX.Element {
  const alertSegs = [
    alarms.critical > 0 ? `${alarms.critical} critical` : undefined,
    alarms.warning > 0 ? `${alarms.warning} warning` : undefined,
    alarms.contained > 0 ? `+${alarms.contained} contained` : undefined,
  ].filter((p): p is string => p !== undefined);
  const alertFoot = alertSegs.length > 0 ? alertSegs.join(" · ") : "no active alerts";

  const updatedFoot =
    lastUpdatedAt !== undefined
      ? `updated ${formatDurationMs(Math.max(0, now - lastUpdatedAt))} ago`
      : "no data yet";

  // The Edge-bus sparkline ring — the recent per-second rates as time-indexed points.
  const busPoints: MetricPoint[] =
    busRecentRates !== undefined ? busRecentRates.map((value, at) => ({ at, value })) : [];

  return (
    <div className="ec-tiles" data-testid="summary-tiles">
      <Tile className="ec-tile">
        <div className="ec-tile__label">Site health</div>
        <div className="ec-tile__health">
          <HealthDonut counts={counts} />
          <div>
            <div className="ec-tile__num" data-testid="healthy-count">
              {counts.healthy}
              <small>/{counts.total} healthy</small>
            </div>
            <StatusLegend counts={counts} />
          </div>
        </div>
      </Tile>

      {onOpenEvents !== undefined ? (
        <ClickableTile
          className="ec-tile"
          onClick={onOpenEvents}
          data-testid="active-alerts-tile"
          aria-label={`Active alerts: ${alarms.active} — open Events & Alarms`}
        >
          <div className="ec-tile__label">Active alerts</div>
          <div className="ec-tile__num" data-testid="active-alerts-count">
            {alarms.active}
          </div>
          <div className="ec-tile__foot">{alertFoot}</div>
        </ClickableTile>
      ) : (
        <Tile className="ec-tile">
          <div className="ec-tile__label">Active alerts</div>
          <div className="ec-tile__num" data-testid="active-alerts-count">
            {alarms.active}
          </div>
          <div className="ec-tile__foot">{alertFoot}</div>
        </Tile>
      )}

      <Tile className="ec-tile">
        <div className="ec-tile__label">
          Edge bus <span className="ec-dim">msgs/s</span>
        </div>
        <div className="ec-tile__busrow">
          <div className="ec-tile__num ec-tile__num--md" data-testid="bus-rate">
            {busMsgsPerSec !== undefined ? (
              formatRate(busMsgsPerSec)
            ) : (
              <span className="ec-dim">—</span>
            )}
          </div>
          {busPoints.length > 1 && (
            <Sparkline
              points={busPoints}
              width={120}
              height={36}
              ariaLabel="edge bus throughput trend"
              formatValue={(v) => `${Math.round(v)}/s`}
            />
          )}
        </div>
        <div className="ec-tile__foot" data-testid="bus-transport">
          {transportFoot(self, busMsgsPerSec)}
        </div>
      </Tile>

      <Tile className="ec-tile">
        <div className="ec-tile__label">
          Edge node <span className="ec-dim">console self</span>
        </div>
        <div className="ec-tile__num ec-tile__num--md" data-testid="node-self">
          {self !== undefined ? (
            <span className="ec-mono">{self.device}</span>
          ) : (
            CONNECTION_LABEL[status]
          )}
        </div>
        <div className="ec-tile__foot" data-testid="node-self-foot" title={wsUrl}>
          {self !== undefined ? selfFoot(self) : `${updatedFoot} · cpu/mem —`}
        </div>
      </Tile>
    </div>
  );
}

/** The console-self tile foot: "HOST · cpu 4% · mem 180 MB · up 6d" (fields the console reported). */
function selfFoot(self: ConsoleSelf): string {
  const parts: string[] = [];
  if (self.platform !== undefined && self.platform !== "") parts.push(self.platform);
  parts.push(self.cpuPercent !== undefined ? `cpu ${Math.round(self.cpuPercent)}%` : "cpu —");
  if (self.memoryMb !== undefined) parts.push(`mem ${Math.round(self.memoryMb)} MB`);
  parts.push(`up ${formatUptimeShort(self.uptimeSecs)}`);
  return parts.join(" · ");
}
