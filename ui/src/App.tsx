/**
 * The Edge Console UI shell — IBM Carbon, realigned to the signed-off hi-fi mockup (R0).
 *
 * The shell hosts the shipped screens (edge-health / config-review / events), all fed by
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
import { Activity, Catalog, Dashboard } from "@carbon/react/icons";
import { defaultWsUrl } from "./config";
import { FleetClient } from "./fleet/client";
import { useFleetLifecycle, useFleetState } from "./fleet/useFleet";
import { ConnectedEdgeHealthView } from "./health/EdgeHealthView";
import { ConnectedConfigReviewView } from "./configreview/ConfigReviewView";
import { ConnectedEventsView } from "./events/EventsView";
import { AppBar } from "./shell/AppBar";
import { SearchContext } from "./shell/search";
import type { SearchState } from "./shell/search";
import { useTheme } from "./shell/theme";

/** The shell's view routes (one per shipped screen). */
type Route = "overview" | "config" | "events";

export default function App({ client }: { client?: FleetClient }): React.JSX.Element {
  const fleetClient = useMemo(() => client ?? new FleetClient({ url: defaultWsUrl() }), [client]);
  // The shell owns the one connection: every view reads it, none owns it.
  useFleetLifecycle(fleetClient);
  const state = useFleetState(fleetClient);
  const [theme, toggleTheme] = useTheme();
  const [route, setRoute] = useState<Route>("overview");
  const [query, setQuery] = useState("");
  const [navExpanded, setNavExpanded] = useState(true);

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
    setRoute(to);
  };

  return (
    <Theme theme={theme} className={`ec-app${navExpanded ? "" : " ec-app--nav-collapsed"}`}>
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
              renderIcon={Catalog}
              href="#"
              isActive={route === "config"}
              onClick={navigate("config")}
            >
              Configuration
            </SideNavLink>
            <SideNavLink
              renderIcon={Activity}
              href="#"
              isActive={route === "events"}
              onClick={navigate("events")}
            >
              Events
            </SideNavLink>
          </SideNavItems>
        </SideNav>
        <Content id="main-content" className="ec-content">
          {route === "overview" ? (
            <ConnectedEdgeHealthView client={fleetClient} onOpenEvents={() => setRoute("events")} />
          ) : route === "config" ? (
            <ConnectedConfigReviewView client={fleetClient} />
          ) : (
            <ConnectedEventsView client={fleetClient} />
          )}
        </Content>
      </SearchContext.Provider>
    </Theme>
  );
}
