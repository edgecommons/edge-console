/**
 * The edge-health summary row — summary-before-detail, matching the hi-fi mockup's
 * four-tile header: (1) fleet health donut + counts-by-status legend, (2) needs
 * attention, (3) devices/reachability, (4) the live-stream tile (this console's own
 * WS connection — the mockup's "WS Live" surface). All values derive live from the
 * folded fleet view; nothing here is decorative.
 */
import { Tag, Tile } from "@carbon/react";
import type { FleetCounts } from "../fleet/selectors";
import type { ConnectionStatus } from "../fleet/client";
import { formatDurationMs } from "../fleet/selectors";
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
  status: ConnectionStatus;
  wsUrl: string;
  /** Client-clock ms of the last applied fleet frame. */
  lastUpdatedAt?: number;
  /** Client-clock "now" (the 1 Hz tick). */
  now: number;
}

export function SummaryTiles({
  counts,
  status,
  wsUrl,
  lastUpdatedAt,
  now,
}: SummaryTilesProps): React.JSX.Element {
  const stale = counts.byLiveness.STALE;
  const offline = counts.byLiveness.OFFLINE;
  const warn = counts.byLiveness.WARN;
  const unreach = counts.byLiveness.UNREACHABLE;
  const attentionParts = [
    warn > 0 ? `${warn} warning` : undefined,
    stale > 0 ? `${stale} stale` : undefined,
    offline > 0 ? `${offline} offline` : undefined,
    unreach > 0 ? `${unreach} unreachable` : undefined,
  ].filter((p): p is string => p !== undefined);

  return (
    <div className="ec-tiles" data-testid="summary-tiles">
      <Tile className="ec-tile">
        <div className="ec-tile__label">Fleet health</div>
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

      <Tile className="ec-tile">
        <div className="ec-tile__label">Needs attention</div>
        <div className="ec-tile__num" data-testid="attention-count">
          {counts.attention}
        </div>
        <div className="ec-tile__foot">
          {attentionParts.length > 0 ? attentionParts.join(" · ") : "all components healthy"}
        </div>
      </Tile>

      <Tile className="ec-tile">
        <div className="ec-tile__label">Devices</div>
        <div className="ec-tile__num" data-testid="device-count">
          {counts.devices}
        </div>
        <div className="ec-tile__foot">
          {counts.unreachableDevices > 0
            ? `${counts.unreachableDevices} unreachable`
            : counts.devices > 0
              ? "all reachable"
              : "none discovered yet"}
        </div>
      </Tile>

      <Tile className="ec-tile">
        <div className="ec-tile__label">Live stream</div>
        <div className="ec-tile__num ec-tile__num--md" data-testid="stream-status">
          {CONNECTION_LABEL[status]}
        </div>
        <div className="ec-tile__foot ec-mono" title={wsUrl}>
          {lastUpdatedAt !== undefined
            ? `updated ${formatDurationMs(Math.max(0, now - lastUpdatedAt))} ago`
            : "no data yet"}
        </div>
      </Tile>
    </div>
  );
}
