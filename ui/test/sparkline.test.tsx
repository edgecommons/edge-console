/**
 * Sparkline (relocated to `common/` in R0 when the off-contract Metrics page was
 * removed) — the hand-rolled SVG trend mark: area + 1.5px line + emphasized endpoint,
 * with the degenerate-geometry cases (single point, flat series, empty).
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Sparkline } from "../src/common/Sparkline";

/** A compact grouping formatter (the Events tile uses one; test the injected path). */
const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format;

describe("Sparkline - the hand-rolled SVG mark", () => {
  it("renders the area fill, the 1.5px line, and the emphasized endpoint dot", () => {
    const { container } = render(
      <Sparkline
        points={[
          { at: 0, value: 1 },
          { at: 5, value: 3 },
          { at: 10, value: 2 },
        ]}
        ariaLabel="cpu trend"
      />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("cpu trend");
    expect(svg.getAttribute("aria-label")).toContain("latest 2");
    expect(svg.querySelector("polygon")).toBeTruthy();
    expect(svg.querySelector("polyline")!.getAttribute("stroke-width")).toBe("1.5");
    expect(svg.querySelector("circle")!.getAttribute("r")).toBe("2.5");
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
      <Sparkline
        points={[
          { at: 0, value: 4 },
          { at: 10, value: 4 },
        ]}
        ariaLabel="flat"
        height={32}
      />,
    );
    const line = container.querySelector("polyline")!;
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
        points={[
          { at: 0, value: 1234.5678 },
          { at: 1, value: 2000 },
        ]}
        ariaLabel="fmt"
        formatValue={fmt}
      />,
    );
    expect(container.querySelector("title")!.textContent).toContain("latest 2,000");
    expect(container.querySelector("title")!.textContent).toContain("min 1,234.57");
  });
});
