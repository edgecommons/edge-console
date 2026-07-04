/**
 * AppBar (R0) — the application-shell header chrome: search box (shared filter state),
 * theme toggle, notifications badge (active-alarm count), and the account role indicator.
 * Purely presentational — state in, DOM out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppBar } from "../src/shell/AppBar";
import type { AppBarProps } from "../src/shell/AppBar";

afterEach(cleanup);

function renderBar(overrides: Partial<AppBarProps> = {}) {
  const props: AppBarProps = {
    theme: "g100",
    onToggleTheme: vi.fn(),
    alarmCount: 0,
    role: "operator",
    connected: true,
    search: "",
    onSearchChange: vi.fn(),
    navExpanded: true,
    onToggleNav: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<AppBar {...props} />) };
}

describe("AppBar", () => {
  it("renders the product name and the search box, and reports input changes", () => {
    const { props } = renderBar();
    expect(screen.getByText("Edge Console")).toBeTruthy();
    const search = screen.getByTestId("appbar-search") as HTMLInputElement;
    expect(search.placeholder).toContain("Search components");
    fireEvent.change(search, { target: { value: "opcua" } });
    expect(props.onSearchChange).toHaveBeenCalledWith("opcua");
  });

  it("toggles the theme and shows the correct affordance per theme", () => {
    const { props } = renderBar({ theme: "g100" });
    const themeBtn = screen.getByTestId("appbar-theme");
    expect(themeBtn.getAttribute("aria-label")).toBe("Switch to light theme");
    fireEvent.click(themeBtn);
    expect(props.onToggleTheme).toHaveBeenCalled();

    cleanup();
    renderBar({ theme: "g10" });
    expect(screen.getByTestId("appbar-theme").getAttribute("aria-label")).toBe("Switch to dark theme");
  });

  it("shows the notifications badge only when there are active alarms (99+ clamp)", () => {
    renderBar({ alarmCount: 0 });
    expect(screen.queryByTestId("appbar-alarm-count")).toBeNull();

    cleanup();
    renderBar({ alarmCount: 3 });
    expect(screen.getByTestId("appbar-alarm-count").textContent).toBe("3");

    cleanup();
    renderBar({ alarmCount: 250 });
    expect(screen.getByTestId("appbar-alarm-count").textContent).toBe("99+");
  });

  it("shows the RBAC role, falling back honestly when unknown/offline", () => {
    renderBar({ role: "operator" });
    expect(screen.getByTestId("appbar-role").textContent).toBe("operator");

    cleanup();
    renderBar({ role: undefined, connected: true });
    expect(screen.getByTestId("appbar-role").textContent).toBe("unknown");

    cleanup();
    renderBar({ role: undefined, connected: false });
    expect(screen.getByTestId("appbar-role").textContent).toBe("offline");
  });

  it("toggles the nav from the burger", () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByLabelText("Close navigation"));
    expect(props.onToggleNav).toHaveBeenCalled();
  });
});
