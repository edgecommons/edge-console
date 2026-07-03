/**
 * The Edge Console UI shell — IBM Carbon (g100 dark, the signed-off hi-fi theme).
 *
 * Slices C3+C5: the shell hosts the edge-health view (priority #1) and the
 * config-review view (priority #2), both fed by ONE shared {@link FleetClient}
 * (one WS connection for the whole app — the shell owns its lifecycle so switching
 * views never drops the socket). The side rail carries exactly the views that exist
 * (Overview, Configuration) — the mockup's further screens (Components/Topology/
 * Events/Signals) land with their slices (C6+); no dead navigation ships before its
 * view does.
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
import { Catalog, Dashboard } from "@carbon/react/icons";
import { defaultWsUrl } from "./config";
import { FleetClient } from "./fleet/client";
import { useFleetLifecycle } from "./fleet/useFleet";
import { ConnectedEdgeHealthView } from "./health/EdgeHealthView";
import { ConnectedConfigReviewView } from "./configreview/ConfigReviewView";

/** The shell's view routes (one per shipped screen). */
type Route = "overview" | "config";

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
        </SideNavItems>
      </SideNav>
      <Content id="main-content" className="ec-content">
        {route === "overview" ? (
          <ConnectedEdgeHealthView client={fleetClient} />
        ) : (
          <ConnectedConfigReviewView client={fleetClient} />
        )}
      </Content>
    </Theme>
  );
}
