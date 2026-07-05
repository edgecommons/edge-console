# Edge Console — Documentation

`com.edgecommons.edge-console` is an **edge-deployed, real-time web console** for a
[ggcommons](https://github.com/edgecommons/ggcommons) site. It **monitors and commands** every
component on the site — and it is the site's **sole browser↔bus bridge**: browsers speak HTTP + WebSocket
to the console, and only the console speaks MQTT / the Unified Namespace (UNS). It attaches to **one**
bus — the *site broker*, the aggregation point every device's
[`uns-bridge`](https://github.com/edgecommons/uns-bridge) relays into — subscribes six UNS class
wildcards, and needs **zero per-component knowledge** to render the whole fleet.

It is itself a **standard ggcommons TypeScript component** (a Node server built on
`@edgecommons/ggcommons`), so it deploys the same way as everything else — HOST, Greengrass, or
Kubernetes — and the library owns its config, messaging, logging, metrics, state keepalive and graceful
shutdown. The console adds the fleet model, the WebSocket gateway, the command gateway, and an IBM
**Carbon / React** UI on top.

| Doc | Start here when you want to… |
|-----|------------------------------|
| **[Tutorial](tutorial.md)** | learn by doing — bring the console up against a live (or simulated) fleet and see it in a browser |
| **[How-to guides](how-to-guides.md)** | accomplish a task — deploy it, point it at your broker, use each screen, command a component, lock down RBAC |
| **[Sample configurations](sample-configurations.md)** | copy a complete, runnable config for HOST / self-contained / Kubernetes / tuned deployments |
| **[Reference — Configuration](reference/configuration.md)** | look up every `component.global.console` option and its default |
| **[Reference — Data types](reference/data-types.md)** | look up the browser↔console **WebSocket protocol** — every frame, the snapshot/delta shapes, the liveness enum |
| **[Reference — Messaging interface](reference/messaging-interface.md)** | look up the console↔bus **UNS interface** — the six wildcards it consumes, the LWT path, and the command write path |
| **[Explanation](explanation.md)** | understand how it works and why — the single bridge, the retain substitute, console-side miss-detection, the two planes |

## Quick routing

- **"I'm new here."** → [Tutorial](tutorial.md).
- **"How do I deploy it / point it at my broker?"** → [How-to guides](how-to-guides.md).
- **"What config knob does X?"** → [Reference — Configuration](reference/configuration.md).
- **"What does my browser send/receive over the WebSocket?"** → [Reference — Data types](reference/data-types.md).
- **"Which UNS topics does it subscribe, and how does a command reach a component?"** → [Reference — Messaging interface](reference/messaging-interface.md).
- **"Why is the console the *only* thing that talks to the bus?"** → [Explanation](explanation.md).

## What ships today

Priority **#1 is edge health** (fleet liveness, per-value freshness, whole-device reachability); priority
**#2 is config review** (every component's effective, redacted config). The UI ships these screens, all
fed live from one WebSocket connection:

| Screen | What it shows |
|---|---|
| **Overview** (Edge health) | fleet-health rollup, active-alarm rollup, the console's own bus throughput + self vitals, and a fleet table dynamically grouped by each component's identity hierarchy |
| **Components** (+ Detail) | a navigable identity tree and per-component detail (Health / Instances / Configuration / Events tabs) |
| **Site Topology** | a derived connectivity graph — cloud/northbound → site bus → components → field/southbound |
| **Configuration** | a component picker beside its effective, source-redacted running config (Structured / Raw JSON), live, with a Refresh |
| **Events & Alarms** | the merged, newest-first alarm + event feed with a real Active/Ack/Contained alarm lifecycle |
| **Signals** | a data-plane browser over the UNS `data` class — latest value, quality, trend sparkline, age, on-demand Read |
| **Settings** | the console's own effective policy (RBAC, connection, staleness ladder, command deadlines, retention caps), read-only |

### Honest boundaries (verify against code, not the design doc)

These are deliberately deferred and are surfaced *as* pending in the product — the docs flag them too:

- **Transport is plain HTTP + WebSocket today.** The "HTTPS front" is achieved by **terminating TLS in
  front** of the console (reverse proxy / load balancer / Ingress); a native HTTPS listener is not yet
  built.
- **The read surface (snapshot + live streams) is unauthenticated.** RBAC on the command *write* path is
  really enforced, but the identity→role decision is a **stubbed seam** (every connection is assigned the
  configured default role). Do not expose the console beyond a trusted network yet. See
  [Explanation → Security](explanation.md#a-note-on-security).
- **No Kubernetes chart ships yet.** The server runs fine under the library's `KUBERNETES` platform, but
  you provide the Service + Ingress that reaches its WebSocket port.
- **The `describe` / panels capability manifest is a later phase**, so a component's custom-verb surface,
  the Component-Detail *Panel* / *Logs* tabs, and per-signal engineering units/limits are shown as
  present-but-pending, never fabricated.
- **There is no standalone Metrics page.** The UNS `metric` class is still consumed and streamable over
  the WebSocket, but the UI surfaces metrics through the Overview columns (CPU sparkline, connection
  state) and the Signals trends rather than a dedicated screen.

The **design source of truth** lives in the repo under `docs/design/` (the v0.3 DESIGN, the UNS
reconciliation + Phase-1 plan, the full-system-test runbook, and the signed-off mockups). Those are
planning artifacts — this Diátaxis set is the code-grounded user documentation.

## Audience

These docs are for **operators and integrators** — people who deploy the console, point it at a site
broker, and use it to watch and command a ggcommons fleet. They do not cover modifying the console's own
source.
