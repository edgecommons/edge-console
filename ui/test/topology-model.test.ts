import { describe, expect, it } from "vitest";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import type { ConfigView } from "../src/fleet/config-store";
import {
  LAYOUT,
  buildTopologyModel,
  hostFromUrl,
  layoutTopology,
  livenessStatus,
  parseEndpoints,
  worstStatus,
} from "../src/topology/topology-model";
import type { TopologyInputs } from "../src/topology/topology-model";
import {
  attributesView,
  compView,
  deviceView,
  fleetView,
  hier,
  key,
  runtimeAttrs,
} from "./_fixtures";

/** A loaded ConfigView from `(key, effectiveConfig)` pairs (wrapped as the `{config}` envelope). */
function cfgView(entries: Array<[ComponentKey, Record<string, unknown>]>): ConfigView {
  const entriesById: ConfigView["entriesById"] = {};
  for (const [k, config] of entries) {
    const id = `${k.device}/${k.component}/${k.instance}`;
    entriesById[id] = { key: k, id, phase: "loaded", body: { config }, receivedAt: 0, refreshing: false };
  }
  return { entriesById };
}

function inputs(overrides: Partial<TopologyInputs>): TopologyInputs {
  return {
    fleet: fleetView([]),
    configs: { entriesById: {} },
    attributes: { byId: {} },
    ...overrides,
  };
}

describe("hostFromUrl", () => {
  it("extracts host:port from scheme URLs", () => {
    expect(hostFromUrl("opc.tcp://192.168.1.180:49320")).toBe("192.168.1.180:49320");
    expect(hostFromUrl("opc.tcp://kep.local:4840/path")).toBe("kep.local:4840");
    expect(hostFromUrl("https://iot.example.com/ingest")).toBe("iot.example.com");
  });
  it("returns the input unchanged when it is not a URL", () => {
    expect(hostFromUrl("192.168.1.5")).toBe("192.168.1.5");
  });
});

describe("parseEndpoints", () => {
  it("parses an OPC UA endpoint as a southbound server", () => {
    const eps = parseEndpoints({ endpoint: { url: "opc.tcp://192.168.1.180:49320" } });
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ direction: "southbound", kind: "OPC UA", label: "192.168.1.180:49320" });
    expect(eps[0]!.sublabel).toContain("field");
  });

  it("parses a Modbus slave with host:port and unit", () => {
    const eps = parseEndpoints({ slave: { host: "192.168.1.224", port: 5020, unitId: 1 } });
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ direction: "southbound", kind: "Modbus", label: "192.168.1.224:5020" });
    expect(eps[0]!.sublabel).toBe("Modbus unit 1 · field");
  });

  it("parses a generic {host} endpoint and a plain server url", () => {
    expect(parseEndpoints({ server: { host: "plc-1" } })[0]).toMatchObject({
      direction: "southbound",
      kind: "Endpoint",
      label: "plc-1",
    });
    expect(parseEndpoints({ endpoint: { url: "tcp://10.0.0.9:502" } })[0]).toMatchObject({
      kind: "Endpoint",
      label: "10.0.0.9:502",
    });
  });

  it("parses instances[]-style multi-server adapters", () => {
    const eps = parseEndpoints({
      instances: [{ endpoint: { url: "opc.tcp://a:1" } }, { slave: { host: "b", port: 502 } }],
    });
    expect(eps.map((e) => e.label)).toEqual(["a:1", "b:502"]);
  });

  it("parses a northbound stream target and friendly-names the kind", () => {
    const eps = parseEndpoints({ streams: { northbound: { kind: "kinesis" } } });
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ direction: "northbound", label: "Kinesis" });
    expect(parseEndpoints({ northbound: { kind: "iot-core" } })[0]!.label).toBe("AWS IoT Core");
    expect(parseEndpoints({ targets: [{ kind: "s3" }] })[0]!.label).toBe("S3");
    expect(parseEndpoints({ targets: [{ url: "https://ingest.acme.io/v1" }] })[0]).toMatchObject({
      direction: "northbound",
      label: "ingest.acme.io",
    });
  });

  it("dedups a repeated endpoint into one", () => {
    const eps = parseEndpoints({
      endpoints: [{ url: "opc.tcp://a:1" }, { url: "opc.tcp://a:1" }],
    });
    expect(eps).toHaveLength(1);
  });

  it("returns nothing for empty/garbage config", () => {
    expect(parseEndpoints(undefined)).toEqual([]);
    expect(parseEndpoints(42)).toEqual([]);
    expect(parseEndpoints({ heartbeat: { intervalSecs: 5 } })).toEqual([]);
    expect(parseEndpoints({ slave: { port: 5020 } })).toEqual([]); // no host → nothing
  });
});

describe("livenessStatus / worstStatus", () => {
  it("maps liveness to a node status", () => {
    expect(livenessStatus("FRESH")).toBe("ok");
    expect(livenessStatus("WARN")).toBe("warn");
    expect(livenessStatus("OFFLINE")).toBe("err");
    expect(livenessStatus("STOPPED")).toBe("stopped");
    expect(livenessStatus("UNREACHABLE")).toBe("contained");
  });
  it("picks the worse of two statuses", () => {
    expect(worstStatus("ok", "err")).toBe("err");
    expect(worstStatus("warn", "ok")).toBe("warn");
    expect(worstStatus("neutral", "ok")).toBe("ok");
    expect(worstStatus("contained", "warn")).toBe("contained");
  });
});

describe("buildTopologyModel — a 3-level hierarchy with endpoints", () => {
  const opcua = key("press-gw-01", "opcua-adapter");
  const modbus = key("press-gw-01", "modbus-adapter");
  const proc = key("press-gw-01", "telemetry-processor");
  const h = hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]);

  const model = buildTopologyModel(
    inputs({
      fleet: fleetView([
        deviceView("press-gw-01", [
          compView({ key: opcua, hier: h, liveness: "FRESH" }),
          compView({ key: modbus, hier: h, liveness: "FRESH" }),
          compView({ key: proc, hier: h, liveness: "FRESH" }),
        ]),
      ]),
      configs: cfgView([
        [opcua, { endpoint: { url: "opc.tcp://192.168.1.180:49320" } }],
        [modbus, { slave: { host: "192.168.1.224", port: 5020, unitId: 1 } }],
        [proc, { streams: { northbound: { kind: "kinesis" } } }],
      ]),
      attributes: attributesView([
        runtimeAttrs(opcua, { platform: "GREENGRASS", connectionState: "CONNECTED" }),
        runtimeAttrs(modbus, { connectionState: "DISCONNECTED", readErrors: 3 }),
      ]),
      broker: "EMQX @ gateway",
    }),
  );

  it("derives the group caption dynamically (line · device · platform)", () => {
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]!.label).toBe("stamping · press-gw-01 · Greengrass");
    expect(model.groups[0]!.unreachable).toBe(false);
    expect(model.site).toBe("dallas");
  });

  it("emits component, field, cloud and bus nodes", () => {
    expect(model.stats).toEqual({
      components: 3,
      fieldEndpoints: 2,
      cloudEndpoints: 1,
      devices: 1,
      edges: 4, // 2 southbound + 1 comp→bus + 1 bus→cloud
    });
    expect(model.bus.label).toBe("Site UNS broker · EMQX @ gateway");
    const cloud = model.nodes.find((n) => n.kind === "cloud");
    expect(cloud?.label).toBe("Kinesis");
  });

  it("colors the southbound edge from the live connection state (up but link down)", () => {
    const modbusEdge = model.edges.find((e) => e.from === `comp:${modbus.device}/${modbus.component}/main`);
    expect(modbusEdge?.kind).toBe("southbound");
    expect(modbusEdge?.status).toBe("err");
    expect(modbusEdge?.disconnected).toBe(true);
    expect(modbusEdge?.label).toContain("DISCONNECTED");
    // the field node it points at goes red
    const field = model.nodes.find((n) => n.id === modbusEdge?.to);
    expect(field?.status).toBe("err");
  });

  it("keeps a healthy southbound edge green, and its field node neutral", () => {
    const opcEdge = model.edges.find((e) => e.from === `comp:${opcua.device}/${opcua.component}/main`);
    expect(opcEdge?.status).toBe("ok");
    expect(opcEdge?.disconnected).toBeUndefined();
    const field = model.nodes.find((n) => n.id === opcEdge?.to);
    expect(field?.status).toBe("neutral");
  });

  it("relays the processor northbound through the bus to the cloud", () => {
    const compId = `comp:${proc.device}/${proc.component}/main`;
    expect(model.edges.some((e) => e.from === compId && e.to === "bus" && e.kind === "bus")).toBe(true);
    const nb = model.edges.find((e) => e.from === "bus" && e.kind === "northbound");
    expect(nb?.status).toBe("ok");
  });

  it("flags cross-component data-flow as not derivable", () => {
    expect(model.crossComponentFlow.derivable).toBe(false);
    expect(model.crossComponentFlow.note).toMatch(/flow metadata/i);
  });
});

describe("buildTopologyModel — hierarchy shapes + containment", () => {
  it("labels a 2-level [site, device] group with just the device (+ platform)", () => {
    const k = key("gw-01", "opcua-adapter");
    const model = buildTopologyModel(
      inputs({
        fleet: fleetView([
          deviceView("gw-01", [compView({ key: k, hier: hier(["site", "dallas"], ["device", "gw-01"]) })]),
        ]),
        attributes: attributesView([runtimeAttrs(k, { platform: "HOST" })]),
      }),
    );
    expect(model.groups[0]!.label).toBe("gw-01 · HOST");
  });

  it("contains the subtree of an UNREACHABLE device (down bridge, not each component)", () => {
    const k = key("asm-gw-01", "opcua-adapter");
    const model = buildTopologyModel(
      inputs({
        fleet: fleetView([
          deviceView(
            "asm-gw-01",
            [compView({ key: k, hier: hier(["site", "dallas"], ["device", "asm-gw-01"]), liveness: "UNREACHABLE" })],
            { unreachable: true, unreachableSince: 1 },
          ),
        ]),
        configs: cfgView([[k, { endpoint: { url: "opc.tcp://kep:4840" } }]]),
      }),
    );
    expect(model.groups[0]!.unreachable).toBe(true);
    const comp = model.nodes.find((n) => n.kind === "component");
    expect(comp?.status).toBe("contained");
    const edge = model.edges.find((e) => e.kind === "southbound");
    expect(edge?.status).toBe("contained");
    expect(edge?.disconnected).toBe(true);
  });

  it("degrades the southbound edge to warn while reconnecting", () => {
    const k = key("gw-01", "modbus-adapter");
    const model = buildTopologyModel(
      inputs({
        fleet: fleetView([deviceView("gw-01", [compView({ key: k })])]),
        configs: cfgView([[k, { slave: { host: "plc", port: 502 } }]]),
        attributes: attributesView([runtimeAttrs(k, { connectionState: "RECONNECTING" })]),
      }),
    );
    const edge = model.edges.find((e) => e.kind === "southbound");
    expect(edge?.status).toBe("warn");
    expect(edge?.label).toContain("reconnecting");
  });

  it("labels read errors on a connected southbound edge", () => {
    const k = key("gw-01", "opcua-adapter");
    const model = buildTopologyModel(
      inputs({
        fleet: fleetView([deviceView("gw-01", [compView({ key: k })])]),
        configs: cfgView([[k, { endpoint: { url: "opc.tcp://kep:4840" } }]]),
        attributes: attributesView([runtimeAttrs(k, { connectionState: "CONNECTED", readErrors: 7 })]),
      }),
    );
    expect(model.edges.find((e) => e.kind === "southbound")?.label).toContain("read errors");
  });

  it("draws component nodes but no edges when cfg has not loaded yet", () => {
    const k = key("gw-01", "opcua-adapter");
    const model = buildTopologyModel(
      inputs({ fleet: fleetView([deviceView("gw-01", [compView({ key: k })])]) }),
    );
    expect(model.stats.components).toBe(1);
    expect(model.stats.edges).toBe(0);
    expect(model.stats.fieldEndpoints).toBe(0);
    // the bus node is still present (where the console observes)
    expect(model.nodes.some((n) => n.kind === "bus")).toBe(true);
  });

  it("merges a shared endpoint referenced by two components into one field node", () => {
    const a = key("gw-01", "opcua-adapter", "a");
    const b = key("gw-01", "opcua-adapter", "b");
    const url = { endpoint: { url: "opc.tcp://shared:4840" } };
    const model = buildTopologyModel(
      inputs({
        fleet: fleetView([deviceView("gw-01", [compView({ key: a }), compView({ key: b })])]),
        configs: cfgView([[a, url], [b, url]]),
      }),
    );
    expect(model.stats.fieldEndpoints).toBe(1);
    expect(model.edges.filter((e) => e.kind === "southbound")).toHaveLength(2);
  });
});

describe("layoutTopology", () => {
  const opcua = key("press-gw-01", "opcua-adapter");
  const proc = key("pack-gw-01", "telemetry-processor");
  const model = buildTopologyModel(
    inputs({
      fleet: fleetView([
        deviceView("press-gw-01", [compView({ key: opcua, hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]) })]),
        deviceView("pack-gw-01", [compView({ key: proc, hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]) })]),
      ]),
      configs: cfgView([
        [opcua, { endpoint: { url: "opc.tcp://192.168.1.180:49320" } }],
        [proc, { streams: { northbound: { kind: "kinesis" } } }],
      ]),
    }),
  );
  const layout = layoutTopology(model);

  it("has a canvas at least the minimum width and the fixed height", () => {
    expect(layout.width).toBeGreaterThanOrEqual(LAYOUT.minWidth);
    expect(layout.height).toBe(LAYOUT.height);
  });

  it("stacks the layers cloud < bus < components < field (by y)", () => {
    const y = (kind: string): number => layout.nodes.find((n) => n.kind === kind)!.y;
    expect(y("cloud")).toBeLessThan(y("bus"));
    expect(y("bus")).toBeLessThan(y("component"));
    expect(y("component")).toBeLessThan(y("field"));
  });

  it("keeps every node inside the canvas", () => {
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(layout.width + 0.5);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it("routes southbound edges downward and the relay edges upward", () => {
    const sb = layout.edges.find((e) => e.kind === "southbound")!;
    expect(sb.y2).toBeGreaterThan(sb.y1);
    const busEdge = layout.edges.find((e) => e.kind === "bus")!;
    expect(busEdge.y2).toBeLessThan(busEdge.y1);
    const nb = layout.edges.find((e) => e.kind === "northbound")!;
    expect(nb.y2).toBeLessThan(nb.y1);
  });

  it("places one group box per device, enclosing the component band", () => {
    expect(layout.groups).toHaveLength(2);
    const comp = layout.nodes.find((n) => n.kind === "component")!;
    const grp = layout.groups[0]!;
    expect(comp.y).toBeGreaterThanOrEqual(grp.y);
  });

  it("is deterministic", () => {
    expect(layoutTopology(model)).toEqual(layout);
  });

  it("lays out an empty fleet as just the bus node at the default width", () => {
    const empty = layoutTopology(buildTopologyModel(inputs({})));
    expect(empty.width).toBe(LAYOUT.minWidth);
    expect(empty.groups).toHaveLength(0);
    expect(empty.nodes.map((n) => n.kind)).toEqual(["bus"]);
  });
});
