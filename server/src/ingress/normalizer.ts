/**
 * The BusIngress normalizer — pure classification of a delivered bus message into an
 * {@link IngressEvent} the FleetModel can consume. No IO; unit-tested exhaustively.
 *
 * Identity ALWAYS comes from the top-level envelope `identity` element, never the
 * topic. Normal EdgeCommons UNS messages arrive here only after the TS core has
 * decoded the protobuf `EdgeCommonsMessage` bytes; malformed/non-EdgeCommons bytes
 * are dropped by the messaging service before this normalizer runs.
 *
 * Raw messages are not normal EdgeCommons UNS data under the protobuf contract; a
 * custom raw seam may still inject one in tests, but it is ignored here.
 *
 * Class and channel are structural topic positions (not identity): the class token's
 * index is known per subscription (the ingress derives it from the filter it built),
 * and the channel is every token after it.
 */
import { MessageBodyCase } from "@edgecommons/edgecommons";
import type { Message } from "@edgecommons/edgecommons";
import type { ConsumerClass, WireIdentity } from "@edgecommons/edge-console-protocol";

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
  /** Diagnostic-safe body projection. Opaque bodies expose metadata, never raw bytes. */
  body: unknown;
  /** The publisher's header timestamp claim, when present. */
  sourceTimestamp?: string;
  topic: string;
}

/** Synthetic reachability event used by the FleetModel and tests. Live bus ingress uses protobuf envelopes. */
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
    return normalizeRaw(cls, topic);
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
    body: diagnosticBody(msg),
    sourceTimestamp: msg.header.timestamp !== "" ? msg.header.timestamp : undefined,
    topic,
  };
}

/**
 * FleetModel/UI diagnostics consume JSON-shaped projections, not raw wire bytes.
 * Structured protobuf bodies are already decoded by the TS core into diagnostic
 * values (including `_edgecommonsBinary` markers for nested byte values). Opaque
 * protobuf bodies stay opaque: use the core diagnostic projection so the UI sees
 * content type, length, and hash rather than the payload bytes.
 */
function diagnosticBody(msg: Message): unknown {
  if (msg.getBodyCase() === MessageBodyCase.Opaque) {
    return msg.toDiagnosticJson().body;
  }
  return msg.getBody();
}

/**
 * The raw-message path. Live EdgeCommons UNS traffic is protobuf; raw values are
 * ignored when a custom seam injects one.
 */
function normalizeRaw(cls: ConsumerClass, topic: string): IngressEvent {
  return { kind: "ignored", cls, topic, reason: "raw-non-lwt" };
}
