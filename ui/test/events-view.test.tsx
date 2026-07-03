/**
 * The Events view (C6) — presentational tests: state in, DOM out, callbacks
 * observed. Essentials: newest-first log with severity chips + body summaries,
 * the component/severity filters, the expandable detail row, live-append via a
 * changed entries prop, the header tiles, and the empty/disconnected states.
 * Selector-level logic (buckets, per-minute series, summaries) is covered in
 * `events-selectors.test.ts`; the connected container's subscribe lifecycle in
 * `app.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ConsoleEvent } from "@edgecommons/edge-console-protocol";
import { EventsView } from "../src/events/EventsView";
import type { EventFilters } from "../src/events/selectors";
import { T0, clientState, consoleEvent, fleetView, key } from "./_fixtures";

afterEach(cleanup);

const OPCUA = key("gw-01", "opcua-adapter");
const MODBUS = key("gw-02", "modbus-adapter");

/** Three mixed events, newest-first (as the store hands them over). */
function threeEvents(): ConsoleEvent[] {
  return [
    consoleEvent({
      id: 3,
      key: MODBUS,
      severity: "critical",
      type: "overtemp",
      channel: "critical/overtemp",
      body: { message: "temperature above threshold", valueC: 91 },
      receivedAt: T0 - 10_000,
    }),
    consoleEvent({
      id: 2,
      key: OPCUA,
      severity: "warning",
      type: "connection-retry",
      channel: "warning/connection-retry",
      body: { message: "endpoint timeout, retrying" },
      receivedAt: T0 - 20_000,
    }),
    consoleEvent({
      id: 1,
      key: OPCUA,
      severity: "info",
      type: "scan-cycle",
      channel: "info/scan-cycle",
      body: "cycle complete",
      receivedAt: T0 - 30_000,
    }),
  ];
}

function renderView({
  entries = threeEvents(),
  filters = {} as EventFilters,
  onFiltersChange = vi.fn(),
  state = clientState(fleetView([]), { events: { entries } }),
}: {
  entries?: ConsoleEvent[];
  filters?: EventFilters;
  onFiltersChange?: (f: EventFilters) => void;
  state?: ReturnType<typeof clientState>;
} = {}) {
  const view = render(
    <EventsView state={state} now={T0} filters={filters} onFiltersChange={onFiltersChange} />,
  );
  return { onFiltersChange, view, state };
}

describe("EventsView - the log", () => {
  it("renders newest-first rows with severity chip, source identity, type, and body summary", () => {
    renderView();
    const table = screen.getByTestId("events-table");
    const rows = within(table).getAllByTestId(/^event-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "event-row-3",
      "event-row-2",
      "event-row-1",
    ]);

    const top = rows[0]!;
    expect(within(top).getByText("critical")).toBeTruthy(); // the raw severity token
    expect(within(top).getByText("modbus-adapter")).toBeTruthy();
    expect(within(top).getByText("gw-02")).toBeTruthy();
    expect(within(top).getByText("overtemp")).toBeTruthy();
    expect(within(top).getByText("temperature above threshold")).toBeTruthy(); // message field summary
    expect(within(top).getByText(/10s ago/)).toBeTruthy(); // server-clock age
  });

  it("live-appends: a new entries prop renders the new row on top", () => {
    const { view, state } = renderView();
    const fresh = consoleEvent({ id: 4, key: OPCUA, severity: "error", type: "write-failed", receivedAt: T0 });
    view.rerender(
      <EventsView
        state={{ ...state, events: { entries: [fresh, ...threeEvents()] } }}
        now={T0}
        filters={{}}
        onFiltersChange={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId(/^event-row-/);
    expect(rows[0]!.getAttribute("data-testid")).toBe("event-row-4");
    expect(rows).toHaveLength(4);
  });

  it("expands a row to the full detail (channel, publisher timestamp, pretty body) and collapses it", () => {
    renderView();
    expect(screen.queryByTestId("event-detail-3")).toBeNull();

    fireEvent.click(screen.getByTestId("event-expand-3"));
    const detail = screen.getByTestId("event-detail-3");
    expect(within(detail).getByText("evt/critical/overtemp")).toBeTruthy();
    expect(within(detail).getByText("2026-07-03T00:00:00.000Z")).toBeTruthy();
    expect(within(detail).getByText(/"valueC": 91/)).toBeTruthy(); // pretty JSON body

    fireEvent.click(screen.getByTestId("event-expand-3"));
    expect(screen.queryByTestId("event-detail-3")).toBeNull();
  });
});

describe("EventsView - filters", () => {
  it("applies the component filter and shows the filtered count", () => {
    renderView({ filters: { componentId: "gw-01/opcua-adapter/main" } });
    const rows = screen.getAllByTestId(/^event-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["event-row-2", "event-row-1"]);
    expect(screen.getByTestId("filter-count").textContent).toContain("2 of 3");
  });

  it("applies the severity filter", () => {
    renderView({ filters: { severity: "critical" } });
    expect(screen.getAllByTestId(/^event-row-/)).toHaveLength(1);
    expect(screen.getByTestId("event-row-3")).toBeTruthy();
  });

  it("reports filter changes from the dropdowns via onFiltersChange", () => {
    const { onFiltersChange } = renderView();

    fireEvent.click(screen.getByRole("combobox", { name: /Component/ }));
    fireEvent.click(screen.getByRole("option", { name: "gw-02/modbus-adapter/main" }));
    expect(onFiltersChange).toHaveBeenCalledWith({ componentId: "gw-02/modbus-adapter/main" });

    fireEvent.click(screen.getByRole("combobox", { name: /Severity/ }));
    fireEvent.click(screen.getByRole("option", { name: "Warning" }));
    expect(onFiltersChange).toHaveBeenCalledWith({ severity: "warning" });
  });

  it("shows the no-match empty state when the filters exclude everything", () => {
    renderView({ filters: { componentId: "gw-09/nothing/main" } });
    expect(screen.getByTestId("events-filtered-empty")).toBeTruthy();
    expect(screen.queryByTestId("events-table")).toBeNull();
  });
});

describe("EventsView - header tiles", () => {
  it("summarizes the recent history: count, severity legend, sparkline, noisiest source", () => {
    renderView();
    expect(screen.getByText("Recent events")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1 critical")).toBeTruthy();
    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(screen.getByTestId("sparkline")).toBeTruthy(); // events/min trend
    // opcua published 2 of the 3 within the 5-minute window — the noisiest.
    expect(screen.getByText("gw-01/opcua-adapter/main")).toBeTruthy();
    expect(screen.getByText(/2 events/)).toBeTruthy();
  });
});

describe("EventsView - connection states", () => {
  it("shows the live-tail chip when connected and the paused chip + warning when not", () => {
    renderView();
    expect(screen.getByTestId("live-tail").textContent).toContain("Live tail");

    cleanup();
    renderView({
      state: clientState(fleetView([]), {
        status: "reconnecting",
        events: { entries: threeEvents() },
      }),
    });
    expect(screen.getByTestId("live-tail").textContent).toContain("Tail paused");
    expect(screen.getByText(/Gateway connection lost/)).toBeTruthy();
    expect(screen.getAllByTestId(/^event-row-/)).toHaveLength(3); // last-known kept
  });

  it("shows the connecting spinner with no events yet, and the teaching empty state once connected", () => {
    renderView({
      entries: [],
      state: clientState(fleetView([]), { status: "connecting", hasSnapshot: false, events: { entries: [] } }),
    });
    expect(screen.getByText("Connecting to the console gateway…")).toBeTruthy();

    cleanup();
    renderView({ entries: [], state: clientState(fleetView([]), { events: { entries: [] } }) });
    expect(screen.getByText("No events yet")).toBeTruthy();
    expect(screen.getByTestId("events-empty")).toBeTruthy();
  });

  it("surfaces a protocol-version fatal error", () => {
    renderView({
      state: clientState(fleetView([]), {
        status: "disconnected",
        fatalError: "gateway is protocol v4",
        events: { entries: [] },
      }),
      entries: [],
    });
    expect(screen.getByText("Protocol version mismatch")).toBeTruthy();
  });
});
