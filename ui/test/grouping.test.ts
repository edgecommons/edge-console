import { describe, expect, it } from "vitest";
import type { Liveness } from "@edgecommons/edge-console-protocol";
import {
  connLevel,
  groupFleet,
  matchesQuery,
  pluralizeUnit,
  rollupOfComponents,
} from "../src/fleet/grouping";
import { T0, compView, deviceView, fleetView, hier, key } from "./_fixtures";

/** A component on a [site, line, device] hierarchy. */
function lineComp(site: string, line: string, device: string, component: string, over = {}) {
  return compView({
    key: key(device, component),
    hier: hier(["site", site], ["line", line], ["device", device]),
    path: `${site}/${line}/${device}`,
    ...over,
  });
}

describe("groupFleet — [site, line, device] (one intermediate tier)", () => {
  const view = fleetView([
    deviceView("press-gw-01", [
      lineComp("dallas", "stamping", "press-gw-01", "opcua-adapter"),
      lineComp("dallas", "stamping", "press-gw-01", "modbus-adapter"),
    ]),
    deviceView("pack-gw-01", [
      lineComp("dallas", "packaging", "pack-gw-01", "opcua-adapter", { liveness: "OFFLINE" }),
    ]),
  ]);

  it("groups by the intermediate LINE level, not the device", () => {
    const g = groupFleet(view);
    expect(g.site).toBe("dallas");
    expect(g.levelNames).toEqual(["line"]);
    expect(g.unit).toBe("line");
    expect(g.unitCount).toBe(2); // stamping + packaging
    expect(g.total).toBe(3);
    expect(g.groups.map((n) => n.value)).toEqual(["packaging", "stamping"]); // sorted
    const stamping = g.groups.find((n) => n.value === "stamping")!;
    expect(stamping.level).toBe("line");
    expect(stamping.key).toBe("line=stamping");
    expect(stamping.children).toHaveLength(0); // innermost — components live here
    expect(stamping.components.map((c) => c.key.component)).toEqual([
      "modbus-adapter",
      "opcua-adapter",
    ]);
    expect(stamping.devices).toEqual(["press-gw-01"]);
    expect(stamping.rollup).toBe("healthy");
  });

  it("rolls the group tag worst-of (a line with an OFFLINE component is critical)", () => {
    const packaging = groupFleet(view).groups.find((n) => n.value === "packaging")!;
    expect(packaging.rollup).toBe("critical");
  });
});

describe("groupFleet — [enterprise, site, line, device]", () => {
  it("keeps site as the page context and groups below the named site level", () => {
    const view = fleetView([
      deviceView("gw-fill-01", [
        compView({
          key: key("gw-fill-01", "opcua-adapter"),
          hier: hier(
            ["enterprise", "bottles-r-us"],
            ["site", "dallas"],
            ["line", "filling-line"],
            ["device", "gw-fill-01"],
          ),
          path: "bottles-r-us/dallas/filling-line/gw-fill-01",
        }),
      ]),
    ]);

    const g = groupFleet(view);
    expect(g.site).toBe("dallas");
    expect(g.levelNames).toEqual(["line"]);
    expect(g.unit).toBe("line");
    expect(g.groups[0]!.key).toBe("line=filling-line");
    expect(g.groups[0]!.value).toBe("filling-line");
  });
});

describe("groupFleet — [site, device] (no intermediate tier ⇒ flat device list)", () => {
  const view = fleetView([
    deviceView("gw-01", [compView({ key: key("gw-01", "a") }), compView({ key: key("gw-01", "b") })]),
    deviceView("gw-02", [compView({ key: key("gw-02", "a") })]),
  ]);

  it("falls back to grouping by DEVICE", () => {
    const g = groupFleet(view);
    expect(g.levelNames).toEqual(["device"]);
    expect(g.unit).toBe("device");
    expect(g.unitCount).toBe(2);
    expect(g.groups.map((n) => n.value)).toEqual(["gw-01", "gw-02"]);
    expect(g.groups[0]!.key).toBe("device=gw-01");
    expect(g.groups[0]!.components).toHaveLength(2);
  });
});

describe("groupFleet — [site, area, line, device] (two intermediate tiers, nested)", () => {
  const mk = (area: string, line: string, device: string, comp: string, over = {}) =>
    compView({
      key: key(device, comp),
      hier: hier(["site", "dallas"], ["area", area], ["line", line], ["device", device]),
      path: `dallas/${area}/${line}/${device}`,
      ...over,
    });
  const view = fleetView([
    deviceView("w1", [mk("body", "weld", "w1", "opcua-adapter")]),
    deviceView("p1", [mk("body", "paint", "p1", "opcua-adapter", { liveness: "WARN" })]),
    deviceView("t1", [mk("trim", "trim-a", "t1", "opcua-adapter")]),
  ]);

  it("nests area → line", () => {
    const g = groupFleet(view);
    expect(g.levelNames).toEqual(["area", "line"]);
    expect(g.unit).toBe("line");
    expect(g.unitCount).toBe(3); // weld, paint, trim-a
    expect(g.groups.map((n) => n.value)).toEqual(["body", "trim"]);
    const body = g.groups.find((n) => n.value === "body")!;
    expect(body.level).toBe("area");
    expect(body.depth).toBe(0);
    expect(body.components).toHaveLength(0); // outer tier holds sub-groups, not rows
    expect(body.children.map((c) => c.value)).toEqual(["paint", "weld"]);
    const weld = body.children.find((c) => c.value === "weld")!;
    expect(weld.level).toBe("line");
    expect(weld.depth).toBe(1);
    expect(weld.key).toBe("area=body/line=weld");
    expect(weld.components).toHaveLength(1);
    expect(body.rollup).toBe("degraded"); // paint is WARN → body rolls up degraded
  });
});

describe("groupFleet — containment + filtering", () => {
  it("marks a group unreachable when its device is down and carries the since stamp", () => {
    const view = fleetView([
      deviceView(
        "asm-gw-01",
        [
          lineComp("dallas", "assembly", "asm-gw-01", "a", { liveness: "UNREACHABLE" }),
          lineComp("dallas", "assembly", "asm-gw-01", "b", { liveness: "UNREACHABLE" }),
        ],
        { unreachable: true, unreachableSince: T0 - 120_000 },
      ),
    ]);
    const g = groupFleet(view);
    const assembly = g.groups[0]!;
    expect(assembly.rollup).toBe("unreachable");
    expect(assembly.unreachable).toBe(true);
    expect(assembly.unreachableSince).toBe(T0 - 120_000);
    expect(assembly.count).toBe(2);
  });

  it("filters components before grouping (empty groups vanish)", () => {
    const view = fleetView([
      deviceView("press-gw-01", [
        lineComp("dallas", "stamping", "press-gw-01", "opcua-adapter"),
        lineComp("dallas", "stamping", "press-gw-01", "modbus-adapter"),
      ]),
      deviceView("pack-gw-01", [lineComp("dallas", "packaging", "pack-gw-01", "opcua-adapter")]),
    ]);
    const g = groupFleet(view, "modbus");
    expect(g.total).toBe(1);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]!.value).toBe("stamping");
    expect(g.groups[0]!.components.map((c) => c.key.component)).toEqual(["modbus-adapter"]);
  });

  it("filters by effective status before grouping (the fleet-tools Status control)", () => {
    const view = fleetView([
      deviceView("press-gw-01", [
        lineComp("dallas", "stamping", "press-gw-01", "opcua-adapter", { liveness: "FRESH" }),
        lineComp("dallas", "stamping", "press-gw-01", "modbus-adapter", { liveness: "OFFLINE" }),
      ]),
    ]);
    expect(groupFleet(view).total).toBe(2); // unfiltered
    const offline = groupFleet(view, "", "OFFLINE");
    expect(offline.total).toBe(1);
    expect(offline.groups[0]!.components.map((c) => c.key.component)).toEqual(["modbus-adapter"]);
    expect(groupFleet(view, "", "FRESH").total).toBe(1);
    // query + status compose (AND).
    expect(groupFleet(view, "opcua", "OFFLINE").total).toBe(0);
  });
});

describe("rollupOfComponents (worst-of)", () => {
  it("orders unreachable > offline > warn/stale > stopped > healthy", () => {
    const c = (liveness: Liveness) => compView({ liveness });
    expect(rollupOfComponents([])).toBe("empty");
    expect(rollupOfComponents([c("FRESH")])).toBe("healthy");
    expect(rollupOfComponents([c("STOPPED")])).toBe("stopped");
    expect(rollupOfComponents([c("FRESH"), c("STOPPED")])).toBe("healthy");
    expect(rollupOfComponents([c("FRESH"), c("WARN")])).toBe("degraded");
    expect(rollupOfComponents([c("FRESH"), c("OFFLINE")])).toBe("critical");
    expect(rollupOfComponents([c("FRESH"), c("UNREACHABLE")])).toBe("unreachable");
  });
});

describe("connLevel", () => {
  it("classifies the southbound connection state", () => {
    expect(connLevel(undefined)).toBe("unknown");
    expect(connLevel("")).toBe("unknown");
    expect(connLevel("CONNECTED")).toBe("ok");
    expect(connLevel("connected")).toBe("ok");
    expect(connLevel("RECONNECTING")).toBe("warn");
    expect(connLevel("DISCONNECTED")).toBe("err");
    expect(connLevel("weird-state")).toBe("warn");
  });
});

describe("matchesQuery", () => {
  const comp = compView({
    key: key("press-gw-01", "opcua-adapter"),
    hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
    path: "dallas/stamping/press-gw-01",
  });
  it("matches component, device, and hierarchy values (case-insensitive)", () => {
    expect(matchesQuery(comp, "")).toBe(true);
    expect(matchesQuery(comp, "OPCUA")).toBe(true);
    expect(matchesQuery(comp, "press")).toBe(true);
    expect(matchesQuery(comp, "stamping")).toBe(true);
    expect(matchesQuery(comp, "nope")).toBe(false);
  });
});

describe("pluralizeUnit", () => {
  it("pluralizes the header stat noun", () => {
    expect(pluralizeUnit("line", 1)).toBe("line");
    expect(pluralizeUnit("line", 3)).toBe("lines");
    expect(pluralizeUnit("device", 2)).toBe("devices");
    expect(pluralizeUnit("area", 2)).toBe("areas");
    expect(pluralizeUnit("facility", 2)).toBe("facilities");
    expect(pluralizeUnit("process", 2)).toBe("processes");
  });
});
