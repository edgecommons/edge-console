/**
 * The Edge Console UI shell — IBM Carbon, realigned to the signed-off hi-fi mockup (R0).
 *
 * The shell hosts the shipped screens (edge-health / components / topology / events), all fed by
 * ONE shared {@link FleetClient} (one WS connection for the whole app — the shell owns its
 * lifecycle so switching views never drops the socket). R0 adds the mockup's application
 * bar ({@link AppBar}: global search, working g10↔g100 theme toggle, a notifications badge
 * driven by the live active-alarm count, and an account indicator showing the connection's
 * RBAC role) and subscribes the console-side alarm surface once on connect (the badge is
 * global). The off-contract Metrics page was removed; the side rail still carries only the
 * views that exist (Components/Topology/Signals/Settings land with their slices — no dead
 * navigation ships before its view does).
 *
 * The client is created once per app instance from the page-derived WS URL (see
 * `config.ts`) and injectable for tests (jsdom has no WebSocket).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Content,
  SideNav,
  SideNavItems,
  SideNavLink,
  Theme,
} from "@carbon/react";
import { Activity, ChartLine, ChartNetwork, Dashboard, Settings, TreeView } from "@carbon/react/icons";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import { defaultWsUrl } from "./config";
import { FleetClient } from "./fleet/client";
import { useFleetLifecycle, useFleetState } from "./fleet/useFleet";
import { ConnectedEdgeHealthView } from "./health/EdgeHealthView";
import { ConnectedComponentsView } from "./components/ComponentsView";
import { ConnectedComponentDetailView } from "./components/ComponentDetailView";
import { ConnectedTopologyView } from "./topology/TopologyView";
import { ConnectedEventsView } from "./events/EventsView";
import { ConnectedSignalsView, scopeIdFor } from "./signals/SignalsView";
import { ConnectedSettingsView } from "./settings/SettingsView";
import { AppBar } from "./shell/AppBar";
import { SearchContext } from "./shell/search";
import type { SearchState } from "./shell/search";
import { useTheme } from "./shell/theme";

const PERSISTENT_NAV_QUERY = "(min-width: 66rem)";

function hasPersistentNav(): boolean {
  return typeof window === "undefined" ? true : window.matchMedia(PERSISTENT_NAV_QUERY).matches;
}

/** The shell's view routes (one per shipped screen; `detail` is the Components sub-screen). */
type Route =
  | "overview"
  | "components"
  | "detail"
  | "topology"
  | "events"
  | "signals"
  | "settings";

export default function App({ client }: { client?: FleetClient }): React.JSX.Element {
  const fleetClient = useMemo(() => client ?? new FleetClient({ url: defaultWsUrl() }), [client]);
  // The shell owns the one connection: every view reads it, none owns it.
  useFleetLifecycle(fleetClient);
  const state = useFleetState(fleetClient);
  const [theme, toggleTheme] = useTheme();
  const [route, setRoute] = useState<Route>("overview");
  const [query, setQuery] = useState("");
  const [navExpanded, setNavExpanded] = useState(() => hasPersistentNav());
  // The Component Detail target (set by the Components screen / a detail link).
  const [detailKey, setDetailKey] = useState<ComponentKey | undefined>(undefined);
  // The component the Signals screen should open scoped to (set by a Component-Detail
  // "Signals" deep-link); cleared when the side rail opens Signals fleet-wide.
  const [signalsScope, setSignalsScope] = useState<ComponentKey | undefined>(undefined);

  const openDetail = (key: ComponentKey) => {
    setDetailKey(key);
    setRoute("detail");
  };
  const openSignals = (key: ComponentKey) => {
    setSignalsScope(key);
    setRoute("signals");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(PERSISTENT_NAV_QUERY);
    const syncNav = () => setNavExpanded(media.matches);
    syncNav();
    media.addEventListener("change", syncNav);
    return () => media.removeEventListener("change", syncNav);
  }, []);

  // The notifications badge + the Overview columns are global — subscribe the alarm and
  // runtime-attribute surfaces once on connect (server-side interest is per-connection; a
  // fresh snapshot on reconnect self-heals).
  const status = state.status;
  useEffect(() => {
    if (status === "connected") {
      fleetClient.subscribeAlarms();
      fleetClient.subscribeAttributes();
    }
  }, [fleetClient, status]);

  const search = useMemo<SearchState>(() => ({ query, setQuery }), [query]);

  const navigate = (to: Route) => (e: React.MouseEvent) => {
    e.preventDefault();
    // The side rail opens Signals fleet-wide (a Component-Detail deep-link scopes it instead).
    if (to === "signals") setSignalsScope(undefined);
    setRoute(to);
    if (!hasPersistentNav()) setNavExpanded(false);
  };

  return (
    <Theme
      theme={theme}
      className={`ec-app ec-app--${theme === "g100" ? "dark" : "light"}${navExpanded ? "" : " ec-app--nav-collapsed"}`}
    >
      <SearchContext.Provider value={search}>
        <AppBar
          theme={theme}
          onToggleTheme={toggleTheme}
          alarmCount={state.alarms.counts.active}
          {...(state.role !== undefined ? { role: state.role } : {})}
          connected={status === "connected"}
          search={query}
          onSearchChange={setQuery}
          navExpanded={navExpanded}
          onToggleNav={() => setNavExpanded((v) => !v)}
          onOpenNotifications={() => setRoute("events")}
          onOpenAccount={() => setRoute("settings")}
        />
        <SideNav aria-label="Console navigation" isFixedNav expanded isChildOfHeader={false}>
          <SideNavItems>
            <SideNavLink
              renderIcon={Dashboard}
              href="#"
              isActive={route === "overview"}
              onClick={navigate("overview")}
            >
              Overview
            </SideNavLink>
            <SideNavLink
              renderIcon={TreeView}
              href="#"
              isActive={route === "components" || route === "detail"}
              onClick={navigate("components")}
            >
              Components
            </SideNavLink>
            <SideNavLink
              renderIcon={ChartNetwork}
              href="#"
              isActive={route === "topology"}
              onClick={navigate("topology")}
            >
              Site Topology
            </SideNavLink>
            <SideNavLink
              renderIcon={Activity}
              href="#"
              isActive={route === "events"}
              onClick={navigate("events")}
            >
              Events &amp; Alarms
            </SideNavLink>
            <SideNavLink
              renderIcon={ChartLine}
              href="#"
              isActive={route === "signals"}
              onClick={navigate("signals")}
            >
              Signals
            </SideNavLink>
            <SideNavLink
              renderIcon={Settings}
              href="#"
              isActive={route === "settings"}
              onClick={navigate("settings")}
            >
              Settings
            </SideNavLink>
          </SideNavItems>
        </SideNav>
        <Content id="main-content" className={`ec-content ec-content--${route}`}>
          {route === "overview" ? (
            <ConnectedEdgeHealthView client={fleetClient} onOpenEvents={() => setRoute("events")} />
          ) : route === "components" ? (
            <ConnectedComponentsView
              client={fleetClient}
              onOpenEvents={() => setRoute("events")}
              onOpenSignals={openSignals}
            />
          ) : route === "detail" && detailKey !== undefined ? (
            <ConnectedComponentDetailView
              client={fleetClient}
              detailKey={detailKey}
              onBack={() => setRoute("components")}
              onOpenOverview={() => setRoute("overview")}
              onOpenEvents={() => setRoute("events")}
              onOpenSignals={() => openSignals(detailKey)}
            />
          ) : route === "topology" ? (
            <ConnectedTopologyView client={fleetClient} onOpenDetail={openDetail} />
          ) : route === "signals" ? (
            <ConnectedSignalsView
              client={fleetClient}
              {...(signalsScope !== undefined ? { initialComponentId: scopeIdFor(signalsScope) } : {})}
              onOpenComponentDetail={openDetail}
            />
          ) : route === "settings" ? (
            <ConnectedSettingsView client={fleetClient} />
          ) : (
            <ConnectedEventsView client={fleetClient} />
          )}
        </Content>
      </SearchContext.Provider>
    </Theme>
  );
}
