/**
 * The config-review view — priority #2 (slice C5), faithful to the signed-off hi-fi
 * (`docs/mockups-hifi.html`, "Configuration review"): a component picker (340 px
 * list, liveness dot + availability tag) beside the selected component's effective
 * running configuration — Structured rows / Raw JSON tabs, source-redacted secrets
 * rendered AS redacted (`"***"` masked, `$secret` refs labeled as vault pointers,
 * never implied to be real values), a live "received Ns ago" stamp, and a Refresh
 * action that fires the per-device `republish-cfg` broadcast through the gateway.
 *
 * Data path: the cfg BODY does not ride the liveness stream (C3 finding — deltas are
 * change notifications). Selecting a component issues `get-config` on the ONE shared
 * WS connection; the gateway answers from its retained-cfg cache and pushes every
 * later `cfg` arrival for the selected key, so the pane stays live without polling.
 *
 * `ConfigReviewView` is purely presentational (state in, DOM out);
 * `ConnectedConfigReviewView` binds it to the shared {@link FleetClient}.
 */
import { useEffect, useState } from "react";
import {
  Button,
  InlineLoading,
  InlineNotification,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  Tile,
} from "@carbon/react";
import { Renew } from "@carbon/react/icons";
import type { ComponentKey, Liveness } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import type { ConfigEntryView } from "../fleet/config-store";
import type { ComponentView } from "../fleet/store";
import { formatDurationMs } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import {
  effectiveConfig,
  flattenConfig,
  jsonTokens,
  redactionCounts,
} from "./selectors";

/** Liveness -> picker-dot modifier (the mockup's colored dots). */
const DOT_CLASS: Record<Liveness, string> = {
  FRESH: "ok",
  WARN: "warn",
  STALE: "warn",
  OFFLINE: "err",
  STOPPED: "idle",
  UNREACHABLE: "un",
};

/** The picker's per-component availability chip (mockup: LIVE / UNAVAIL). */
function AvailabilityTag({ entry }: { entry: ConfigEntryView | undefined }): React.JSX.Element | null {
  if (entry === undefined) return null;
  if (entry.phase === "loaded") {
    return (
      <Tag size="sm" type="blue" className="ec-tag">
        LIVE
      </Tag>
    );
  }
  if (entry.phase === "unavailable") {
    return (
      <Tag size="sm" type="gray" className="ec-tag ec-tag--unreach">
        UNAVAIL
      </Tag>
    );
  }
  return (
    <Tag size="sm" type="gray" className="ec-tag">
      …
    </Tag>
  );
}

/** One picker row: dot + component (+instance) + device, availability on the right. */
function PickerRow({
  comp,
  entry,
  selected,
  onSelect,
}: {
  comp: ComponentView;
  entry: ConfigEntryView | undefined;
  selected: boolean;
  onSelect: (key: ComponentKey) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`ec-cfg-pick${selected ? " ec-cfg-pick--selected" : ""}`}
      aria-pressed={selected}
      data-testid={`config-pick-${comp.id}`}
      onClick={() => onSelect(comp.key)}
    >
      <span className={`ec-cfg-dot ec-cfg-dot--${DOT_CLASS[comp.liveness]}`} aria-hidden="true" />
      <span className="ec-cfg-pick__name">
        <span className="ec-pri">{comp.key.component}</span>
        {comp.key.instance !== "main" && (
          <Tag size="sm" type="outline" className="ec-instance">
            {comp.key.instance}
          </Tag>
        )}
        <span className="ec-dim ec-mono ec-cfg-pick__device">{comp.key.device}</span>
      </span>
      <AvailabilityTag entry={entry} />
    </button>
  );
}

/** The Structured tab: dotted-path rows; redacted/secret-ref leaves styled honestly. */
function StructuredRows({ body }: { body: unknown }): React.JSX.Element {
  const rows = flattenConfig(effectiveConfig(body));
  if (rows.length === 0) {
    return <p className="ec-dim">The announced configuration is empty.</p>;
  }
  return (
    <div className="ec-cfg-rows" data-testid="config-rows">
      {rows.map((row) => (
        <div className="ec-cfg-row" key={row.path}>
          <span className="ec-cfg-row__k ec-mono">{row.path}</span>
          <span className="ec-cfg-row__v ec-mono">
            {row.kind === "redacted" ? (
              <span className="ec-redacted" title="redacted at the source — the value never left the component">
                ●●●●●●
                <Tag size="sm" type="red" className="ec-tag">
                  redacted
                </Tag>
              </span>
            ) : row.kind === "secret-ref" ? (
              <>
                {row.display}
                <Tag size="sm" type="outline" className="ec-tag" title="vault reference — a pointer, not the secret value">
                  secret ref
                </Tag>
              </>
            ) : (
              row.display
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The Raw JSON tab: the body verbatim, syntax-classified (redaction sentinels styled). */
function RawJson({ body }: { body: unknown }): React.JSX.Element {
  const tokens = jsonTokens(effectiveConfig(body));
  return (
    <pre className="ec-cfg-json" data-testid="config-json">
      {tokens.map((t, i) => (
        <span key={i} className={`ec-json--${t.kind}`}>
          {t.text}
        </span>
      ))}
    </pre>
  );
}

/** The detail pane for one selected component. */
function ConfigDetail({
  comp,
  selectedKey,
  entry,
  nowServerMs,
  onRefresh,
}: {
  /** The fleet's view of the selection (may be gone from the fleet while still selected). */
  comp: ComponentView | undefined;
  selectedKey: ComponentKey;
  entry: ConfigEntryView | undefined;
  nowServerMs: number;
  onRefresh: (key: ComponentKey) => void;
}): React.JSX.Element {
  const refreshing = entry?.refreshing === true;
  const refreshButton = (
    <Button
      kind="ghost"
      size="sm"
      renderIcon={Renew}
      disabled={refreshing}
      data-testid="refresh-config"
      onClick={() => onRefresh(selectedKey)}
    >
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );

  const header = (
    <div className="ec-cfg-head">
      <div className="ec-cfg-head__id">
        <b>{selectedKey.component}</b>
        <span className="ec-dim ec-mono">
          {selectedKey.device}/{selectedKey.instance}
        </span>
        {entry?.phase === "loaded" && entry.receivedAt !== undefined && (
          <span className="ec-dim" data-testid="config-received">
            received {formatDurationMs(Math.max(0, nowServerMs - entry.receivedAt))} ago
          </span>
        )}
      </div>
      <div className="ec-cfg-head__actions">{refreshButton}</div>
    </div>
  );

  if (entry === undefined || entry.phase === "loading") {
    return (
      <div>
        {header}
        <Tile className="ec-empty" data-testid="config-loading">
          <InlineLoading description="Requesting configuration…" />
        </Tile>
      </div>
    );
  }

  if (entry.phase === "unavailable") {
    return (
      <div>
        {header}
        <Tile className="ec-empty" data-testid="config-unavailable">
          <h3>No configuration received</h3>
          <p className="ec-dim">
            The console holds no <code>cfg</code> announcement for this component —{" "}
            <code>cfg</code> is pushed on startup and on change, so a console started
            later sees nothing until the next push. <b>Refresh</b> asks every component
            on <span className="ec-mono">{selectedKey.device}</span> to re-announce
            (the <code>republish-cfg</code> broadcast); components answer once their
            library carries the republish listener.
          </p>
        </Tile>
      </div>
    );
  }

  const rows = flattenConfig(effectiveConfig(entry.body));
  const counts = redactionCounts(rows);
  return (
    <div>
      {header}
      {refreshing && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Re-announce requested"
          subtitle={`republish-cfg broadcast sent to ${selectedKey.device} — a fresh announcement replaces this view automatically.`}
        />
      )}
      {counts.redacted > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`${counts.redacted} value${counts.redacted === 1 ? "" : "s"} redacted at the source`}
          subtitle={
            "Masked by the component's library before publish — the real values never left the device." +
            (counts.secretRefs > 0
              ? ` ${counts.secretRefs} $secret reference${counts.secretRefs === 1 ? "" : "s"} shown as vault pointers.`
              : "")
          }
        />
      )}
      {comp === undefined && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Component no longer in the fleet view"
          subtitle="Showing its last announced configuration."
        />
      )}
      <Tabs>
        <TabList aria-label="Configuration representation" className="ec-cfg-tabs">
          <Tab>Structured</Tab>
          <Tab>Raw JSON</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <StructuredRows body={entry.body} />
          </TabPanel>
          <TabPanel>
            <RawJson body={entry.body} />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

export interface ConfigReviewViewProps {
  state: ClientState;
  /** Client-clock ms (the 1 Hz tick) — drives the "received Ns ago" stamp. */
  now: number;
  selected?: ComponentKey;
  onSelect: (key: ComponentKey) => void;
  onRefresh: (key: ComponentKey) => void;
}

export function ConfigReviewView({
  state,
  now,
  selected,
  onSelect,
  onRefresh,
}: ConfigReviewViewProps): React.JSX.Element {
  const { fleet, status, hasSnapshot, fatalError } = state;
  const nowServerMs = now - fleet.clockOffsetMs;
  const components = fleet.devices.flatMap((d) => d.components);
  const selectedId =
    selected !== undefined ? `${selected.device}/${selected.component}/${selected.instance}` : undefined;
  const selectedComp = components.find((c) => c.id === selectedId);
  const selectedEntry = selectedId !== undefined ? state.configs.entriesById[selectedId] : undefined;

  return (
    <div className="ec-config">
      <h1 className="ec-ph">Configuration review</h1>
      <div className="ec-ph-sub">
        <span>
          Effective, running configuration — announced by each component&apos;s{" "}
          <code>cfg</code> push, secrets redacted at the source.
        </span>
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
          subtitle="Showing last-known configuration; the selection is re-requested when the stream resumes."
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
                {fatalError === undefined && " — retrying in the background"}. Components
                will appear as soon as the stream is established.
              </p>
            </>
          )}
        </Tile>
      ) : components.length === 0 ? (
        <Tile className="ec-empty" data-testid="empty-fleet">
          <h3>No components discovered yet</h3>
          <p className="ec-dim">
            Configuration review works over the discovered fleet — components appear
            here automatically within one keepalive interval of coming up.
          </p>
        </Tile>
      ) : (
        <div className="ec-cfg-grid">
          <div className="ec-cfg-picker" data-testid="config-picker">
            <div className="ec-cfg-picker__hd">
              <span>Component</span>
              <span>config</span>
            </div>
            {components.map((comp) => (
              <PickerRow
                key={comp.id}
                comp={comp}
                entry={state.configs.entriesById[comp.id]}
                selected={comp.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
          {selected === undefined ? (
            <Tile className="ec-empty" data-testid="config-no-selection">
              <h3>Select a component</h3>
              <p className="ec-dim">
                Pick a component on the left to review its effective running
                configuration — requested on demand over the live gateway connection.
              </p>
            </Tile>
          ) : (
            <ConfigDetail
              comp={selectedComp}
              selectedKey={selected}
              entry={selectedEntry}
              nowServerMs={nowServerMs}
              onRefresh={onRefresh}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The live container: selection state + on-demand `get-config` over the shared client. */
export function ConnectedConfigReviewView({
  client,
  initialSelected,
}: {
  client: FleetClient;
  /** Pre-select this component on mount (e.g. a Component Detail "View config" hand-off). */
  initialSelected?: ComponentKey;
}): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const [selected, setSelected] = useState<ComponentKey | undefined>(initialSelected);
  const status = state.status;

  // (Re-)request the selection's cfg whenever the selection changes OR the connection
  // comes (back) up — server-side push interest is per-connection, so this effect is
  // the whole reconnect story (no client-side resubscribe machinery).
  useEffect(() => {
    if (selected !== undefined && status === "connected") {
      client.requestConfig(selected);
    }
  }, [client, selected, status]);

  return (
    <ConfigReviewView
      state={state}
      now={now}
      selected={selected}
      onSelect={setSelected}
      onRefresh={(key) => client.refreshConfig(key)}
    />
  );
}
