/**
 * The Events & Alarms view (R4) — presentational tests: state in, DOM out, callbacks
 * observed. Essentials: the merged newest-first table of stateful ALARMS + the
 * informational event FEED, the State column, a working Ack action, the ack audit,
 * per-row detail, the active-alarm header tile, filters, and the empty/disconnected
 * states. The alarm/event split logic is covered in `alarm-selectors.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ConsoleAlarm, ConsoleEvent } from "@edgecommons/edge-console-protocol";
import { EventsView } from "../src/events/EventsView";
import type { EventFilters } from "../src/events/selectors";
import type { AckAudit } from "../src/events/alarm-selectors";
import { T0, alarmSnapshot, clientState, consoleAlarm, consoleEvent, fleetView, key } from "./_fixtures";

afterEach(cleanup);

const OPCUA = key("gw-01", "opcua-adapter");
const MODBUS = key("gw-02", "modbus-adapter");

/** Two alarms (one active-critical, one acked-warning) + two informational events. */
function twoAlarms(): ConsoleAlarm[] {
  return [
    consoleAlarm({
      key: OPCUA,
      type: "connection-lost",
      severity: "critical",
      message: "OPC UA session dropped",
      raisedAt: T0 - 5000,
      lastAt: T0 - 5000,
      count: 2,
      acked: false,
    }),
    consoleAlarm({
      key: MODBUS,
      type: "slave-retry",
      severity: "warning",
      message: "slave did not answer",
      raisedAt: T0 - 20_000,
      lastAt: T0 - 20_000,
      acked: true,
    }),
  ];
}

function twoEvents(): ConsoleEvent[] {
  return [
    consoleEvent({
      id: 2,
      key: OPCUA,
      severity: "info",
      type: "scan-cycle",
      channel: "info/scan-cycle",
      body: { message: "browse cycle finished" },
      receivedAt: T0 - 10_000,
    }),
    consoleEvent({
      id: 1,
      key: OPCUA,
      severity: "info",
      type: "started",
      channel: "info/started",
      body: "process up",
      receivedAt: T0 - 30_000,
    }),
  ];
}

const ALARM_A = "alarm:gw-01/opcua-adapter/main::connection-lost";
const ALARM_B_ID = "gw-02/modbus-adapter/main::slave-retry";

function renderView({
  alarms = twoAlarms(),
  entries = twoEvents(),
  filters = {} as EventFilters,
  onFiltersChange = vi.fn(),
  onAck = vi.fn(),
  ackAudit = {} as AckAudit,
  state = clientState(fleetView([]), { events: { entries }, alarms: alarmSnapshot(alarms) }),
}: {
  alarms?: ConsoleAlarm[];
  entries?: ConsoleEvent[];
  filters?: EventFilters;
  onFiltersChange?: (f: EventFilters) => void;
  onAck?: (id: string) => void;
  ackAudit?: AckAudit;
  state?: ReturnType<typeof clientState>;
} = {}) {
  render(
    <EventsView
      state={state}
      now={T0}
      filters={filters}
      onFiltersChange={onFiltersChange}
      onAck={onAck}
      ackAudit={ackAudit}
    />,
  );
  return { onFiltersChange, onAck, state };
}

describe("EventsView - the merged alarm+event table", () => {
  it("renders alarms and events interleaved newest-first, each with a State", () => {
    renderView();
    const table = screen.getByTestId("events-table");
    const rows = within(table).getAllByTestId(/^feed-row-/);
    // A (T0-5s alarm) · event 2 (T0-10s) · B (T0-20s alarm) · event 1 (T0-30s).
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      `feed-row-${ALARM_A}`,
      "feed-row-event:2",
      `feed-row-alarm:${ALARM_B_ID}`,
      "feed-row-event:1",
    ]);

    const alarmRow = rows[0]!;
    expect(within(alarmRow).getByText("critical")).toBeTruthy(); // raw severity token
    expect(within(alarmRow).getByText("opcua-adapter")).toBeTruthy();
    expect(within(alarmRow).getByText("connection-lost")).toBeTruthy();
    expect(within(alarmRow).getByText("Active")).toBeTruthy(); // the alarm State
    expect(within(alarmRow).getByText("×2")).toBeTruthy(); // re-raise count

    const eventRow = rows[1]!;
    expect(within(eventRow).getByText("scan-cycle")).toBeTruthy();
    expect(within(eventRow).getByText("browse cycle finished")).toBeTruthy();
    expect(within(eventRow).getByText("Event")).toBeTruthy(); // informational marker
  });

  it("shows an Ack action on the active alarm, and reports the ack via onAck", () => {
    const { onAck } = renderView();
    const ackBtn = screen.getByTestId(`ack-gw-01/opcua-adapter/main::connection-lost`);
    fireEvent.click(ackBtn);
    expect(onAck).toHaveBeenCalledWith("gw-01/opcua-adapter/main::connection-lost");
  });

  it("shows Acked (no Ack action) for an already-acked alarm, with the console-side audit", () => {
    const ackAudit: AckAudit = { [ALARM_B_ID]: { at: new Date(2026, 6, 3, 9, 5, 7).getTime(), by: "operator" } };
    renderView({ ackAudit });
    const ackedRow = screen.getByTestId(`feed-row-alarm:${ALARM_B_ID}`);
    expect(within(ackedRow).getByText("Acked")).toBeTruthy();
    expect(screen.queryByTestId(`ack-${ALARM_B_ID}`)).toBeNull(); // no Ack action once acked

    // Expanding reveals the who/when audit (console-side state).
    fireEvent.click(within(ackedRow).getByTestId(`feed-expand-alarm:${ALARM_B_ID}`));
    const audit = screen.getByTestId(`ack-audit-${ALARM_B_ID}`);
    expect(audit.textContent).toContain("acked 09:05:07");
    expect(audit.textContent).toContain("by operator");
  });

  it("expands an event row to its full envelope detail", () => {
    renderView();
    fireEvent.click(screen.getByTestId("feed-expand-event:2"));
    const detail = screen.getByTestId("feed-detail-event:2");
    expect(within(detail).getByText("evt/info/scan-cycle")).toBeTruthy();
    expect(within(detail).getByText(/browse cycle finished/)).toBeTruthy();
  });
});

describe("EventsView - header tiles", () => {
  it("summarizes ACTIVE ALARMS (count + crit/warn/acked rollup) from the alarm surface", () => {
    renderView();
    expect(screen.getByText("Active alarms")).toBeTruthy();
    expect(screen.getByTestId("active-alarm-count").textContent).toBe("2");
    // 1 critical active + 1 warning acked.
    expect(screen.getByText(/1 crit · 1 warn/)).toBeTruthy();
    expect(screen.getByText(/1 acked/)).toBeTruthy();
    expect(screen.getByTestId("sparkline")).toBeTruthy(); // events/min trend
  });
});

describe("EventsView - filters", () => {
  it("filters the merged feed by severity (alarms + events share the severity space)", () => {
    renderView({ filters: { severity: "critical" } });
    const rows = screen.getAllByTestId(/^feed-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-testid")).toBe(`feed-row-${ALARM_A}`);
    expect(screen.getByTestId("filter-count").textContent).toContain("1 of 4");
  });

  it("reports filter changes from the dropdowns via onFiltersChange", () => {
    const { onFiltersChange } = renderView();
    fireEvent.click(screen.getByRole("combobox", { name: /Severity/ }));
    fireEvent.click(screen.getByRole("option", { name: "Info" }));
    expect(onFiltersChange).toHaveBeenCalledWith({ severity: "info" });
  });

  it("shows the no-match empty state when the filters exclude everything", () => {
    renderView({ filters: { componentId: "gw-09/nothing/main" } });
    expect(screen.getByTestId("events-filtered-empty")).toBeTruthy();
    expect(screen.queryByTestId("events-table")).toBeNull();
  });
});

describe("EventsView - connection / empty states", () => {
  it("shows the live-tail chip when connected and the paused chip + warning when not", () => {
    renderView();
    expect(screen.getByTestId("live-tail").textContent).toContain("Live tail");

    cleanup();
    renderView({
      state: clientState(fleetView([]), {
        status: "reconnecting",
        events: { entries: twoEvents() },
        alarms: alarmSnapshot(twoAlarms()),
      }),
    });
    expect(screen.getByTestId("live-tail").textContent).toContain("Tail paused");
    expect(screen.getByText(/Gateway connection lost/)).toBeTruthy();
    expect(screen.getAllByTestId(/^feed-row-/)).toHaveLength(4); // last-known kept
  });

  it("shows the connecting spinner with nothing yet, and the teaching empty state once connected", () => {
    renderView({
      alarms: [],
      entries: [],
      state: clientState(fleetView([]), {
        status: "connecting",
        hasSnapshot: false,
        events: { entries: [] },
      }),
    });
    expect(screen.getByText("Connecting to the console gateway…")).toBeTruthy();

    cleanup();
    renderView({ alarms: [], entries: [], state: clientState(fleetView([])) });
    expect(screen.getByText("No events or alarms yet")).toBeTruthy();
    expect(screen.getByTestId("events-empty")).toBeTruthy();
  });

  it("surfaces a protocol-version fatal error", () => {
    renderView({
      alarms: [],
      entries: [],
      state: clientState(fleetView([]), {
        status: "disconnected",
        fatalError: "gateway is protocol v4",
        events: { entries: [] },
      }),
    });
    expect(screen.getByText("Protocol version mismatch")).toBeTruthy();
  });
});
