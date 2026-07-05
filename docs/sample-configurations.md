# Sample Configurations

Complete, runnable configuration documents for the common deployment shapes. Each is a full JSON file you
can drop in as `-c FILE <path>` (and, for MQTT transport, as `--transport MQTT <path>`). For the meaning
of every field see [reference — configuration](reference/configuration.md); for the deployment steps see
the [how-to guides](how-to-guides.md).

All console-specific knobs live under `component.global.console`; **every field is optional** (lenient
parsing with defaults), so a real config is often much shorter than these annotated examples.

---

## 1. Minimal HOST (dev rig)

The smallest useful config — this is essentially the shipped `test-configs/config.json`. It points at a
local site broker and takes every console default. Run it with:

```bash
node server/dist/main.js --platform HOST --transport MQTT ./config.json -c FILE ./config.json -t site-console
```

```jsonc
{
  "logging": { "level": "INFO" },
  "heartbeat": { "enabled": true, "intervalSecs": 5 },
  "metricEmission": { "target": "messaging" },

  "messaging": {
    "local": { "host": "localhost", "port": 1884, "clientId": "edge-console" },
    "requestTimeoutSeconds": 30
  },

  "hierarchy": { "levels": ["site", "device"] },
  "identity": { "site": "dallas" },

  "component": {
    "global": {
      "console": {
        "ws": { "port": 8443, "bindAddress": "0.0.0.0", "heartbeatIntervalMs": 15000 },
        "staleness": {
          "warnMultiplier": 2, "staleMultiplier": 2.5, "offlineMultiplier": 5,
          "defaultIntervalSecs": 5, "sweepIntervalMs": 1000
        },
        "cache": { "maxChannelsPerComponent": 1024 }
      }
    },
    "instances": [{ "id": "main" }]
  }
}
```

---

## 2. Self-contained built deployment (server serves the UI — no Vite/nginx)

Add `console.ws.webRoot` pointing at the built `ui/dist`. The one process now serves the WebSocket **and**
the UI on `:8443`. Browse straight to `http://<host>:8443/`.

```jsonc
{
  "logging": { "level": "INFO" },
  "heartbeat": { "enabled": true, "intervalSecs": 5 },
  "metricEmission": { "target": "messaging" },

  "messaging": {
    "local": { "host": "site-broker.internal", "port": 1883, "clientId": "edge-console" },
    "requestTimeoutSeconds": 30
  },

  "hierarchy": { "levels": ["site", "device"] },
  "identity": { "site": "dallas" },

  "component": {
    "global": {
      "console": {
        "ws": {
          "port": 8443,
          "bindAddress": "0.0.0.0",
          "heartbeatIntervalMs": 15000,
          // Relative to the SERVER process cwd (e.g. run from <repo>/server -> "../ui/dist"),
          // or an absolute path to a built ui/dist.
          "webRoot": "../ui/dist"
        }
      }
    },
    "instances": [{ "id": "main" }]
  }
}
```

Build first (`npm run build` produces `ui/dist`). Put a TLS terminator in front for HTTPS/WSS — the server
is plain HTTP either way.

---

## 3. Locked-down RBAC + command deadlines

A production-leaning policy: unauthenticated connections default to a **read-only** `viewer` role;
`operator` has full control except `reboot`. Command deadlines are tuned per verb.

```jsonc
{
  "logging": { "level": "INFO" },
  "heartbeat": { "enabled": true, "intervalSecs": 5 },
  "metricEmission": { "target": "messaging" },

  "messaging": {
    "local": { "host": "site-broker.internal", "port": 1883, "clientId": "edge-console" },
    "requestTimeoutSeconds": 30
  },

  "hierarchy": { "levels": ["site", "device"] },
  "identity": { "site": "dallas" },

  "component": {
    "global": {
      "console": {
        "ws": { "port": 8443, "bindAddress": "0.0.0.0", "webRoot": "../ui/dist" },

        "rbac": {
          "defaultRole": "viewer",
          "roles": {
            "operator": { "allow": ["*"], "deny": ["reboot"] },
            "viewer":   { "allow": ["ping", "get-configuration"] }
          }
        },

        "commands": {
          "defaultTimeoutMs": 30000,
          "maxTimeoutMs": 60000,           // hard ceiling = the uns-bridge reply-map TTL
          "verbTimeouts": { "ping": 10000, "reload-config": 45000 }
        }
      }
    },
    "instances": [{ "id": "main" }]
  }
}
```

> **Reminder:** RBAC *enforcement* is real, but the identity source is stubbed — until the auth seam
> resolves a real principal, `defaultRole` applies to **every** connection, and the read surface is
> unauthenticated. Keep the console on a trusted network. See
> [explanation → security](explanation.md#a-note-on-security).

---

## 4. High-volume site — tuned caches and a snappier ladder

A busy fleet with hundreds of components and chatty telemetry. The staleness ladder is tightened (a 5 s
cadence should trip OFFLINE faster), and the store bounds are raised to hold more history without letting
any one component evict others.

```jsonc
{
  "logging": { "level": "WARN" },
  "heartbeat": { "enabled": true, "intervalSecs": 5 },
  "metricEmission": { "target": "messaging" },

  "messaging": {
    "local": { "host": "site-broker.internal", "port": 1883, "clientId": "edge-console" },
    "requestTimeoutSeconds": 30
  },

  "hierarchy": { "levels": ["site", "area", "line", "device"] },
  "identity": { "site": "dallas", "area": "assembly", "line": "5" },

  "component": {
    "global": {
      "console": {
        "ws": { "port": 8443, "bindAddress": "0.0.0.0", "webRoot": "../ui/dist" },

        "staleness": {
          "warnMultiplier": 1.5,
          "staleMultiplier": 2,
          "offlineMultiplier": 3,          // must stay strictly increasing warn<stale<offline
          "defaultIntervalSecs": 5,
          "sweepIntervalMs": 500           // recompute twice a second
        },

        "cache":   { "maxChannelsPerComponent": 4096 },
        "events":  { "maxEvents": 5000, "maxPerComponent": 250 },
        "metrics": { "maxSeriesPoints": 120, "maxSeries": 8000 }
      }
    },
    "instances": [{ "id": "main" }]
  }
}
```

Note the four-level `hierarchy`/`identity` — that is the *console's own* identity. The console renders
**each observed component's** own declared hierarchy dynamically, regardless of its own.

---

## 5. Kubernetes (ConfigMap) + a Service/Ingress sketch

On Kubernetes the config comes from a mounted ConfigMap (`-c` defaults to `CONFIGMAP`), identity from the
Downward API, logging is stdout JSON, and `/healthz` is the probe. The console is a **single replica**
(long-lived WebSockets + in-memory model). You provide the Service + Ingress that reaches its WebSocket
port — **no Helm chart ships yet**.

The console config (the ConfigMap payload):

```jsonc
{
  "logging": { "level": "INFO" },
  "heartbeat": { "enabled": true, "intervalSecs": 5 },
  "metricEmission": { "target": "prometheus" },

  "messaging": {
    "local": { "host": "emqx.messaging.svc.cluster.local", "port": 1883, "clientId": "edge-console" },
    "requestTimeoutSeconds": 30
  },

  "component": {
    "global": {
      "console": {
        "ws": { "port": 8443, "bindAddress": "0.0.0.0", "webRoot": "/app/ui/dist" },
        "rbac": { "defaultRole": "viewer",
                  "roles": { "operator": { "allow": ["*"] },
                             "viewer": { "allow": ["ping", "get-configuration"] } } }
      }
    },
    "instances": [{ "id": "main" }]
  }
}
```

A minimal Service + Ingress (TLS terminated at the Ingress) reaching the console. This is illustrative —
adapt to your cluster:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: edge-console
spec:
  selector: { app: edge-console }
  ports:
    - name: ws
      port: 8443
      targetPort: 8443
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: edge-console
  annotations:
    # WebSocket upgrades must be allowed through; TLS terminates here.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
spec:
  tls:
    - hosts: [console.dallas.example.com]
      secretName: edge-console-tls
  rules:
    - host: console.dallas.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: edge-console
                port: { number: 8443 }
```

The Deployment runs the server image with `--platform KUBERNETES` and **one** replica. Because the page is
served over `https://`, the UI derives `wss://console.dallas.example.com/ws` automatically — no UI config
change.

---

## 6. Single-device (no separate site broker)

On a lone device, `messaging.local` *is* that device's local bus — the console and the device's components
share one broker. Everything else is identical to the minimal HOST config.

```jsonc
{
  "logging": { "level": "INFO" },
  "heartbeat": { "enabled": true, "intervalSecs": 5 },
  "metricEmission": { "target": "messaging" },

  "messaging": {
    "local": { "host": "127.0.0.1", "port": 1883, "clientId": "edge-console" }
  },

  "hierarchy": { "levels": ["device"] },
  "identity": {},

  "component": {
    "global": { "console": { "ws": { "port": 8443, "webRoot": "../ui/dist" } } },
    "instances": [{ "id": "main" }]
  }
}
```

Give the console a distinct `-t` thing name so its own `state`/`metric`/`cfg` don't appear as a device
under the fleet it is watching.

---

## Field-by-field reference

Every knob shown above — plus its type, default, and validation rule — is documented in
[reference — configuration](reference/configuration.md). The wire protocols the config governs are in
[reference — data types](reference/data-types.md) (browser↔console) and
[reference — messaging interface](reference/messaging-interface.md) (console↔bus).
