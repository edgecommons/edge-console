/**
 * The Edge Console UI shell — IBM Carbon (g100 dark, the signed-off hi-fi theme).
 *
 * Slice C3: the shell hosts the edge-health view (priority #1) fed live by the C2
 * WS gateway. The side rail carries exactly the views that exist (Overview) — the
 * mockup's further screens (Components/Topology/Configuration/Events/Signals) land
 * with their slices (C5/C6+); no dead navigation ships before its view does.
 *
 * The {@link FleetClient} is created once per app instance from the page-derived WS
 * URL (see `config.ts`) and injectable for tests (jsdom has no WebSocket).
 */
import { useMemo } from "react";
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
import { Dashboard } from "@carbon/react/icons";
import { defaultWsUrl } from "./config";
import { FleetClient } from "./fleet/client";
import { ConnectedEdgeHealthView } from "./health/EdgeHealthView";

export default function App({ client }: { client?: FleetClient }): React.JSX.Element {
  const fleetClient = useMemo(() => client ?? new FleetClient({ url: defaultWsUrl() }), [client]);
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
          <SideNavLink renderIcon={Dashboard} href="#" isActive>
            Overview
          </SideNavLink>
        </SideNavItems>
      </SideNav>
      <Content id="main-content" className="ec-content">
        <ConnectedEdgeHealthView client={fleetClient} />
      </Content>
    </Theme>
  );
}
