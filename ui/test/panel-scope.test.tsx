/**
 * Scope-driven panel addressing (core DESIGN-scoped-commands §2.3): each `describe.commands[]`
 * entry declares its verb's scope, and the Panel tab derives its addressing UI from it —
 *
 *  - `instance`  — the selector mounts and EVERY invocation names the selected instance;
 *  - `component` — no selector involvement, and no invocation ever carries `instance`;
 *  - `both`      — the selector plus an explicit "Whole component" choice that sends no instance;
 *  - absent      — the pre-0.5.0 fallback: today's widget-level `scope` heuristics, unchanged.
 *
 * The pure scope resolution is unit-tested here too, so the rules hold independently of the DOM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  ComponentDescribeManifest,
  PanelViewDescriptor,
  PanelWidgetDescriptor,
} from "@edgecommons/edge-console-protocol";
import { ComponentDetailView } from "../src/components/ComponentDetailView";
import {
  combinedCommandScope,
  declaredCommandScope,
  effectiveWidgetScope,
  panelViewAddressing,
  scopeSendsInstance,
  widgetVerbs,
} from "../src/components/panel-descriptor";
import { T0, clientState, compView, deviceView, fleetView, hier, key } from "./_fixtures";

afterEach(cleanup);
afterEach(() => window.history.replaceState(null, "", "/"));

const DKEY = key("pack-gw-01", "opcua-adapter");
const ID = "pack-gw-01/opcua-adapter";

/** An actionBar bound to one verb — the smallest command-bound widget. */
function actionWidget(verb: string, overrides: Partial<PanelWidgetDescriptor> = {}): PanelWidgetDescriptor {
  return {
    kind: "actionBar",
    id: `act-${verb.replace(/\W/g, "-")}`,
    title: "Actions",
    actions: [{ verb, label: `Run ${verb}` }],
    ...overrides,
  };
}

function view(id: string, widgets: PanelWidgetDescriptor[], overrides: Partial<PanelViewDescriptor> = {}) {
  return { id, title: id, order: 10, widgets, ...overrides } as PanelViewDescriptor;
}

function manifestOf(
  views: PanelViewDescriptor[],
  commands: ComponentDescribeManifest["commands"],
): ComponentDescribeManifest {
  return {
    schema: "edgecommons.component.describe.v1",
    component: { component: "opcua-adapter" },
    digest: "sha256:scope",
    commands,
    panels: {
      schema: "edgecommons.panels.v2",
      provider: "opcua-adapter",
      renderer: "descriptor",
      defaultView: views[0]?.id ?? "",
      views,
    },
  };
}

function stateWith(manifest: ComponentDescribeManifest) {
  return clientState(
    fleetView([
      deviceView("pack-gw-01", [
        compView({
          key: DKEY,
          hier: hier(["site", "dallas"], ["device", "pack-gw-01"]),
          instances: [
            { instance: "kep1", connected: true },
            { instance: "kep2", connected: true },
          ],
        }),
      ]),
    ]),
    {
      descriptions: {
        entriesById: {
          [ID]: { key: DKEY, id: ID, phase: "ready" as const, manifest, receivedAt: T0 - 1000, refreshing: false },
        },
      },
    },
  );
}

function renderPanel(manifest: ComponentDescribeManifest) {
  const cbs = { onInvoke: vi.fn(), onRefreshDescriptor: vi.fn() };
  render(<ComponentDetailView state={stateWith(manifest)} now={T0} detailKey={DKEY} {...cbs} />);
  fireEvent.click(screen.getByTestId("tab-panel"));
  return cbs;
}

function fire(label: string) {
  fireEvent.click(within(screen.getByTestId("panel-action-bar")).getByRole("button", { name: label }));
}

describe("declared command scope — the pure resolution", () => {
  const manifest = manifestOf([], [
    { verb: "sb/browse", scope: "instance" },
    { verb: "sb/discover", scope: "component" },
    { verb: "sb/status", scope: "both" },
    { verb: "legacy/verb" },
    { verb: "weird/verb", scope: "galactic" as never },
  ]);

  it("reads the declared scope, and ignores unknown/absent/unadvertised verbs", () => {
    expect(declaredCommandScope(manifest, "sb/browse")).toBe("instance");
    expect(declaredCommandScope(manifest, "sb/discover")).toBe("component");
    expect(declaredCommandScope(manifest, "sb/status")).toBe("both");
    expect(declaredCommandScope(manifest, "legacy/verb")).toBeUndefined();
    expect(declaredCommandScope(manifest, "weird/verb")).toBeUndefined();
    expect(declaredCommandScope(manifest, "never/advertised")).toBeUndefined();
    expect(declaredCommandScope(manifest, undefined)).toBeUndefined();
    expect(declaredCommandScope(undefined, "sb/browse")).toBeUndefined();
  });

  it("combines a widget's verbs with the strictest addressing winning", () => {
    expect(combinedCommandScope(manifest, ["sb/discover"])).toBe("component");
    expect(combinedCommandScope(manifest, ["sb/status"])).toBe("both");
    expect(combinedCommandScope(manifest, ["sb/status", "sb/browse"])).toBe("instance");
    expect(combinedCommandScope(manifest, ["sb/status", "sb/discover"])).toBe("both");
    expect(combinedCommandScope(manifest, ["legacy/verb", undefined])).toBeUndefined();
  });

  it("collects every verb key a widget binds, including its actions", () => {
    expect(
      widgetVerbs({
        kind: "treeBrowser",
        browseVerb: "sb/browse",
        readVerb: "sb/read",
        writeVerb: "",
        actions: [{ verb: "sb/pause" }, { verb: 7 }, "nope"],
      }),
    ).toEqual(["sb/browse", "sb/read", "sb/pause"]);
  });

  it("falls back to the widget-level marker only when NO bound verb declares a scope", () => {
    // Declared scope wins over the widget marker, in both directions.
    expect(effectiveWidgetScope(manifest, actionWidget("sb/discover", { scope: "instance" }))).toBe("component");
    expect(effectiveWidgetScope(manifest, actionWidget("sb/browse", { scope: "component" }))).toBe("instance");
    // Undeclared verb ⇒ the legacy heuristic.
    expect(effectiveWidgetScope(manifest, actionWidget("legacy/verb", { scope: "instance" }))).toBe("instance");
    expect(effectiveWidgetScope(manifest, actionWidget("legacy/verb"))).toBe("component");
  });

  it("maps a scope + the whole-component choice onto whether the invocation carries an instance", () => {
    expect(scopeSendsInstance("component", false)).toBe(false);
    expect(scopeSendsInstance("component", true)).toBe(false);
    expect(scopeSendsInstance("instance", false)).toBe(true);
    expect(scopeSendsInstance("instance", true)).toBe(true);
    expect(scopeSendsInstance("both", false)).toBe(true);
    expect(scopeSendsInstance("both", true)).toBe(false);
  });

  it("derives the view's affordances: selector, and 'Whole component' only for an all-both view", () => {
    const bothView = view("v", [actionWidget("sb/status")]);
    const instView = view("v", [actionWidget("sb/browse")]);
    const compV = view("v", [actionWidget("sb/discover")]);
    const mixed = view("v", [actionWidget("sb/status"), actionWidget("sb/browse")]);
    expect(panelViewAddressing(manifest, bothView)).toEqual({ needsInstance: true, allowWholeComponent: true });
    expect(panelViewAddressing(manifest, instView)).toEqual({ needsInstance: true, allowWholeComponent: false });
    expect(panelViewAddressing(manifest, compV)).toEqual({ needsInstance: false, allowWholeComponent: false });
    // Mixed: one widget REQUIRES an instance, so whole-component is not offered.
    expect(panelViewAddressing(manifest, mixed)).toEqual({ needsInstance: true, allowWholeComponent: false });
    // A view-level scope:"instance" marker keeps its legacy selector trigger.
    expect(panelViewAddressing(manifest, view("v", [], { scope: "instance" }))).toEqual({
      needsInstance: true,
      allowWholeComponent: false,
    });
    // The legacy widget heuristic still drives views whose verbs declare nothing.
    expect(panelViewAddressing(manifest, view("v", [actionWidget("legacy/verb", { scope: "instance" })]))).toEqual({
      needsInstance: true,
      allowWholeComponent: false,
    });
  });
});

describe("Panel addressing — scope: instance", () => {
  it("mounts the selector and always sends the selected instance", () => {
    const cbs = renderPanel(
      manifestOf([view("browse", [actionWidget("sb/browse")])], [{ verb: "sb/browse", scope: "instance" }]),
    );
    expect(screen.getByTestId("panel-instance-selector")).toBeTruthy();
    fire("Run sb/browse");
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/browse", { instance: "kep1" });
    fireEvent.change(screen.getByTestId("panel-instance-selector"), { target: { value: "kep2" } });
    fire("Run sb/browse");
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/browse", { instance: "kep2" });
    // No whole-component escape hatch on an instance-scoped view.
    expect(screen.queryByRole("option", { name: "Whole component" })).toBeNull();
  });

  it("mounts the selector even when the widget carries no scope marker of its own", () => {
    renderPanel(
      manifestOf(
        [view("browse", [actionWidget("sb/browse")], { scope: "component" })],
        [{ verb: "sb/browse", scope: "instance" }],
      ),
    );
    expect(screen.getByTestId("panel-instance-selector")).toBeTruthy();
  });
});

describe("Panel addressing — scope: component", () => {
  it("never mounts the selector and never sends an instance, even under an instance-marked view", () => {
    const cbs = renderPanel(
      manifestOf(
        [view("discovery", [actionWidget("sb/discover", { scope: "instance" })])],
        [{ verb: "sb/discover", scope: "component" }],
      ),
    );
    expect(screen.queryByTestId("panel-instance-row")).toBeNull();
    fire("Run sb/discover");
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/discover", {});
  });
});

describe("Panel addressing — scope: both", () => {
  const manifest = manifestOf([view("status", [actionWidget("sb/status")])], [{ verb: "sb/status", scope: "both" }]);

  it("offers 'Whole component' alongside the instances, defaulting to the first instance", () => {
    const cbs = renderPanel(manifest);
    const select = screen.getByTestId("panel-instance-selector") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Whole component", "kep1", "kep2"]);
    expect(select.value).toBe("kep1");
    fire("Run sb/status");
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/status", { instance: "kep1" });
  });

  it("sends NO instance once 'Whole component' is chosen, and resumes per-instance after", () => {
    const cbs = renderPanel(manifest);
    const select = screen.getByTestId("panel-instance-selector") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__component__" } });
    fire("Run sb/status");
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/status", {});
    fireEvent.change(select, { target: { value: "kep2" } });
    fire("Run sb/status");
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/status", { instance: "kep2" });
  });

  it("drops a whole-component choice when the operator opens a view that requires an instance", () => {
    const cbs = renderPanel(
      manifestOf(
        [view("status", [actionWidget("sb/status")]), view("browse", [actionWidget("sb/browse")], { order: 20 })],
        [
          { verb: "sb/status", scope: "both" },
          { verb: "sb/browse", scope: "instance" },
        ],
      ),
    );
    fireEvent.change(screen.getByTestId("panel-instance-selector"), { target: { value: "__component__" } });
    fireEvent.click(within(screen.getByTestId("descriptor-panel")).getByRole("tab", { name: "browse" }));
    expect(screen.queryByRole("option", { name: "Whole component" })).toBeNull();
    fire("Run sb/browse");
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/browse", { instance: "kep1" });
  });
});

describe("Panel addressing — no declared scope (pre-0.5.0 components)", () => {
  it("keeps today's widget-scope heuristics", () => {
    const cbs = renderPanel(
      manifestOf(
        [
          view("legacy", [
            actionWidget("sb/browse", { id: "act-inst", scope: "instance" }),
            actionWidget("sb/discover", { id: "act-comp" }),
          ]),
        ],
        [{ verb: "sb/browse" }, { verb: "sb/discover" }],
      ),
    );
    // A widget marked scope:"instance" still drives the selector and sends the instance.
    expect(screen.getByTestId("panel-instance-selector")).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Whole component" })).toBeNull();
    fireEvent.click(
      within(screen.getByTestId("panel-widget-act-inst")).getByRole("button", { name: "Run sb/browse" }),
    );
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/browse", { instance: "kep1" });
    // An unmarked widget stays component-addressed, exactly as before.
    fireEvent.click(
      within(screen.getByTestId("panel-widget-act-comp")).getByRole("button", { name: "Run sb/discover" }),
    );
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/discover", {});
  });
});
