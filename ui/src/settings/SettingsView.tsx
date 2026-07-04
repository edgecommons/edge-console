/**
 * The Settings view (slice R6) — the mockup's "Settings" screen: the console's OWN effective
 * policy + configuration, READ-ONLY. Faithful to the signed-off hi-fi (`docs/mockups-hifi.html`
 * `#screen-settings`, "Console policy"): the mockup's structured `.slist` idiom (rendered as the
 * shared `ec-slist`), expanded — per the R6 mandate — to surface everything the console genuinely
 * holds about itself: the RBAC policy (roles + per-verb allow/deny + the default role, with the
 * current viewer's role highlighted), the site-bus connection + the WS gateway, the miss-detection
 * thresholds, the command deadlines (incl. the bridge reply-map TTL), and the store-retention caps.
 *
 * HONEST about read-only-now vs staged vs pending, the discipline held through R1–R5:
 *  - everything above is REAL, sourced from the `settings` frame (the console's parsed
 *    `component.global.console` + its static self-identity) and shown as read-only lists;
 *  - the mockup's "Site-map (thing → line)" editor is STAGED: grouping is identity-driven today
 *    (each component's UNS identity carries its own placement), so the console shows the
 *    identity-derived map read-only and flags a manual override as a later-phase editor — no
 *    fake editable widget;
 *  - the mockup's "Global read-only mode" is likewise a STAGED editor (not a console setting yet —
 *    RBAC above is the real write-access control);
 *  - the mockup's "Panel trust policy" and "Redaction rules" are flagged PENDING (the console does
 *    not consume `describe`/panels, and redaction happens at the source in each component's
 *    library) — surfaced as not-yet-held rather than invented.
 *
 * `SettingsView` is purely presentational (state in, DOM out); `ConnectedSettingsView` binds it to
 * the shared {@link FleetClient} (the `settings` frame already arrives on connect — no subscribe).
 */
import { Button, InlineLoading, InlineNotification, Tag, Tile } from "@carbon/react";
import { Edit } from "@carbon/react/icons";
import type { ConsoleSettings, ConsoleSettingsRole } from "@edgecommons/edge-console-protocol";
import type { ClientState, FleetClient } from "../fleet/client";
import { useFleetState } from "../fleet/useFleet";
import { formatMs, siteMap, stalenessSummary } from "./selectors";

/** A structured list (the mockup's `.slist`) — a bordered card of key/value rows. */
function SList({ children, testId }: { children: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <div className="ec-slist" data-testid={testId}>
      {children}
    </div>
  );
}

/** One structured-list row (key on the left, value node on the right; `head` styles a header row). */
function SRow({
  label,
  children,
  head,
  testId,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  head?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <div className={`ec-slist__r${head ? " ec-slist__r--hd" : ""}`} data-testid={testId}>
      <span className="ec-slist__k">{label}</span>
      <span className="ec-slist__v">{children}</span>
    </div>
  );
}

/** A section heading + optional explanatory note. */
function Section({
  title,
  note,
  badge,
  children,
  testId,
}: {
  title: string;
  note?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section className="ec-settings__section" data-testid={testId}>
      <h2 className="ec-settings__h">
        {title}
        {badge}
      </h2>
      {note !== undefined && <p className="ec-settings__note ec-dim">{note}</p>}
      {children}
    </section>
  );
}

/** The "editing lands in a later phase" affordance — a clearly-disabled editor surface. */
function StagedEditor({ label, testId }: { label: string; testId: string }): React.JSX.Element {
  return (
    <Button
      kind="ghost"
      size="sm"
      renderIcon={Edit}
      disabled
      data-testid={testId}
      title="Read-only in this phase — the editor lands in a later phase."
    >
      {label}
    </Button>
  );
}

/** A monospace value, or an honest em dash + "pending" tag when the console does not hold it. */
function ValueOrPending({
  value,
  pendingTitle,
  testId,
}: {
  value: string | undefined;
  pendingTitle: string;
  testId?: string;
}): React.JSX.Element {
  if (value !== undefined && value !== "") {
    return (
      <span className="ec-mono" data-testid={testId}>
        {value}
      </span>
    );
  }
  return (
    <span className="ec-settings__pending" data-testid={testId}>
      <span className="ec-dim">—</span>
      <Tag size="sm" type="outline" className="ec-tag" title={pendingTitle}>
        not announced
      </Tag>
    </span>
  );
}

/** The per-verb allow/deny chips for one role (allow green, deny red; `*` shown as "all verbs"). */
function RolePolicy({ role }: { role: ConsoleSettingsRole }): React.JSX.Element {
  const allow = role.allow.length === 0 ? [] : role.allow;
  return (
    <span className="ec-settings__verbs" data-testid={`settings-role-verbs-${role.name}`}>
      {allow.length === 0 ? (
        <Tag size="sm" type="cool-gray" className="ec-tag" title="this role may invoke no verbs">
          none
        </Tag>
      ) : (
        allow.map((verb) => (
          <Tag key={`a-${verb}`} size="sm" type="green" className="ec-tag ec-mono">
            {verb === "*" ? "all verbs (*)" : verb}
          </Tag>
        ))
      )}
      {role.deny.map((verb) => (
        <Tag key={`d-${verb}`} size="sm" type="red" className="ec-tag ec-mono" title="denied (wins over allow)">
          deny {verb === "*" ? "*" : verb}
        </Tag>
      ))}
    </span>
  );
}

/** The RBAC / access-policy section: default role + your role + per-role allow/deny. */
function RbacSection({
  rbac,
  currentRole,
}: {
  rbac: ConsoleSettings["rbac"];
  currentRole: string | undefined;
}): React.JSX.Element {
  const currentIsDeclared =
    currentRole !== undefined && rbac.roles.some((r) => r.name === currentRole);
  return (
    <Section
      title="Access policy"
      testId="settings-rbac"
      note={
        <>
          Config-driven allow/deny of command verbs per role (<code>console.rbac</code>). Deny wins
          over allow; <code>*</code> is the all-verbs wildcard. This gates the command write-path;
          the read surface is currently unauthenticated, and role resolution is still stubbed to the
          default below (no bearer/mTLS/OIDC yet).
        </>
      }
    >
      <SList testId="settings-rbac-list">
        <SRow label="Role" head>
          <span className="ec-dim">allowed · denied verbs</span>
        </SRow>
        {rbac.roles.map((role) => {
          const isCurrent = role.name === currentRole;
          return (
            <SRow
              key={role.name}
              testId={`settings-role-${role.name}`}
              label={
                <span className={`ec-settings__role${isCurrent ? " ec-settings__role--you" : ""}`}>
                  <span className="ec-pri ec-mono">{role.name}</span>
                  {role.isDefault && (
                    <Tag size="sm" type="blue" className="ec-tag" title="the fallback role for an unauthenticated connection">
                      default
                    </Tag>
                  )}
                  {isCurrent && (
                    <Tag size="sm" type="teal" className="ec-tag" data-testid={`settings-role-you-${role.name}`} title="your connection's resolved role">
                      your role
                    </Tag>
                  )}
                </span>
              }
            >
              <RolePolicy role={role} />
            </SRow>
          );
        })}
      </SList>
      <p className="ec-settings__note ec-dim" data-testid="settings-your-role">
        Your connection&apos;s role:{" "}
        {currentRole !== undefined ? (
          <>
            <b className="ec-mono">{currentRole}</b>
            {!currentIsDeclared && (
              <>
                {" "}
                <Tag size="sm" type="outline" className="ec-tag" title="resolved role is not one of the declared roles — fail-closed (no verbs)">
                  undeclared — fail-closed
                </Tag>
              </>
            )}
          </>
        ) : (
          <span className="ec-dim">not yet resolved</span>
        )}
        .
      </p>
    </Section>
  );
}

/** The site-bus connection + the console's own WS gateway. */
function ConnectionSection({ conn }: { conn: ConsoleSettings["connection"] }): React.JSX.Element {
  return (
    <Section
      title="Connection"
      testId="settings-connection"
      note="The console's one bus connection — the site broker — and its own browser-facing WS gateway."
    >
      <SList testId="settings-connection-list">
        <SRow label="Console node" testId="settings-conn-node">
          {conn.device !== undefined ? (
            <>
              <span className="ec-pri ec-mono">{conn.device}</span>
              {conn.component !== undefined && (
                <Tag size="sm" type="outline" className="ec-tag ec-mono">
                  {conn.component}
                </Tag>
              )}
            </>
          ) : (
            <ValueOrPending value={undefined} pendingTitle="the console did not announce its identity" />
          )}
        </SRow>
        <SRow label="Deployment platform">
          <ValueOrPending value={conn.platform} pendingTitle="platform not announced by the console" testId="settings-conn-platform" />
        </SRow>
        <SRow label="Site-bus transport">
          <ValueOrPending value={conn.transport} pendingTitle="transport not announced by the console" testId="settings-conn-transport" />
        </SRow>
        <SRow label="Site broker">
          <ValueOrPending value={conn.broker} pendingTitle="the console holds no messaging.local.host (e.g. IPC transport)" testId="settings-conn-broker" />
        </SRow>
        <SRow label="WS gateway" testId="settings-conn-ws">
          <span className="ec-mono">
            {conn.wsBindAddress}:{conn.wsPort}/ws
          </span>
        </SRow>
        <SRow label="Heartbeat cadence" testId="settings-conn-heartbeat">
          <span className="ec-mono">{formatMs(conn.heartbeatIntervalMs)}</span>
        </SRow>
      </SList>
    </Section>
  );
}

/** The miss-detection ladder + command deadlines + store retention (the numeric knobs). */
function KnobsSections({ settings }: { settings: ConsoleSettings }): React.JSX.Element {
  const { staleness, commands, retention } = settings;
  return (
    <>
      <Section
        title="Miss-detection thresholds"
        testId="settings-thresholds"
        note={
          <>
            The staleness ladder that decides each component&apos;s liveness (DESIGN §6.2). Cadence is
            per-component — a component&apos;s <code>cfg</code>-announced keepalive interval when it has
            one, else the default below.
          </>
        }
      >
        <SList testId="settings-thresholds-list">
          <SRow label="Staleness ladder" testId="settings-staleness">
            <span className="ec-mono">{stalenessSummary(staleness)}</span>
          </SRow>
          <SRow label="Default keepalive interval" testId="settings-cadence">
            <span className="ec-mono">{staleness.defaultIntervalSecs} s</span>
          </SRow>
          <SRow label="Liveness sweep" testId="settings-sweep">
            <span className="ec-mono">{formatMs(staleness.sweepIntervalMs)}</span>
          </SRow>
        </SList>
      </Section>

      <Section
        title="Command deadlines"
        testId="settings-commands"
        note={
          <>
            Per-command timeouts for the write-path (<code>console.commands</code>); every deadline is
            capped at the uns-bridge reply-map TTL (the ceiling below).
          </>
        }
      >
        <SList testId="settings-commands-list">
          <SRow label="Default deadline" testId="settings-cmd-default">
            <span className="ec-mono">{formatMs(commands.defaultTimeoutMs)}</span>
          </SRow>
          <SRow label="Reply-map TTL (ceiling)" testId="settings-cmd-ttl">
            <span className="ec-mono">{formatMs(commands.maxTimeoutMs)}</span>
          </SRow>
          {commands.verbTimeouts.map(({ verb, ms }) => (
            <SRow key={verb} label={`${verb} deadline`} testId={`settings-cmd-verb-${verb}`}>
              <span className="ec-mono">{formatMs(ms)}</span>
            </SRow>
          ))}
        </SList>
      </Section>

      <Section
        title="Store retention"
        testId="settings-retention"
        note="In-memory caps for the last-known-value cache and the rolling activity history (the retain substitute); overflow is drop-oldest and counted."
      >
        <SList testId="settings-retention-list">
          <SRow label="Channels per component" testId="settings-ret-channels">
            <span className="ec-mono">{retention.maxChannelsPerComponent}</span>
          </SRow>
          <SRow label="Recent events (fleet)" testId="settings-ret-events">
            <span className="ec-mono">{retention.maxEvents}</span>
          </SRow>
          <SRow label="Recent events per component" testId="settings-ret-events-comp">
            <span className="ec-mono">{retention.maxPerComponent}</span>
          </SRow>
          <SRow label="Metric series points" testId="settings-ret-points">
            <span className="ec-mono">{retention.maxSeriesPoints}</span>
          </SRow>
          <SRow label="Max metric series" testId="settings-ret-series">
            <span className="ec-mono">{retention.maxSeries}</span>
          </SRow>
        </SList>
      </Section>
    </>
  );
}

/** The site-map (thing → line): identity-derived read-only, manual override staged. */
function SiteMapSection({ state }: { state: ClientState }): React.JSX.Element {
  const map = siteMap(state.fleet);
  const hierarchy = map.levelNames.length > 0 ? map.levelNames.join(" → ") : "not yet known";
  const flat = map.groupingLevel === undefined;
  const columnLabel = map.groupingLevel ?? "line";
  return (
    <Section
      title="Site-map (thing → line)"
      testId="settings-sitemap"
      badge={
        <Tag size="sm" type="outline" className="ec-tag ec-settings__staged" data-testid="settings-sitemap-staged">
          staged editor
        </Tag>
      }
      note={
        <>
          Grouping is identity-driven today: each component&apos;s UNS identity hierarchy carries its
          own placement, so the console <b>reads</b> the thing → line map from the running fleet — no
          stored site-map is needed. A manual override (renaming or regrouping) is a later-phase
          editor.
        </>
      }
    >
      <div className="ec-settings__hier" data-testid="settings-hierarchy">
        Identity hierarchy: <b className="ec-mono">{hierarchy}</b>
        {map.site !== undefined && (
          <>
            {" "}
            · site <b className="ec-mono">{map.site}</b>
          </>
        )}
      </div>
      {map.entries.length === 0 ? (
        <p className="ec-dim ec-settings__note" data-testid="settings-sitemap-empty">
          No components discovered yet — the map fills in as the fleet announces its identities.
        </p>
      ) : (
        <SList testId="settings-sitemap-list">
          <SRow label="Device" head>
            <span className="ec-dim">{flat ? "placement" : columnLabel}</span>
          </SRow>
          {map.entries.map((entry) => (
            <SRow key={entry.device} label={<span className="ec-pri ec-mono">{entry.device}</span>} testId={`settings-sitemap-${entry.device}`}>
              {entry.path.length > 0 ? (
                <span className="ec-mono">{entry.path.map((p) => p.value).join(" / ")}</span>
              ) : (
                <span className="ec-dim" title="no intermediate tier — this device sits directly under the site">
                  direct under site
                </span>
              )}
            </SRow>
          ))}
        </SList>
      )}
      <div className="ec-settings__editrow">
        <StagedEditor label="Edit mapping ▸" testId="settings-sitemap-edit" />
        <span className="ec-dim ec-settings__note">
          Read-only — a manual thing → line override lands in a later phase.
        </span>
      </div>
    </Section>
  );
}

/** The remaining mockup policy rows: honestly staged (read-only mode) or pending (panel trust / redaction). */
function AdditionalPolicySection(): React.JSX.Element {
  return (
    <Section
      title="Additional policy"
      testId="settings-additional"
      note="The remaining Settings rows from the mockup — surfaced honestly: what the console does not yet hold is flagged pending, and the one control that has no wiring yet is a staged editor (not a fake toggle)."
    >
      <SList testId="settings-additional-list">
        <SRow label="Global read-only mode" testId="settings-readonly">
          <StagedEditor label="off ▸" testId="settings-readonly-edit" />
          <Tag size="sm" type="outline" className="ec-tag ec-settings__staged">
            staged editor
          </Tag>
        </SRow>
        <SRow label="Panel trust policy" testId="settings-panel-trust">
          <span className="ec-dim">—</span>
          <Tag
            size="sm"
            type="outline"
            className="ec-tag"
            title="the console does not consume the describe/panels capability surface yet — panel trust is not a console setting today"
          >
            pending — not held
          </Tag>
        </SRow>
        <SRow label="Redaction rules" testId="settings-redaction">
          <span className="ec-dim">—</span>
          <Tag
            size="sm"
            type="outline"
            className="ec-tag"
            title="redaction happens at the source inside each component's library (cfg values are masked before publish) — the console holds no redaction ruleset"
          >
            source-side — none held
          </Tag>
        </SRow>
      </SList>
      <p className="ec-settings__note ec-dim">
        Global read-only mode is not wired yet — the <b>Access policy</b> above (RBAC) is the real
        write-access control today.
      </p>
    </Section>
  );
}

export interface SettingsViewProps {
  state: ClientState;
}

export function SettingsView({ state }: SettingsViewProps): React.JSX.Element {
  const { settings, status, fatalError, role } = state;

  return (
    <div className="ec-settings">
      <h1 className="ec-ph">Settings</h1>
      <div className="ec-ph-sub">
        <span>
          The console&apos;s own effective policy &amp; configuration — read from{" "}
          <code>component.global.console</code>. Read-only; editors land in a later phase.
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

      {settings === undefined ? (
        <Tile className="ec-empty" data-testid="settings-empty">
          {fatalError === undefined && (status === "connecting" || status === "reconnecting") ? (
            <InlineLoading description="Connecting to the console gateway…" />
          ) : (
            <>
              <h3>Console policy not received yet</h3>
              <p className="ec-dim">
                The console pushes its effective policy &amp; configuration right after connect. It
                will appear here as soon as the gateway stream is established.
              </p>
            </>
          )}
        </Tile>
      ) : (
        <div className="ec-settings__grid" data-testid="settings-grid">
          <RbacSection rbac={settings.rbac} currentRole={role} />
          <ConnectionSection conn={settings.connection} />
          <KnobsSections settings={settings} />
          <SiteMapSection state={state} />
          <AdditionalPolicySection />
        </div>
      )}
    </div>
  );
}

/** The live container: the `settings` frame already arrives on connect, so no subscribe is needed. */
export function ConnectedSettingsView({ client }: { client: FleetClient }): React.JSX.Element {
  const state = useFleetState(client);
  return <SettingsView state={state} />;
}
