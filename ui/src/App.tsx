/**
 * The Edge Console UI shell — IBM Carbon (g100 dark, the signed-off hi-fi theme).
 *
 * Slices C3+C5+C6: the shell hosts the edge-health view (priority #1), the
 * config-review view (priority #2), and the events + metrics views (C6), all fed
 * by ONE shared {@link FleetClient} (one WS connection for the whole app — the
 * shell owns its lifecycle so switching views never drops the socket). The side
 * rail carries exactly the views that exist — the mockup's further screens
 * (Components/Topology/Signals) land with their slices; no dead navigation ships
 * before its view does.
 *
 * The client is created once per app instance from the page-derived WS URL (see
 * `config.ts`) and injectable for tests (jsdom has no WebSocket).
 */
import { useMemo, useState } from "react";
import {
  Content,
  Header,
  HeaderName,
  SideNav,
  SideNavItems,
  SideNavLink,
  SkipToContent,
  Theme,
} from "@carbon/react";
import { Activity, Catalog, ChartLineData, Dashboard } from "@carbon/react/icons";
import { defaultWsUrl } from "./config";
import { FleetClient } from "./fleet/client";
import { useFleetLifecycle } from "./fleet/useFleet";
import { ConnectedEdgeHealthView } from "./health/EdgeHealthView";
import { ConnectedConfigReviewView } from "./configreview/ConfigReviewView";
import { ConnectedEventsView } from "./events/EventsView";
import { ConnectedMetricsView } from "./metrics/MetricsView";

/** The shell's view routes (one per shipped screen). */
type Route = "overview" | "config" | "events" | "metrics";

export default function App({ client }: { client?: FleetClient }): React.JSX.Element {
  const fleetClient = useMemo(() => client ?? new FleetClient({ url: defaultWsUrl() }), [client]);
  // The shell owns the one connection: both views read it, neither owns it.
  useFleetLifecycle(fleetClient);
  const [route, setRoute] = useState<Route>("overview");

  const navigate = (to: Route) => (e: React.MouseEvent) => {
    e.preventDefault();
    setRoute(to);
  };

  return (
    <Theme theme="g100" className="ec-app">
      <Header aria-label="EdgeCommons Edge Console">
        <SkipToContent />
        <HeaderName href="#" prefix="EdgeCommons">
          Edge Console
        </HeaderName>
      </Header>
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
          <SideNavLink
            renderIcon={ChartLineData}
            href="#"
            isActive={route === "metrics"}
            onClick={navigate("metrics")}
          >
            Metrics
          </SideNavLink>
        </SideNavItems>
      </SideNav>
      <Content id="main-content" className="ec-content">
        {route === "overview" ? (
          <ConnectedEdgeHealthView client={fleetClient} />
        ) : route === "config" ? (
          <ConnectedConfigReviewView client={fleetClient} />
        ) : route === "events" ? (
          <ConnectedEventsView client={fleetClient} />
        ) : (
          <ConnectedMetricsView client={fleetClient} />
        )}
      </Content>
    </Theme>
  );
}
