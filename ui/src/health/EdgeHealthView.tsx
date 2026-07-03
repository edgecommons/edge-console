/**
 * The edge-health view — priority #1, the browser side of the console's reason to
 * exist. Faithful to `docs/mockups-hifi.html` (the signed-off hi-fi): page header
 * with the live WS status, summary-before-detail (the four-tile health header), the
 * inline issue notes, then the fleet grouped device → components with the Carbon
 * status treatment. 100 % live data from the C2 gateway — no mock content.
 *
 * `EdgeHealthView` is purely presentational (state in, DOM out — component-testable
 * without a socket); `ConnectedEdgeHealthView` binds it to a {@link FleetClient}.
 */
import { InlineLoading, InlineNotification, Tag, Tile } from "@carbon/react";
import { CircleFilled } from "@carbon/react/icons";
import type { ClientState, ConnectionStatus, FleetClient } from "../fleet/client";
import { fleetIssues, summarize } from "../fleet/selectors";
import { formatDurationMs } from "../fleet/selectors";
import { useFleetLifecycle, useFleetState, useNowTick } from "../fleet/useFleet";
import { FleetTable } from "./FleetTable";
import { IssueNotifications } from "./IssueNotifications";
import { SummaryTiles } from "./SummaryTiles";

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
}

export function EdgeHealthView({ state, now }: EdgeHealthViewProps): React.JSX.Element {
  const { fleet, status, hasSnapshot, fatalError } = state;
  const counts = summarize(fleet);
  // All fleet timestamps are server-clock; render ages on the server timeline.
  const nowServerMs = now - fleet.clockOffsetMs;
  const issues = fleetIssues(fleet, nowServerMs);

  return (
    <div className="ec-health">
      <h1 className="ec-ph">Edge health</h1>
      <div className="ec-ph-sub">
        <span>
          {counts.total} component{counts.total === 1 ? "" : "s"} across {counts.devices} device
          {counts.devices === 1 ? "" : "s"}
        </span>
        <ConnectionTag status={status} />
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
            status={status}
            wsUrl={state.wsUrl}
            {...(fleet.lastUpdatedAt !== undefined ? { lastUpdatedAt: fleet.lastUpdatedAt } : {})}
            now={now}
          />
          <IssueNotifications issues={issues} />
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
                Fleet <span className="ec-dim ec-sec__hint">grouped by device</span>
              </h2>
              <FleetTable fleet={fleet} nowServerMs={nowServerMs} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** The live container: binds the view to a {@link FleetClient} + the 1 Hz tick. */
export function ConnectedEdgeHealthView({ client }: { client: FleetClient }): React.JSX.Element {
  useFleetLifecycle(client);
  const state = useFleetState(client);
  const now = useNowTick(1000);
  return <EdgeHealthView state={state} now={now} />;
}
