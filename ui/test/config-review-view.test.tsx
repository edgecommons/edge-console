/**
 * The config-review view (C5) — presentational tests: state in, DOM out, callbacks
 * observed. The mockup-fidelity essentials: picker + detail split, Structured/Raw
 * tabs, redaction rendered AS redaction, the received-age stamp, Refresh, and the
 * empty/loading/unavailable states.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import { ConfigReviewView } from "../src/configreview/ConfigReviewView";
import type { ConfigEntryView } from "../src/fleet/config-store";
import { T0, clientState, compView, deviceView, fleetView, key } from "./_fixtures";

afterEach(cleanup);

const KEY = key("gw-01", "modbus-adapter");
const ID = "gw-01/modbus-adapter/main";

function loadedEntry(overrides: Partial<ConfigEntryView> = {}): ConfigEntryView {
  return {
    key: KEY,
    id: ID,
    phase: "loaded",
    body: {
      config: {
        heartbeat: { intervalSecs: 5 },
        messaging: { local: { host: "emqx.local", credentials: { password: "***" } } },
        apiKey: "$secret:northbound",
      },
    },
    receivedAt: T0 - 6000, // 6 s before the tick
    refreshing: false,
    ...overrides,
  };
}

function fleetWithTwo() {
  return fleetView([
    deviceView("gw-01", [
      compView({ key: KEY }),
      compView({ key: key("gw-01", "opcua-adapter"), liveness: "WARN" }),
    ]),
  ]);
}

function renderView({
  entry,
  noSelection = false,
  onSelect = vi.fn(),
  onRefresh = vi.fn(),
  state = clientState(fleetWithTwo(), {
    configs: { entriesById: entry !== undefined ? { [entry.id]: entry } : {} },
  }),
}: {
  entry?: ConfigEntryView;
  /** Render with NO selected component (a bare `selected: undefined` would hit the destructuring default). */
  noSelection?: boolean;
  onSelect?: (key: ComponentKey) => void;
  onRefresh?: (key: ComponentKey) => void;
  state?: ReturnType<typeof clientState>;
} = {}) {
  const selected: ComponentKey | undefined = noSelection ? undefined : KEY;
  render(
    <ConfigReviewView state={state} now={T0} selected={selected} onSelect={onSelect} onRefresh={onRefresh} />,
  );
  return { onSelect, onRefresh };
}

describe("ConfigReviewView - picker", () => {
  it("lists every fleet component and reports selection via onSelect", () => {
    const { onSelect } = renderView({ entry: loadedEntry(), noSelection: true });
    const picker = screen.getByTestId("config-picker");
    expect(within(picker).getByText("modbus-adapter")).toBeTruthy();
    expect(within(picker).getByText("opcua-adapter")).toBeTruthy();

    fireEvent.click(screen.getByTestId("config-pick-gw-01/opcua-adapter/main"));
    expect(onSelect).toHaveBeenCalledWith(key("gw-01", "opcua-adapter"));
  });

  it("shows availability chips where known (LIVE for loaded, UNAVAIL for unavailable)", () => {
    const unavailable: ConfigEntryView = {
      key: key("gw-01", "opcua-adapter"),
      id: "gw-01/opcua-adapter/main",
      phase: "unavailable",
      refreshing: false,
    };
    renderView({
      state: clientState(fleetWithTwo(), {
        configs: {
          entriesById: { [ID]: loadedEntry(), "gw-01/opcua-adapter/main": unavailable },
        },
      }),
    });
    const picker = screen.getByTestId("config-picker");
    expect(within(picker).getByText("LIVE")).toBeTruthy();
    expect(within(picker).getByText("UNAVAIL")).toBeTruthy();
  });

  it("with no selection, prompts to pick a component", () => {
    renderView({ noSelection: true });
    expect(screen.getByTestId("config-no-selection")).toBeTruthy();
  });
});

describe("ConfigReviewView - the loaded detail (hierarchical tree)", () => {
  it("renders a GENUINELY nested tree (containers + leaves), not a flat dotted list", () => {
    renderView({ entry: loadedEntry() });
    const tree = screen.getByTestId("config-tree");
    // Top-level containers/leaves are nodes keyed by their own path, not a flat dotted row.
    expect(within(tree).getByTestId("config-node-heartbeat")).toBeTruthy();
    expect(within(tree).getByTestId("config-node-messaging")).toBeTruthy();
    // Nested objects open two levels deep by default: messaging → local → host is visible.
    expect(within(tree).getByTestId("config-node-messaging.local")).toBeTruthy();
    expect(within(tree).getByTestId("config-node-messaging.local.host")).toBeTruthy();
    expect(within(tree).getByText("emqx.local")).toBeTruthy();
    // The leaf label is just the key ("intervalSecs"), NOT the old flat "heartbeat.intervalSecs".
    const heartbeatChild = within(tree).getByTestId("config-node-heartbeat.intervalSecs");
    expect(heartbeatChild.textContent).toContain("intervalSecs");
    expect(within(tree).queryByText("heartbeat.intervalSecs")).toBeNull();
    // The deeper `credentials` object is a COLLAPSED group — password not shown until opened.
    expect(within(tree).getByTestId("config-node-messaging.local.credentials")).toBeTruthy();
    expect(within(tree).queryByTestId("config-node-messaging.local.credentials.password")).toBeNull();
  });

  it("expands a nested container on demand and shows redaction AS redaction there", () => {
    renderView({ entry: loadedEntry() });
    fireEvent.click(screen.getByTestId("config-toggle-messaging.local.credentials"));
    const tree = screen.getByTestId("config-tree");
    expect(within(tree).getByTestId("config-node-messaging.local.credentials.password")).toBeTruthy();
    // The masked treatment + chip — the sentinel is NOT shown as a plain value.
    expect(within(tree).getByText("●●●●●●")).toBeTruthy();
    expect(within(tree).getByText("redacted")).toBeTruthy();
    // The $secret ref is a labeled pointer (a top-level leaf, visible without expanding).
    expect(within(tree).getByText("$secret:northbound")).toBeTruthy();
    expect(within(tree).getByText("secret ref")).toBeTruthy();
  });

  it("shows the honest provenance badges: real configHash, source/schema flagged not-announced", () => {
    renderView({ entry: loadedEntry() });
    // configHash is real (console-computed) — a stable 8-hex fingerprint.
    expect(screen.getByTestId("config-hash").textContent).toMatch(/configHash [0-9a-f]{8}/);
    // source + schema are honestly flagged as not carried by the cfg envelope (not fabricated).
    expect(screen.getByTestId("config-source-pending").textContent).toContain("not announced");
    expect(screen.getByTestId("config-schema-pending").textContent).toContain("not announced");
  });

  it("announces the redaction count", () => {
    renderView({ entry: loadedEntry() });
    expect(screen.getByText("1 value redacted at the source")).toBeTruthy();
  });

  it("stamps how long ago the cfg was received (server-clock honest)", () => {
    renderView({ entry: loadedEntry() });
    expect(screen.getByTestId("config-received").textContent).toBe("received 6s ago");
  });

  it("the Raw JSON tab carries the verbatim pretty JSON with the sentinel styled", () => {
    renderView({ entry: loadedEntry() });
    fireEvent.click(screen.getByRole("tab", { name: "Raw JSON" }));
    const pre = screen.getByTestId("config-json");
    expect(pre.textContent).toContain('"intervalSecs": 5');
    expect(pre.textContent).toContain('"password": "***"'); // verbatim — masked by STYLE
    const redactedSpan = pre.querySelector(".ec-json--redacted");
    expect(redactedSpan?.textContent).toBe('"***"');
  });

  it("Refresh fires onRefresh with the selected key; while refreshing it disables and notes the broadcast", () => {
    const { onRefresh } = renderView({ entry: loadedEntry() });
    fireEvent.click(screen.getByTestId("refresh-config"));
    expect(onRefresh).toHaveBeenCalledWith(KEY);

    cleanup();
    renderView({ entry: loadedEntry({ refreshing: true }) });
    expect((screen.getByTestId("refresh-config") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Re-announce requested")).toBeTruthy();
  });
});

describe("ConfigReviewView - loading / unavailable / empty states", () => {
  it("shows the loading state until the gateway answers", () => {
    renderView({ entry: undefined }); // selected but never answered
    expect(screen.getByTestId("config-loading")).toBeTruthy();
    expect(screen.getByText("Requesting configuration…")).toBeTruthy();
  });

  it("explains an unavailable config and still offers Refresh (the re-announce path)", () => {
    const { onRefresh } = renderView({
      entry: { key: KEY, id: ID, phase: "unavailable", refreshing: false },
    });
    expect(screen.getByTestId("config-unavailable")).toBeTruthy();
    expect(screen.getByText("No configuration received")).toBeTruthy();
    fireEvent.click(screen.getByTestId("refresh-config"));
    expect(onRefresh).toHaveBeenCalledWith(KEY);
  });

  it("without a snapshot it shows the connecting state; with an empty fleet the discovery note", () => {
    renderView({
      noSelection: true,
      state: clientState(fleetView([]), { hasSnapshot: false, status: "connecting" }),
    });
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    cleanup();

    renderView({ noSelection: true, state: clientState(fleetView([])) });
    expect(screen.getByTestId("empty-fleet")).toBeTruthy();
  });

  it("keeps showing last-known config under a lost connection, with the honest banner", () => {
    renderView({
      entry: loadedEntry(),
      state: clientState(fleetWithTwo(), {
        status: "reconnecting",
        configs: { entriesById: { [ID]: loadedEntry() } },
      }),
    });
    expect(screen.getByText("Gateway connection lost — reconnecting")).toBeTruthy();
    expect(screen.getByTestId("config-tree")).toBeTruthy();
  });
});
