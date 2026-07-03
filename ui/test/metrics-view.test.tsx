/**
 * The Metrics view (C6) — presentational tests: the latest-value table with one
 * row per (component, metric, measure), the hand-rolled SVG sparkline (area +
 * line + emphasized endpoint), the component filter, live value updates via a
 * changed prop, and the empty/disconnected states. Plus the Sparkline's own
 * degenerate-geometry cases and the selectors.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MetricsView } from "../src/metrics/MetricsView";
import { Sparkline } from "../src/metrics/Sparkline";
import { filterSeries, formatMetricValue, seriesComponentIds } from "../src/metrics/selectors";
import type { MetricSeriesView } from "../src/fleet/metric-series-store";
import { T0, clientState, fleetView, key, metricSeries } from "./_fixtures";

afterEach(cleanup);

const OPCUA = key("gw-01", "opcua-adapter");
const BRIDGE = key("gw-02", "uns-bridge");

function threeSeries(): MetricSeriesView[] {
  return [
    metricSeries([10, 14, 12, 22.5], { key: OPCUA, metric: "sys", measure: "cpu" }),
    metricSeries([40, 41, 41, 43], { key: OPCUA, metric: "sys", measure: "memory" }),
    metricSeries([0, 3, 7], { key: BRIDGE, metric: "relay_dropped_data", measure: "value" }),
  ];
}

function renderView({
  series = threeSeries(),
  componentFilter = undefined as string | undefined,
  onComponentFilterChange = vi.fn(),
  state = clientState(fleetView([]), { metrics: { series } }),
}: {
  series?: MetricSeriesView[];
  componentFilter?: string | undefined;
  onComponentFilterChange?: (id: string | undefined) => void;
  state?: ReturnType<typeof clientState>;
} = {}) {
  const view = render(
    <MetricsView
      state={state}
      now={T0}
      componentFilter={componentFilter}
      onComponentFilterChange={onComponentFilterChange}
    />,
  );
  return { onComponentFilterChange, view, state };
}

describe("MetricsView - the table", () => {
  it("renders one row per (component, metric, measure) with formatted latest, trend, and age", () => {
    renderView();
    const rows = screen.getAllByTestId(/^metric-row-/);
    expect(rows).toHaveLength(3);

    const cpu = screen.getByTestId("metric-row-gw-01/opcua-adapter/main::sys::cpu");
    expect(within(cpu).getByText("opcua-adapter")).toBeTruthy();
    expect(within(cpu).getByText("gw-01")).toBeTruthy();
    expect(within(cpu).getByText("sys")).toBeTruthy();
    expect(within(cpu).getByText("cpu")).toBeTruthy();
    expect(within(cpu).getByText("22.5")).toBeTruthy(); // the latest, formatted
    expect(within(cpu).getByTestId("sparkline")).toBeTruthy();
    expect(within(cpu).getByText("0s ago")).toBeTruthy(); // receivedAt = T0 = now

    const dropped = screen.getByTestId(
      "metric-row-gw-02/uns-bridge/main::relay_dropped_data::value",
    );
    expect(within(dropped).getByText("7")).toBeTruthy();
  });

  it("live-updates: a new series prop re-renders the latest value", () => {
    const { view, state } = renderView();
    const bumped = [
      metricSeries([10, 14, 12, 99], { key: OPCUA, metric: "sys", measure: "cpu" }),
      ...threeSeries().slice(1),
    ];
    view.rerender(
      <MetricsView
        state={{ ...state, metrics: { series: bumped } }}
        now={T0}
        componentFilter={undefined}
        onComponentFilterChange={vi.fn()}
      />,
    );
    const cpu = screen.getByTestId("metric-row-gw-01/opcua-adapter/main::sys::cpu");
    expect(within(cpu).getByText("99")).toBeTruthy();
  });

  it("applies the component filter and shows the filtered count", () => {
    renderView({ componentFilter: "gw-02/uns-bridge/main" });
    expect(screen.getAllByTestId(/^metric-row-/)).toHaveLength(1);
    expect(screen.getByTestId("metrics-filter-count").textContent).toContain("1 of 3");
  });

  it("reports filter changes from the dropdown", () => {
    const { onComponentFilterChange } = renderView();
    fireEvent.click(screen.getByRole("combobox", { name: /Component/ }));
    fireEvent.click(screen.getByRole("option", { name: "gw-02/uns-bridge/main" }));
    expect(onComponentFilterChange).toHaveBeenCalledWith("gw-02/uns-bridge/main");
  });
});

describe("MetricsView - connection states", () => {
  it("shows the live chip when connected, the paused chip + warning when reconnecting", () => {
    renderView();
    expect(screen.getByTestId("metrics-live").textContent).toContain("Live");

    cleanup();
    renderView({
      state: clientState(fleetView([]), {
        status: "reconnecting",
        metrics: { series: threeSeries() },
      }),
    });
    expect(screen.getByTestId("metrics-live").textContent).toContain("Paused");
    expect(screen.getByText(/Gateway connection lost/)).toBeTruthy();
  });

  it("shows the connecting spinner / teaching empty state without series", () => {
    renderView({
      series: [],
      state: clientState(fleetView([]), { status: "connecting", hasSnapshot: false, metrics: { series: [] } }),
    });
    expect(screen.getByText("Connecting to the console gateway…")).toBeTruthy();

    cleanup();
    renderView({ series: [], state: clientState(fleetView([]), { metrics: { series: [] } }) });
    expect(screen.getByText("No metrics yet")).toBeTruthy();
    expect(screen.getByTestId("metrics-empty")).toBeTruthy();
  });

  it("surfaces a protocol-version fatal error", () => {
    renderView({
      series: [],
      state: clientState(fleetView([]), {
        status: "disconnected",
        fatalError: "gateway is protocol v4",
        metrics: { series: [] },
      }),
    });
    expect(screen.getByText("Protocol version mismatch")).toBeTruthy();
  });
});

describe("Sparkline - the hand-rolled SVG mark", () => {
  it("renders the area fill, the 1.5px line, and the emphasized endpoint dot", () => {
    const { container } = render(
      <Sparkline points={[{ at: 0, value: 1 }, { at: 5, value: 3 }, { at: 10, value: 2 }]} ariaLabel="cpu trend" />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("cpu trend");
    expect(svg.getAttribute("aria-label")).toContain("latest 2");
    expect(svg.querySelector("polygon")).toBeTruthy(); // the area fill
    const line = svg.querySelector("polyline")!;
    expect(line.getAttribute("stroke-width")).toBe("1.5");
    const dot = svg.querySelector("circle")!;
    expect(dot.getAttribute("r")).toBe("2.5");
    expect(svg.querySelector("title")!.textContent).toContain("min 1 · max 3 · latest 2");
  });

  it("renders a single point as the endpoint dot only (no degenerate line)", () => {
    const { container } = render(<Sparkline points={[{ at: 0, value: 5 }]} ariaLabel="one" />);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelector("polyline")).toBeNull();
    expect(svg.querySelector("circle")).toBeTruthy();
    expect(svg.querySelector("title")!.textContent).toBe("latest 5");
  });

  it("centers a flat series (all-equal values) instead of dividing by zero", () => {
    const { container } = render(
      <Sparkline points={[{ at: 0, value: 4 }, { at: 10, value: 4 }]} ariaLabel="flat" height={32} />,
    );
    const line = container.querySelector("polyline")!;
    // Every y is the vertical center.
    for (const pair of line.getAttribute("points")!.split(" ")) {
      expect(pair.split(",")[1]).toBe("16");
    }
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<Sparkline points={[]} ariaLabel="empty" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("honors the injected value formatter in the hover summary", () => {
    const { container } = render(
      <Sparkline
        points={[{ at: 0, value: 1234.5678 }, { at: 1, value: 2000 }]}
        ariaLabel="fmt"
        formatValue={formatMetricValue}
      />,
    );
    expect(container.querySelector("title")!.textContent).toContain("latest 2,000");
    expect(container.querySelector("title")!.textContent).toContain("min 1,234.57");
  });
});

describe("metrics selectors", () => {
  it("filterSeries / seriesComponentIds", () => {
    const series = threeSeries();
    expect(filterSeries(series, undefined)).toHaveLength(3);
    expect(filterSeries(series, "gw-01/opcua-adapter/main")).toHaveLength(2);
    expect(seriesComponentIds(series)).toEqual([
      "gw-01/opcua-adapter/main",
      "gw-02/uns-bridge/main",
    ]);
  });

  it("formatMetricValue: grouping, ≤2 decimals, no trailing zeros", () => {
    expect(formatMetricValue(42)).toBe("42");
    expect(formatMetricValue(1234)).toBe("1,234");
    expect(formatMetricValue(3.14159)).toBe("3.14");
    expect(formatMetricValue(0.5)).toBe("0.5");
    expect(formatMetricValue(-7.005)).toBe("-7.01");
  });
});
