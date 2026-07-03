/**
 * The Edge Console UI shell — IBM Carbon (g100), scaffold only.
 *
 * Slice C0/C1 ships the backend (BusIngress + FleetModel); this shell proves the
 * Carbon/React/Vite toolchain compiles end-to-end. The real views arrive per the
 * Phase-1 plan: Overview/Components/Component-detail (C3, over the C2 WS gateway),
 * config-review (C5), events & metrics (C6).
 */
import {
  Content,
  Header,
  HeaderName,
  Theme,
  Tile,
} from "@carbon/react";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";

export default function App(): React.JSX.Element {
  return (
    <Theme theme="g100">
      <Header aria-label="Edge Console">
        <HeaderName href="#" prefix="EdgeCommons">
          Edge Console
        </HeaderName>
      </Header>
      <Content>
        <Tile>
          <h3>Edge Console</h3>
          <p>
            Backend slice C1 (BusIngress + FleetModel) is live; the edge-health views land in
            slice C3 over the C2 WebSocket gateway (protocol v{PROTOCOL_VERSION}).
          </p>
        </Tile>
      </Content>
    </Theme>
  );
}
