import { describe, expect, it } from "vitest";
import {
  buildComponentTree,
  collectComponents,
  findComponent,
  findNode,
} from "../src/components/components-tree";
import type { ComponentTreeNode } from "../src/components/components-tree";
import { compView, deviceView, fleetView, hier, key } from "./_fixtures";

describe("buildComponentTree — dynamic hierarchy", () => {
  it("builds Site → line → device → component from a 3-level hier (never hardcodes 'line')", () => {
    const h3 = (line: string, device: string, component: string, liveness = "FRESH" as const) =>
      compView({
        key: key(device, component),
        hier: hier(["site", "dallas"], ["line", line], ["device", device]),
        liveness,
      });
    const tree = buildComponentTree(
      fleetView([
        deviceView("press-gw-01", [
          h3("stamping", "press-gw-01", "opcua-adapter"),
          h3("stamping", "press-gw-01", "modbus-adapter"),
        ]),
        deviceView("pack-gw-01", [h3("packaging", "pack-gw-01", "opcua-adapter")]),
      ]),
    );

    expect(tree.site).toBe("dallas");
    expect(tree.total).toBe(3);
    expect(tree.roots).toHaveLength(1);

    const site = tree.roots[0]!;
    expect(site.kind).toBe("group");
    expect(site.level).toBe("site");
    expect(site.value).toBe("dallas");
    expect(site.count).toBe(3);

    // Two line groups (dynamic), sorted.
    const lines = site.children;
    expect(lines.map((l) => l.value)).toEqual(["packaging", "stamping"]);
    expect(lines.every((l) => l.level === "line")).toBe(true);

    // stamping → its device → two component leaves.
    const stamping = lines.find((l) => l.value === "stamping")!;
    expect(stamping.count).toBe(2);
    const device = stamping.children[0]!;
    expect(device.level).toBe("device");
    expect(device.value).toBe("press-gw-01");
    expect(device.children.every((c) => c.kind === "component")).toBe(true);
    expect(device.children.map((c) => c.value)).toEqual(["modbus-adapter", "opcua-adapter"]);
  });

  it("degrades to Site → device → component with no intermediate tier (2-level hier)", () => {
    const tree = buildComponentTree(
      fleetView([
        deviceView("gw-01", [
          compView({ key: key("gw-01", "opcua-adapter"), hier: hier(["site", "dallas"], ["device", "gw-01"]) }),
        ]),
      ]),
    );
    const site = tree.roots[0]!;
    expect(site.value).toBe("dallas");
    const device = site.children[0]!;
    expect(device.level).toBe("device");
    expect(device.value).toBe("gw-01");
    expect(device.children[0]!.kind).toBe("component");
  });

  it("nests as deep as the hier goes (4-level: site → area → line → device)", () => {
    const tree = buildComponentTree(
      fleetView([
        deviceView("weld-01", [
          compView({
            key: key("weld-01", "opcua-adapter"),
            hier: hier(["site", "dallas"], ["area", "body"], ["line", "weld"], ["device", "weld-01"]),
          }),
        ]),
      ]),
    );
    // site(0) → area(1) → line(2) → device(3) → component(4)
    const levels: string[] = [];
    let node: ComponentTreeNode | undefined = tree.roots[0];
    while (node !== undefined) {
      levels.push(node.level);
      node = node.children[0];
    }
    expect(levels).toEqual(["site", "area", "line", "device", "component"]);
  });

  it("falls back to a device group when a component advertises no hierarchy", () => {
    const tree = buildComponentTree(
      fleetView([deviceView("gw-x", [compView({ key: key("gw-x", "orphan"), hier: [] })])]),
    );
    expect(tree.site).toBeUndefined();
    const device = tree.roots[0]!;
    expect(device.level).toBe("device");
    expect(device.value).toBe("gw-x");
    expect(device.children[0]!.value).toBe("orphan");
  });

  it("rolls up worst-of health and propagates device-UNREACHABLE containment up the path", () => {
    const tree = buildComponentTree(
      fleetView([
        deviceView(
          "asm-gw-01",
          [
            compView({
              key: key("asm-gw-01", "telemetry-processor"),
              hier: hier(["site", "dallas"], ["line", "assembly"], ["device", "asm-gw-01"]),
              liveness: "UNREACHABLE",
            }),
          ],
          { unreachable: true, unreachableSince: 100 },
        ),
        deviceView("pack-gw-01", [
          compView({
            key: key("pack-gw-01", "modbus-adapter"),
            hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
            liveness: "OFFLINE",
          }),
        ]),
      ]),
    );
    const site = tree.roots[0]!;
    expect(site.unreachable).toBe(true); // contained through the assembly branch
    const assembly = site.children.find((l) => l.value === "assembly")!;
    expect(assembly.rollup).toBe("unreachable");
    expect(assembly.unreachable).toBe(true);
    const packaging = site.children.find((l) => l.value === "packaging")!;
    expect(packaging.rollup).toBe("critical"); // an OFFLINE component
    expect(packaging.unreachable).toBe(false);
  });

  it("filters BEFORE building (empty branches vanish) — the app-bar search meets the tree", () => {
    const build = (query: string) =>
      buildComponentTree(
        fleetView([
          deviceView("press-gw-01", [
            compView({
              key: key("press-gw-01", "opcua-adapter"),
              hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
            }),
          ]),
          deviceView("pack-gw-01", [
            compView({
              key: key("pack-gw-01", "modbus-adapter"),
              hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
            }),
          ]),
        ]),
        query,
      );

    const all = build("");
    expect(all.total).toBe(2);
    expect(all.roots[0]!.children.map((l) => l.value)).toEqual(["packaging", "stamping"]);

    const filtered = build("opcua");
    expect(filtered.total).toBe(1);
    // Only the stamping branch survives (packaging had no match).
    expect(filtered.roots[0]!.children.map((l) => l.value)).toEqual(["stamping"]);
  });

  it("filters by effective liveness (statusFilter)", () => {
    const tree = buildComponentTree(
      fleetView([
        deviceView("gw-01", [
          compView({ key: key("gw-01", "a"), hier: hier(["site", "s"], ["device", "gw-01"]), liveness: "FRESH" }),
          compView({ key: key("gw-01", "b"), hier: hier(["site", "s"], ["device", "gw-01"]), liveness: "OFFLINE" }),
        ]),
      ]),
      "",
      "OFFLINE",
    );
    expect(tree.total).toBe(1);
    expect(collectComponents(tree.roots[0]!).map((c) => c.key.component)).toEqual(["b"]);
  });
});

describe("collectComponents / findNode / findComponent", () => {
  const tree = buildComponentTree(
    fleetView([
      deviceView("press-gw-01", [
        compView({
          key: key("press-gw-01", "opcua-adapter"),
          hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
        }),
        compView({
          key: key("press-gw-01", "modbus-adapter"),
          hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
        }),
      ]),
    ]),
  );

  it("rosters every component beneath a group node", () => {
    const site = tree.roots[0]!;
    expect(collectComponents(site).map((c) => c.key.component).sort()).toEqual([
      "modbus-adapter",
      "opcua-adapter",
    ]);
  });

  it("rosters a single leaf as itself", () => {
    const leaf = findNode(tree.roots, "press-gw-01/opcua-adapter/main")!;
    expect(leaf.kind).toBe("component");
    expect(collectComponents(leaf)).toHaveLength(1);
  });

  it("findNode locates a group by its path key and returns undefined for a miss", () => {
    expect(findNode(tree.roots, "site=dallas/line=stamping")?.value).toBe("stamping");
    expect(findNode(tree.roots, "nope")).toBeUndefined();
  });

  it("findComponent locates a live component by key", () => {
    const view = fleetView([
      deviceView("gw-01", [compView({ key: key("gw-01", "opcua-adapter") })]),
    ]);
    expect(findComponent(view, key("gw-01", "opcua-adapter"))?.key.component).toBe("opcua-adapter");
    expect(findComponent(view, key("gw-01", "missing"))).toBeUndefined();
  });
});
