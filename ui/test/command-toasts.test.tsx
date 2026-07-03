/**
 * The C4 CommandToasts: newly-settled commands raise a toast (success/error), pre-existing
 * settled commands do NOT replay on mount, and a toast is dismissible.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CommandToasts } from "../src/health/CommandToasts";
import { commandEntry, commandView } from "./_fixtures";

afterEach(cleanup);

describe("CommandToasts", () => {
  it("raises no toast for commands already settled at mount (no replay)", () => {
    render(<CommandToasts commands={commandView([commandEntry({ requestId: "old", phase: "ok" })])} />);
    expect(screen.queryByTestId("cmd-toasts")).toBeNull();
  });

  it("toasts a command that settles after mount", () => {
    const { rerender } = render(<CommandToasts commands={commandView([])} />);
    rerender(
      <CommandToasts
        commands={commandView([commandEntry({ requestId: "r1", verb: "ping", phase: "ok" })])}
      />,
    );
    const toast = screen.getByTestId("cmd-toast-r1");
    expect(within(toast).getByText("ping · comp-a")).toBeTruthy();
    expect(within(toast).getByText("RUNNING · uptime 42s")).toBeTruthy();
  });

  it("toasts an error command and can be dismissed", () => {
    const { rerender } = render(<CommandToasts commands={commandView([])} />);
    rerender(
      <CommandToasts
        commands={commandView([
          commandEntry({
            requestId: "e1",
            verb: "reload-config",
            phase: "error",
            result: undefined,
            error: { code: "FORBIDDEN", message: "no" },
          }),
        ])}
      />,
    );
    const toast = screen.getByTestId("cmd-toast-e1");
    expect(within(toast).getByText("Not permitted for your role")).toBeTruthy();
    // Carbon renders a close button inside the toast.
    fireEvent.click(within(toast).getByRole("button"));
    expect(screen.queryByTestId("cmd-toast-e1")).toBeNull();
  });
});
