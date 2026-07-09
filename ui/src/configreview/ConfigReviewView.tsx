/**
 * The config-review picker view — priority #2 (slice C5), faithful to the signed-off hi-fi
 * (formerly the "Configuration review" mockup): a component picker (340 px
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
 * The application shell no longer routes this as a standalone page; component
 * configuration now lives in Component Detail's Configuration tab. This wrapper
 * remains as an internal/test harness around the shared {@link ConfigInspector}.
 */
import {
  InlineLoading,
  InlineNotification,
  Tag,
  Tile,
} from "@carbon/react";
import type { ComponentKey, Liveness } from "@edgecommons/edge-console-protocol";
import type { ClientState } from "../fleet/client";
import type { ConfigEntryView } from "../fleet/config-store";
import type { ComponentView } from "../fleet/store";
import { ConfigInspector } from "./ConfigInspector";

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
        <span className="ec-dim ec-mono ec-cfg-pick__device">{comp.key.device}</span>
      </span>
      <AvailabilityTag entry={entry} />
    </button>
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
    selected !== undefined ? `${selected.device}/${selected.component}` : undefined;
  const selectedComp = components.find((c) => c.id === selectedId);
  const selectedEntry = selectedId !== undefined ? state.configs.entriesById[selectedId] : undefined;

  return (
    <div className="ec-config">
      <h1 className="ec-ph">Configuration inspector</h1>
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
            Configuration inspection works over the discovered fleet — components appear
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
            <ConfigInspector
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
