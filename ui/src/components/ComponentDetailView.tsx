/**
 * The Component Detail screen (slice R2) — faithful to the signed-off hi-fi
 * (`docs/mockups-hifi.html`, `#screen-detail`): the breadcrumb
 * (`Overview / Components / {hier path} / {component}`), the title + subtitle, and the tab
 * set. The tabs that available data supports are BUILT for real:
 *   - **Health**    — liveness/state + the runtime attributes (cpu / memory / threads·fds /
 *                     uptime) + the console-computed health checks;
 *   - **Instances** — every instance of the (device, component) from the identity `instance`
 *                     token;
 *   - **Configuration** — an embedded read-only view of the component's effective `cfg`
 *                     (from the ConfigStore), with a link to the full Configuration screen;
 *   - **Events**    — this component's filtered `evt`/alarm slice, with a link to Events & Alarms.
 *
 * The component-specific tabs the mockup also shows depend on the DEFERRED `describe`/panels
 * capability manifest, so they are rendered as an honest present-but-pending state, never
 * fabricated:
 *   - **Panel** (+ the opcua **Overview / Address Space / Signals / Diagnostics** sub-tabs);
 *   - **Logs** (the UNS `log` class — no LogStore ships yet);
 *   - the component's implementation **language** + app **version** (subtitle) and its custom
 *     command surface / **Capabilities** — all need the manifest.
 *
 * `ComponentDetailView` is purely presentational (state in, DOM out — component-testable
 * without a socket); `ConnectedComponentDetailView` binds it to the shared {@link FleetClient}
 * and owns the config request / event subscription lifecycle.
 */
import { useEffect } from "react";
import {
  Button,
  InlineLoading,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  Tile,
} from "@carbon/react";
import { ArrowRight, CircleFilled } from "@carbon/react/icons";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import type { ComponentView } from "../fleet/store";
import { formatDurationMs, formatDurationSecs } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { Sparkline } from "../common/Sparkline";
import { StatusTag } from "../health/StatusTag";
import { CommandToasts } from "../health/CommandToasts";
import type { InvokeCommand } from "../health/EdgeHealthView";
import { SeverityTag } from "../events/EventsView";
import { formatClockTime, summarizeBody } from "../events/selectors";
import { effectiveConfig, flattenConfig, redactionCounts } from "../configreview/selectors";
import type { HealthCheck } from "./detail-selectors";
import {
  alarmsForComponent,
  componentDetailPath,
  detailSubtitleParts,
  detailUptimeSecs,
  healthChecks,
  instancesOf,
} from "./detail-selectors";
import { findComponent } from "./components-tree";

/** A no-op command seam (presentational tests without a live client). */
const NO_INVOKE: InvokeCommand = () => undefined;

/** The honest Phase-2 pending panel for the describe/panels-dependent surfaces. */
function PhaseTwoPending({
  feature,
  needs,
  testId,
  children,
}: {
  feature: string;
  needs: string;
  testId: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="ec-pending" data-testid={testId}>
      <div className="ec-pending__badge">Available in Phase 2</div>
      <h3 className="ec-pending__title">{feature}</h3>
      <p className="ec-dim">
        This surface is driven by the component&apos;s <code>{needs}</code>, which is deferred to
        Phase 2. The console does not fabricate it — it lights up once components advertise the
        manifest over the bus.
      </p>
      {children}
    </div>
  );
}

/** The Health tab's console-computed "health checks" structured list. */
function HealthChecks({ checks }: { checks: HealthCheck[] }): React.JSX.Element {
  const toneTag = (c: HealthCheck) => {
    if (c.tone === "plain") return <span className="ec-mono">{c.value}</span>;
    const type = c.tone === "ok" ? "green" : c.tone === "err" ? "red" : c.tone === "unknown" ? "gray" : undefined;
    const className = c.tone === "warn" ? "ec-tag ec-tag--warn" : "ec-tag";
    return (
      <Tag size="sm" {...(type !== undefined ? { type } : {})} className={className}>
        {c.value}
      </Tag>
    );
  };
  return (
    <div className="ec-slist" data-testid="health-checks">
      <div className="ec-slist__r ec-slist__r--hd">
        <span className="ec-slist__k">Health checks</span>
        <span className="ec-slist__v ec-dim">computed by console</span>
      </div>
      {checks.map((c) => (
        <div className="ec-slist__r" key={c.label} data-testid={`health-check-${c.label.replace(/[^a-z]/gi, "-")}`}>
          <span className="ec-slist__k">{c.label}</span>
          <span className="ec-slist__v">{toneTag(c)}</span>
        </div>
      ))}
    </div>
  );
}

/** The Health tab. */
function HealthTab({
  comp,
  attrs,
  openAlarms,
  nowServerMs,
}: {
  comp: ComponentView;
  attrs: ClientState["attributes"]["byId"][string] | undefined;
  openAlarms: number;
  nowServerMs: number;
}): React.JSX.Element {
  const cpuSeries = attrs?.cpuSeries;
  const uptimeSecs = detailUptimeSecs(comp, nowServerMs);
  const lastState =
    comp.lastStateAt !== undefined
      ? `${formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt))} ago`
      : "no state yet";
  return (
    <>
      <div className="ec-tiles" data-testid="health-tiles">
        <Tile className="ec-tile">
          <div className="ec-tile__label">
            CPU{" "}
            {attrs?.cpuPercent !== undefined && (
              <Tag size="sm" type="blue" className="ec-tag" renderIcon={CircleFilled}>
                live
              </Tag>
            )}
          </div>
          <div className="ec-tile__busrow">
            <div className="ec-tile__num ec-tile__num--md ec-tnum">
              {attrs?.cpuPercent !== undefined ? `${Math.round(attrs.cpuPercent)}%` : <span className="ec-dim">—</span>}
            </div>
            {cpuSeries !== undefined && cpuSeries.length > 1 && (
              <Sparkline
                points={cpuSeries.map((value, at) => ({ at, value }))}
                width={80}
                height={28}
                ariaLabel={`${comp.key.component} cpu trend`}
                formatValue={(v) => `${Math.round(v)}%`}
              />
            )}
          </div>
        </Tile>
        <Tile className="ec-tile">
          <div className="ec-tile__label">Memory</div>
          <div className="ec-tile__num ec-tile__num--md ec-tnum">
            {attrs?.memoryMb !== undefined ? (
              <>
                {Math.round(attrs.memoryMb)}
                <small>MB</small>
              </>
            ) : (
              <span className="ec-dim">—</span>
            )}
          </div>
        </Tile>
        <Tile className="ec-tile">
          <div className="ec-tile__label">Threads / FDs</div>
          <div className="ec-tile__num ec-tile__num--md ec-tnum">
            {attrs?.threads !== undefined || attrs?.fds !== undefined ? (
              `${attrs?.threads ?? "—"} / ${attrs?.fds ?? "—"}`
            ) : (
              <span className="ec-dim">—</span>
            )}
          </div>
          <div className="ec-tile__foot">fds n/a on some platforms</div>
        </Tile>
        <Tile className="ec-tile">
          <div className="ec-tile__label">Uptime</div>
          <div className="ec-tile__num ec-tile__num--md ec-tnum" data-testid="health-uptime">
            {uptimeSecs !== undefined ? formatDurationSecs(uptimeSecs) : <span className="ec-dim">—</span>}
          </div>
          <div className="ec-tile__foot">
            {comp.restarts > 0 ? `${comp.restarts} restart${comp.restarts === 1 ? "" : "s"} observed` : "no restarts observed"}
          </div>
        </Tile>
      </div>

      <div className="ec-detail-2col">
        <div className="ec-chartbox">
          <div className="ec-chartbox__ct">
            Liveness{" "}
            <Tag size="sm" type="blue" className="ec-tag" renderIcon={CircleFilled}>
              live
            </Tag>
          </div>
          <div className="ec-liveness-state" data-testid="liveness-state">
            <StatusTag liveness={comp.liveness} size="md" />
            <span className="ec-dim">
              last state {lastState} · expected ~{comp.expectedIntervalSecs}s ({comp.cadenceSource})
            </span>
          </div>
          <p className="ec-dim ec-detail-note">
            The console tracks liveness from the <code>state</code> keepalive miss-detection
            ladder. The full per-arrival heartbeat timeline the mockup sketches needs a retained
            arrival history the console does not keep — the current liveness is the honest datum.
          </p>
        </div>
        <HealthChecks checks={healthChecks(comp, attrs, openAlarms)} />
      </div>
    </>
  );
}

/** The Instances tab (from the identity `instance` token). */
function InstancesTab({
  instances,
  nowServerMs,
}: {
  instances: ComponentView[];
  nowServerMs: number;
}): React.JSX.Element {
  return (
    <div className="ec-slist" data-testid="instances-list">
      <div className="ec-slist__r ec-slist__r--hd">
        <span className="ec-slist__k">Instance</span>
        <span className="ec-slist__v ec-dim">status · last state</span>
      </div>
      {instances.map((inst) => (
        <div className="ec-slist__r" key={inst.id} data-testid={`instance-${inst.key.instance}`}>
          <span className="ec-slist__k ec-mono">{inst.key.instance}</span>
          <span className="ec-slist__v ec-instance-status">
            <StatusTag liveness={inst.liveness} size="sm" />
            <span className="ec-dim ec-mono">
              {inst.lastStateAt !== undefined
                ? `${formatDurationMs(Math.max(0, nowServerMs - inst.lastStateAt))} ago`
                : "—"}
            </span>
          </span>
        </div>
      ))}
      {instances.length === 1 && (
        <p className="ec-dim ec-detail-note">
          A single instance (<span className="ec-mono">{instances[0]!.key.instance}</span>). Multi-instance
          components (e.g. one adapter per upstream server) list every instance here.
        </p>
      )}
    </div>
  );
}

/** The embedded read-only Configuration tab. */
function ConfigTab({
  entry,
  onViewConfig,
}: {
  entry: ClientState["configs"]["entriesById"][string] | undefined;
  onViewConfig?: () => void;
}): React.JSX.Element {
  const link = onViewConfig !== undefined && (
    <Button kind="ghost" size="sm" renderIcon={ArrowRight} data-testid="view-full-config" onClick={onViewConfig}>
      Open in Configuration review
    </Button>
  );

  if (entry === undefined || entry.phase === "loading") {
    return (
      <div data-testid="config-embed">
        <Tile className="ec-empty">
          <InlineLoading description="Requesting effective configuration…" />
        </Tile>
        {link}
      </div>
    );
  }
  if (entry.phase === "unavailable") {
    return (
      <div data-testid="config-embed">
        <Tile className="ec-empty" data-testid="config-embed-unavailable">
          <h3>No configuration received</h3>
          <p className="ec-dim">
            The console holds no <code>cfg</code> announcement for this component yet.{" "}
            <b>Refresh</b> from the full Configuration screen asks its device to re-announce.
          </p>
        </Tile>
        {link}
      </div>
    );
  }
  const rows = flattenConfig(effectiveConfig(entry.body));
  const counts = redactionCounts(rows);
  return (
    <div data-testid="config-embed">
      <div className="ec-detail-head__actions ec-detail-head__actions--right">
        {counts.redacted > 0 && (
          <span className="ec-dim">
            {counts.redacted} value{counts.redacted === 1 ? "" : "s"} redacted at the source
          </span>
        )}
        {link}
      </div>
      {rows.length === 0 ? (
        <p className="ec-dim">The announced configuration is empty.</p>
      ) : (
        <div className="ec-cfg-rows" data-testid="config-embed-rows">
          {rows.map((row) => (
            <div className="ec-cfg-row" key={row.path}>
              <span className="ec-cfg-row__k ec-mono">{row.path}</span>
              <span className="ec-cfg-row__v ec-mono">
                {row.kind === "redacted" ? (
                  <span className="ec-redacted">
                    ●●●●●●
                    <Tag size="sm" type="red" className="ec-tag">
                      redacted
                    </Tag>
                  </span>
                ) : row.kind === "secret-ref" ? (
                  <>
                    {row.display}
                    <Tag size="sm" type="outline" className="ec-tag">
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
      )}
    </div>
  );
}

/** The Events tab — this component's filtered evt/alarm slice. */
function EventsTab({
  comp,
  events,
  activeAlarms,
  nowServerMs,
  onOpenEvents,
}: {
  comp: ComponentView;
  events: ClientState["events"]["entries"];
  activeAlarms: number;
  nowServerMs: number;
  onOpenEvents?: () => void;
}): React.JSX.Element {
  const id = comp.id;
  const mine = events.filter((e) => componentKeyId(e.key) === id).slice(0, 50);
  const link = onOpenEvents !== undefined && (
    <Button kind="ghost" size="sm" renderIcon={ArrowRight} data-testid="view-full-events" onClick={onOpenEvents}>
      Open in Events &amp; Alarms
    </Button>
  );
  return (
    <div data-testid="events-embed">
      <div className="ec-detail-head__actions ec-detail-head__actions--right">
        <span className="ec-dim">
          {activeAlarms} open alarm{activeAlarms === 1 ? "" : "s"} · {mine.length} recent event
          {mine.length === 1 ? "" : "s"}
        </span>
        {link}
      </div>
      {mine.length === 0 ? (
        <Tile className="ec-empty" data-testid="events-embed-empty">
          <p className="ec-dim">
            No recent <code>evt</code> from this component. Events appear the moment it publishes
            on its <code>evt</code> class — nothing is polled.
          </p>
        </Tile>
      ) : (
        <div className="ec-slist" data-testid="events-embed-list">
          {mine.map((e) => (
            <div className="ec-slist__r ec-evt-embed-row" key={e.id} data-testid={`events-embed-row-${e.id}`}>
              <span className="ec-evt-embed-row__lead">
                <SeverityTag event={e} />
                <span className="ec-mono ec-tnum ec-dim">{formatClockTime(e.receivedAt)}</span>
              </span>
              <span className="ec-evt-embed-row__body">
                <span className="ec-pri">{e.type}</span>
                <span className="ec-dim"> {summarizeBody(e.body)}</span>
              </span>
              <span className="ec-dim ec-tnum ec-evt-embed-row__age">
                {formatDurationMs(Math.max(0, nowServerMs - e.receivedAt))} ago
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ComponentDetailViewProps {
  state: ClientState;
  now: number;
  detailKey: ComponentKey;
  /** Back to the Components screen (breadcrumb "Components"). */
  onBack?: () => void;
  /** To the Overview screen (breadcrumb "Overview"). */
  onOpenOverview?: () => void;
  /** To the full Configuration screen (header "View config" + the config tab link). */
  onViewConfig?: () => void;
  /** To the Events & Alarms screen (the events tab link). */
  onOpenEvents?: () => void;
  /** Fire a C4 command (the header Ping / Query status); defaults to a no-op. */
  onInvoke?: InvokeCommand;
}

export function ComponentDetailView({
  state,
  now,
  detailKey,
  onBack,
  onOpenOverview,
  onViewConfig,
  onOpenEvents,
  onInvoke = NO_INVOKE,
}: ComponentDetailViewProps): React.JSX.Element {
  const { fleet, attributes, alarms } = state;
  const nowServerMs = now - fleet.clockOffsetMs;
  const comp = findComponent(fleet, detailKey);
  const id = componentKeyId(detailKey);

  const crumbs = (
    <div className="ec-crumbs" data-testid="detail-crumbs">
      <a role="link" tabIndex={0} data-testid="crumb-overview" onClick={() => onOpenOverview?.()}>
        Overview
      </a>
      <span className="ec-crumbs__sep">/</span>
      <a role="link" tabIndex={0} data-testid="crumb-components" onClick={() => onBack?.()}>
        Components
      </a>
      {(comp !== undefined ? componentDetailPath(comp) : [detailKey.device]).map((seg) => (
        <span key={seg} className="ec-crumbs__mid">
          <span className="ec-crumbs__sep">/</span>
          <span>{seg}</span>
        </span>
      ))}
      <span className="ec-crumbs__sep">/</span>
      <b>{detailKey.component}</b>
    </div>
  );

  if (comp === undefined) {
    return (
      <div className="ec-detail">
        {crumbs}
        <h1 className="ec-ph">{detailKey.component}</h1>
        <Tile className="ec-empty" data-testid="detail-not-found">
          <h3>Component no longer in the fleet</h3>
          <p className="ec-dim">
            <span className="ec-mono">{id}</span> is not in the current fleet view — it may have
            been undiscovered after a console restart, or dropped off the bus.{" "}
            <a role="link" tabIndex={0} onClick={() => onBack?.()}>
              Back to Components
            </a>
            .
          </p>
        </Tile>
      </div>
    );
  }

  const instances = instancesOf(fleet, detailKey);
  const openAlarms = alarmsForComponent(alarms.active, detailKey);
  const attrs = attributes.byId[id];
  const configEntry = state.configs.entriesById[id];
  const subtitle = detailSubtitleParts(comp, attrs, instances.length, nowServerMs);

  return (
    <div className="ec-detail">
      {crumbs}
      <div className="ec-detail-head">
        <div>
          <h1 className="ec-ph">
            {comp.key.component} <StatusTag liveness={comp.liveness} size="md" />
          </h1>
          <div className="ec-ph-sub">
            <span>{subtitle.join(" · ")}</span>
            <Tag size="sm" type="outline" className="ec-tag" title="needs the deferred describe/panels manifest">
              language · version pending (describe)
            </Tag>
          </div>
        </div>
        <div className="ec-detail-head__actions">
          <Button kind="ghost" size="sm" onClick={() => onInvoke(comp.key, "ping")}>
            Ping
          </Button>
          <Button kind="ghost" size="sm" onClick={() => onInvoke(comp.key, "get-configuration")}>
            Query status
          </Button>
          <Button kind="secondary" size="sm" data-testid="detail-view-config" onClick={() => onViewConfig?.()}>
            View config
          </Button>
        </div>
      </div>

      <Tabs>
        <TabList aria-label="Component detail" className="ec-detail-tabs">
          <Tab data-testid="tab-health">Health</Tab>
          <Tab data-testid="tab-panel">Panel</Tab>
          <Tab data-testid="tab-instances">Instances{instances.length > 1 ? ` · ${instances.length}` : ""}</Tab>
          <Tab data-testid="tab-config">Configuration</Tab>
          <Tab data-testid="tab-events">Events</Tab>
          <Tab data-testid="tab-logs">Logs</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <HealthTab comp={comp} attrs={attrs} openAlarms={openAlarms.length} nowServerMs={nowServerMs} />
          </TabPanel>
          <TabPanel>
            <PhaseTwoPending feature="Component panels" needs="describe / panels manifest" testId="phase2-panel">
              <div className="ec-subtabs ec-subtabs--pending" data-testid="panel-subtabs" aria-disabled="true">
                <span>Overview</span>
                <span>Address Space</span>
                <span>Signals</span>
                <span>Diagnostics</span>
              </div>
              <p className="ec-dim">
                The mockup&apos;s opcua sub-tabs (Overview / Address Space / Signals / Diagnostics)
                are descriptor-driven panels bound to component command verbs (e.g.{" "}
                <span className="ec-mono">cmd/sb.browse</span>). They render here once the component
                advertises its panel descriptors.
              </p>
            </PhaseTwoPending>
          </TabPanel>
          <TabPanel>
            <InstancesTab instances={instances} nowServerMs={nowServerMs} />
          </TabPanel>
          <TabPanel>
            <ConfigTab entry={configEntry} {...(onViewConfig !== undefined ? { onViewConfig } : {})} />
          </TabPanel>
          <TabPanel>
            <EventsTab
              comp={comp}
              events={state.events.entries}
              activeAlarms={openAlarms.length}
              nowServerMs={nowServerMs}
              {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
            />
          </TabPanel>
          <TabPanel>
            <PhaseTwoPending feature="Log tail" needs="log class surface" testId="phase2-logs">
              <p className="ec-dim">
                The UNS <code>log</code> class is one of the six consumer classes, but the console
                ships no LogStore yet — the mockup&apos;s <span className="ec-mono">cmd/get-log-tail</span>{" "}
                live-follow lands with the log surface in a later slice.
              </p>
            </PhaseTwoPending>
          </TabPanel>
        </TabPanels>
      </Tabs>
      <CommandToasts commands={state.commands} />
    </div>
  );
}

/**
 * The live container: binds the detail to the shared {@link FleetClient}. It requests the
 * component's effective cfg (the embedded Configuration tab) and subscribes the event stream
 * (the Events tab) while mounted — both keyed on the connection status, so a reconnect
 * re-issues them (server-side interest is per-connection). Unmounting unsubscribes events.
 */
export function ConnectedComponentDetailView({
  client,
  detailKey,
  onBack,
  onOpenOverview,
  onViewConfig,
  onOpenEvents,
}: {
  client: FleetClient;
  detailKey: ComponentKey;
  onBack?: () => void;
  onOpenOverview?: () => void;
  onViewConfig?: () => void;
  onOpenEvents?: () => void;
}): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const status = state.status;
  const keyId = componentKeyId(detailKey);

  useEffect(() => {
    // keyId (not the object) keys the effect so a same-identity re-render doesn't re-request.
    if (status === "connected") client.requestConfig(detailKey);
  }, [client, keyId, status, detailKey]);

  useEffect(() => {
    if (status === "connected") client.subscribeEvents();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeEvents(), [client]);

  return (
    <ComponentDetailView
      state={state}
      now={now}
      detailKey={detailKey}
      onInvoke={(key, verb, args) => client.invokeCommand(key, verb, args)}
      {...(onBack !== undefined ? { onBack } : {})}
      {...(onOpenOverview !== undefined ? { onOpenOverview } : {})}
      {...(onViewConfig !== undefined ? { onViewConfig } : {})}
      {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
    />
  );
}
