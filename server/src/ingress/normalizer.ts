/**
 * The BusIngress normalizer — pure classification of a delivered bus message into an
 * {@link IngressEvent} the FleetModel can consume. No IO; unit-tested exhaustively.
 *
 * Identity ALWAYS comes from the top-level envelope `identity` element, never the
 * topic — with **one documented exception** (reconciliation G5): the uns-bridge's
 * broker-published Last Will is a bare raw JSON payload `{"status":"UNREACHABLE"}` on
 * `ecv1/{device}/uns-bridge/{instance}/state` (no envelope, no identity, no honest
 * timestamp — the broker publishes it, not the bridge). For that one shape the topic
 * is parsed for `{device}` and the whole device is marked UNREACHABLE, with
 * **event-time = delivery time** (the FleetModel stamps receipt).
 *
 * Class and channel are structural topic positions (not identity): the class token's
 * index is known per subscription (the ingress derives it from the filter it built),
 * and the channel is every token after it.
 */
import type { Message } from "@edgecommons/ggcommons";
import type { ConsumerClass, WireIdentity } from "@edgecommons/edge-console-protocol";

/** The bridge's component token — the only component whose raw state is meaningful. */
const BRIDGE_COMPONENT = "uns-bridge";

/** Why a message was dropped by the normalizer (observability/testing). */
export type IgnoreReason =
  | "raw-non-lwt"
  | "missing-identity";

/** A decoded UNS envelope, attributed via its `identity` element. */
export interface EnvelopeEvent {
  kind: "envelope";
  cls: ConsumerClass;
  /** `/`-joined channel tokens (absent for the leaf classes `state`/`cfg`). */
  channel?: string;
  identity: WireIdentity;
  /** Envelope tags verbatim. `_`-prefixed keys (e.g. the bridge hop tag `_relay`) are system-reserved — consumers ignore them for business/grouping logic (G6). */
  tags?: Record<string, unknown>;
  body: unknown;
  /** The publisher's header timestamp claim, when present. */
  sourceTimestamp?: string;
  topic: string;
}

/** The raw-LWT path (G5): the bridge's Last Will marks the whole device UNREACHABLE. */
export interface DeviceUnreachableEvent {
  kind: "device-unreachable";
  device: string;
  topic: string;
}

/** A message the console cannot attribute; counted, never fatal. */
export interface IgnoredEvent {
  kind: "ignored";
  cls: ConsumerClass;
  topic: string;
  reason: IgnoreReason;
}

/** The normalizer's output — the FleetModel's sole input type. */
export type IngressEvent = EnvelopeEvent | DeviceUnreachableEvent | IgnoredEvent;

/**
 * Classify one delivered message.
 *
 * @param cls        the UNS class of the subscription that delivered the message
 * @param classIndex the class token's topic-level index (from the subscribed filter,
 *                   e.g. 4 for the rootless `ecv1/+/+/+/state`)
 * @param topic      the concrete delivery topic
 * @param msg        the lib-decoded message (envelope or raw)
 */
export function normalize(
  cls: ConsumerClass,
  classIndex: number,
  topic: string,
  msg: Message,
): IngressEvent {
  if (msg.isRaw()) {
    return normalizeRaw(cls, classIndex, topic, msg.getRaw());
  }

  const identity = msg.getIdentity();
  if (identity === undefined) {
    // Envelope without a (parseable) identity: legal on the wire (bootstrap/raw
    // bridging, or a malformed identity the lib dropped leniently) but the console
    // cannot attribute it (G11) — count and move on, never crash.
    return { kind: "ignored", cls, topic, reason: "missing-identity" };
  }

  const channelTokens = topic.split("/").slice(classIndex + 1);
  return {
    kind: "envelope",
    cls,
    channel: channelTokens.length > 0 ? channelTokens.join("/") : undefined,
    identity: {
      hier: identity.hier.map((e) => ({ level: e.level, value: e.value })),
      path: identity.path,
      component: identity.component,
      instance: identity.instance,
    },
    tags: msg.tags,
    body: msg.getBody(),
    sourceTimestamp: msg.header.timestamp !== "" ? msg.header.timestamp : undefined,
    topic,
  };
}

/**
 * The raw-message path. Only ONE raw shape means anything to the console — the bridge
 * LWT on the `state` wildcard: topic `ecv1/{device}/uns-bridge/{instance}/state`
 * (exactly `classIndex + 1` tokens — `state` is a leaf class) with the bare payload
 * `{"status":"UNREACHABLE"}`. Everything else raw is dropped.
 */
function normalizeRaw(
  cls: ConsumerClass,
  classIndex: number,
  topic: string,
  raw: unknown,
): IngressEvent {
  if (cls === "state") {
    const tokens = topic.split("/");
    const device = tokens[classIndex - 3];
    if (
      tokens.length === classIndex + 1 &&
      tokens[classIndex] === "state" &&
      tokens[classIndex - 2] === BRIDGE_COMPONENT &&
      typeof device === "string" &&
      device !== "" &&
      isUnreachablePayload(raw)
    ) {
      return { kind: "device-unreachable", device, topic };
    }
  }
  return { kind: "ignored", cls, topic, reason: "raw-non-lwt" };
}

/** Whether a raw payload is the bridge LWT body `{"status":"UNREACHABLE"}`. */
function isUnreachablePayload(raw: unknown): boolean {
  return (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).status === "UNREACHABLE"
  );
}
