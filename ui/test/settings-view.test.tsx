import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SettingsView } from "../src/settings/SettingsView";
import { clientState, compView, consoleSettings, deviceView, fleetView, hier, key } from "./_fixtures";

afterEach(cleanup);

function fleetWithLines() {
  return fleetView([
    deviceView("press-gw-01", [
      compView({
        key: key("press-gw-01", "opcua-adapter"),
        hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
      }),
    ]),
    deviceView("asm-gw-01", [
      compView({
        key: key("asm-gw-01", "telemetry-processor"),
        hier: hier(["site", "dallas"], ["line", "assembly"], ["device", "asm-gw-01"]),
      }),
    ]),
  ]);
}

describe("SettingsView (R6)", () => {
  it("renders the console's read-only policy + config and highlights the current role", () => {
    const state = clientState(fleetWithLines(), { settings: consoleSettings(), role: "viewer" });
    render(<SettingsView state={state} />);

    // Header faithful to the mockup.
    expect(screen.getByText("Settings")).toBeTruthy();

    // RBAC: both roles present; operator is the default; viewer is the current role.
    const operatorRow = screen.getByTestId("settings-role-operator");
    const viewerRow = screen.getByTestId("settings-role-viewer");
    expect(within(operatorRow).getByText("default")).toBeTruthy();
    expect(within(viewerRow).queryByText("default")).toBeNull();
    expect(screen.getByTestId("settings-role-you-viewer")).toBeTruthy();
    // operator's wildcard + deny render honestly.
    expect(within(operatorRow).getByText("all verbs (*)")).toBeTruthy();
    expect(within(operatorRow).getByText("deny reboot")).toBeTruthy();

    // Connection: broker + WS listener + heartbeat.
    const conn = screen.getByTestId("settings-connection");
    expect(within(conn).getByText("gw-dallas-01")).toBeTruthy();
    expect(within(conn).getByText("EMQX @ gateway")).toBeTruthy();
    expect(within(conn).getByText("0.0.0.0:8443/ws")).toBeTruthy();
    expect(within(conn).getByText("15 s")).toBeTruthy();
    // Serves UI: false in the fixture (no console.ws.webRoot) -> the honest "no" tag.
    expect(within(screen.getByTestId("settings-conn-serves-ui")).getByText("no")).toBeTruthy();

    // Thresholds: the mockup ladder string verbatim.
    expect(screen.getByTestId("settings-staleness").textContent).toContain(
      "2× warn / 2.5× stale / 5× offline",
    );

    // Command deadlines incl. the reply-map TTL ceiling + the per-verb ping override.
    expect(screen.getByTestId("settings-cmd-ttl").textContent).toContain("60 s");
    expect(screen.getByTestId("settings-cmd-verb-ping").textContent).toContain("10 s");

    // Runtime: launch-latched process knobs reported by the Rust gateway.
    expect(screen.getByTestId("settings-runtime-workers").textContent).toContain("4");
    expect(screen.getByTestId("settings-runtime-arenas").textContent).toContain("2");
    expect(screen.getByTestId("settings-runtime-events").textContent).toContain("512");
    expect(screen.getByText("restart required")).toBeTruthy();

    // Retention caps.
    expect(screen.getByTestId("settings-ret-channels").textContent).toContain("1024");
    expect(screen.getByTestId("settings-ret-series").textContent).toContain("2000");

    // Site-map: identity-derived read-only rows, sorted by device.
    expect(screen.getByTestId("settings-hierarchy").textContent).toContain("site → line → device");
    expect(within(screen.getByTestId("settings-sitemap-asm-gw-01")).getByText("assembly")).toBeTruthy();
    expect(within(screen.getByTestId("settings-sitemap-press-gw-01")).getByText("stamping")).toBeTruthy();
  });

  it("marks the staged editors read-only and flags the pending policy honestly", () => {
    const state = clientState(fleetWithLines(), { settings: consoleSettings(), role: "operator" });
    render(<SettingsView state={state} />);

    // The site-map + read-only-mode editors are disabled (not fake editable controls).
    expect((screen.getByTestId("settings-sitemap-edit") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("settings-readonly-edit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("staged editor").length).toBeGreaterThan(0);

    // Panel trust + redaction rules are flagged as not-held (not invented).
    expect(within(screen.getByTestId("settings-panel-trust")).getByText("pending — not held")).toBeTruthy();
    expect(within(screen.getByTestId("settings-redaction")).getByText("source-side — none held")).toBeTruthy();
  });

  it("renders honest fallbacks: empty-allow role, flat site-map, unknown connection fields", () => {
    const flatFleet = fleetView([
      deviceView("gw-01", [
        compView({ key: key("gw-01", "opcua-adapter"), hier: hier(["site", "dallas"], ["device", "gw-01"]) }),
      ]),
    ]);
    const settings = consoleSettings({
      rbac: {
        defaultRole: "locked",
        roles: [{ name: "locked", allow: [], deny: [], isDefault: true }],
      },
      connection: {
        // No device/platform/transport/broker known — only the WS listener.
        wsPort: 8443,
        wsBindAddress: "0.0.0.0",
        heartbeatIntervalMs: 15000,
      },
    });
    const state = clientState(flatFleet, { settings, role: "locked" });
    render(<SettingsView state={state} />);

    // A role that may invoke nothing shows an honest "none" (not a blank).
    expect(within(screen.getByTestId("settings-role-verbs-locked")).getByText("none")).toBeTruthy();
    // A flat identity hierarchy → "direct under site".
    expect(within(screen.getByTestId("settings-sitemap-gw-01")).getByText("direct under site")).toBeTruthy();
    // Unknown connection identity → "not announced" (not fabricated).
    expect(within(screen.getByTestId("settings-connection")).getAllByText("not announced").length).toBeGreaterThan(0);
    // servesUi omitted (an older/hand-built settings frame) → honestly shown as unreported, not fabricated.
    expect(within(screen.getByTestId("settings-conn-serves-ui")).getByText("not announced")).toBeTruthy();
  });

  it("shows the 'Serves UI: yes' tag when the console's own webRoot is configured", () => {
    const settings = consoleSettings({ connection: { ...consoleSettings().connection, servesUi: true } });
    const state = clientState(fleetWithLines(), { settings, role: "viewer" });
    render(<SettingsView state={state} />);
    expect(within(screen.getByTestId("settings-conn-serves-ui")).getByText("yes")).toBeTruthy();
  });

  it("flags runtime config that does not match the launched process", () => {
    const settings = consoleSettings({
      runtime: {
        workerThreads: 8,
        effectiveWorkerThreads: 4,
        mallocArenaMax: 3,
        launchLatched: true,
      },
    });
    const state = clientState(fleetWithLines(), { settings, role: "viewer" });
    render(<SettingsView state={state} />);

    expect(within(screen.getByTestId("settings-runtime-workers")).getByText("configured 8")).toBeTruthy();
    expect(within(screen.getByTestId("settings-runtime-arenas")).getByText("not exported")).toBeTruthy();
    expect(within(screen.getByTestId("settings-runtime-arenas")).getByText("configured 3")).toBeTruthy();
  });

  it("shows an honest empty state before the settings frame arrives", () => {
    const state = clientState(fleetView([]), { status: "connected" });
    render(<SettingsView state={state} />);
    expect(screen.getByTestId("settings-empty")).toBeTruthy();
    expect(screen.getByText("Console policy not received yet")).toBeTruthy();
    expect(screen.queryByTestId("settings-grid")).toBeNull();
  });

  it("flags an undeclared current role as fail-closed", () => {
    const state = clientState(fleetWithLines(), { settings: consoleSettings(), role: "ghost" });
    render(<SettingsView state={state} />);
    expect(screen.getByTestId("settings-your-role").textContent).toContain("ghost");
    expect(screen.getByText("undeclared — fail-closed")).toBeTruthy();
  });
});
