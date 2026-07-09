/**
 * The C4 CommandControls: built-in verb buttons fire `onInvoke`, pending/ok/error/
 * FORBIDDEN states render (and FORBIDDEN disables), the get-configuration result shows a
 * JSON pane, and the generic Send-command modal validates + invokes a custom verb.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CommandControls } from "../src/health/CommandControls";
import { commandEntry, commandView, compView, key } from "./_fixtures";

afterEach(cleanup);

const COMP = compView({ key: key("gw-01", "opcua-adapter") });
const ID = "gw-01/opcua-adapter";

/** A command entry already attributed to COMP (so componentId matches the row's id). */
const entry = (over: Parameters<typeof commandEntry>[0] = {}) => commandEntry({ key: COMP.key, ...over });

function renderControls(commands = commandView([]), onInvoke = vi.fn()) {
  render(<CommandControls comp={COMP} commands={commands} onInvoke={onInvoke} />);
  return { onInvoke };
}

describe("CommandControls - built-in buttons", () => {
  it("renders the three built-ins + the generic send affordance", () => {
    renderControls();
    expect(screen.getByTestId(`cmd-btn-ping-${ID}`)).toBeTruthy();
    expect(screen.getByTestId(`cmd-btn-reload-config-${ID}`)).toBeTruthy();
    expect(screen.getByTestId(`cmd-btn-get-configuration-${ID}`)).toBeTruthy();
    expect(screen.getByTestId(`cmd-send-open-${ID}`)).toBeTruthy();
    // Component-specific verbs are discovered through the descriptor panel path.
    expect(screen.getByText(/Panel tab when advertised/)).toBeTruthy();
  });

  it("fires onInvoke with the component key + verb when a button is clicked", () => {
    const { onInvoke } = renderControls();
    fireEvent.click(screen.getByTestId(`cmd-btn-ping-${ID}`));
    expect(onInvoke).toHaveBeenCalledWith(COMP.key, "ping");
    fireEvent.click(screen.getByTestId(`cmd-btn-reload-config-${ID}`));
    expect(onInvoke).toHaveBeenCalledWith(COMP.key, "reload-config");
  });
});

describe("CommandControls - result states", () => {
  it("disables a button while its command is pending", () => {
    renderControls(commandView([entry({ verb: "ping", phase: "pending", result: undefined })]));
    expect((screen.getByTestId(`cmd-btn-ping-${ID}`) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByTestId(`cmd-result-ping-${ID}`)).getByText(/ping…/)).toBeTruthy();
  });

  it("renders a ping success inline (status + uptime + elapsed)", () => {
    renderControls(
      commandView([entry({ verb: "ping", phase: "ok", result: { status: "RUNNING", uptimeSecs: 42 }, elapsedMs: 9 })]),
    );
    const line = screen.getByTestId(`cmd-result-ping-${ID}`);
    expect(within(line).getByText("RUNNING · uptime 42s")).toBeTruthy();
    expect(within(line).getByText(/9ms/)).toBeTruthy();
  });

  it("renders a FORBIDDEN result and disables that verb (retrying would deny again)", () => {
    renderControls(
      commandView([
        entry({ verb: "reload-config", phase: "error", result: undefined, error: { code: "FORBIDDEN", message: "no" } }),
      ]),
    );
    expect((screen.getByTestId(`cmd-btn-reload-config-${ID}`) as HTMLButtonElement).disabled).toBe(true);
    const line = screen.getByTestId(`cmd-result-reload-config-${ID}`);
    expect(within(line).getByText("Not permitted for your role")).toBeTruthy();
    expect(within(line).getByText(/FORBIDDEN/)).toBeTruthy();
  });

  it("renders a TIMEOUT result", () => {
    renderControls(
      commandView([
        entry({ verb: "ping", phase: "error", result: undefined, error: { code: "TIMEOUT", message: "late" } }),
      ]),
    );
    expect(within(screen.getByTestId(`cmd-result-ping-${ID}`)).getByText(/Timed out/)).toBeTruthy();
  });

  it("shows the effective config as a JSON pane for get-configuration", () => {
    renderControls(
      commandView([
        entry({
          verb: "get-configuration",
          phase: "ok",
          result: { config: { heartbeat: { intervalSecs: 5 } } },
        }),
      ]),
    );
    expect(screen.getByTestId(`cmd-json-${ID}`).textContent).toContain("intervalSecs");
  });
});

describe("CommandControls - generic send-command modal", () => {
  it("validates + invokes a custom verb with parsed JSON args", () => {
    const { onInvoke } = renderControls();
    fireEvent.click(screen.getByTestId(`cmd-send-open-${ID}`));

    fireEvent.change(screen.getByLabelText("Verb"), { target: { value: "restart-pipeline" } });
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: '{"force": true}' } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onInvoke).toHaveBeenCalledWith(COMP.key, "restart-pipeline", { force: true });
  });

  it("rejects invalid JSON args without invoking", () => {
    const { onInvoke } = renderControls();
    fireEvent.click(screen.getByTestId(`cmd-send-open-${ID}`));
    fireEvent.change(screen.getByLabelText("Verb"), { target: { value: "do-thing" } });
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: "not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onInvoke).not.toHaveBeenCalled();
    expect(screen.getByTestId(`cmd-send-error-${ID}`)).toBeTruthy();
  });

  it("rejects an empty verb", () => {
    const { onInvoke } = renderControls();
    fireEvent.click(screen.getByTestId(`cmd-send-open-${ID}`));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onInvoke).not.toHaveBeenCalled();
    expect(within(screen.getByTestId(`cmd-send-error-${ID}`)).getByText(/Enter a verb/)).toBeTruthy();
  });
});
