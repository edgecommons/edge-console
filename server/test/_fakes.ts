/**
 * Shared test fakes — the console's fake bus (no live broker, the lib's
 * `RecordingMessagingService` pattern + wildcard routing via the lib's exported
 * `topicMatches`) and envelope helpers with pinned timestamps (no sleeps).
 */
import { Message, MessageBuilder, MessageIdentity, ReplyFuture, topicMatches } from "@edgecommons/edgecommons";
import type { IMessagingService, MessageHandler, MessageTags, Qos } from "@edgecommons/edgecommons";

/** A recorded publish. */
export interface PublishedRecord {
  topic: string;
  message: Message;
}

/** A recorded request/reply (C4). */
export interface RequestRecord {
  topic: string;
  message: Message;
  timeoutMs?: number;
}

/**
 * An in-memory `IMessagingService`: records publishes; `emitWire` delivers a wire
 * payload to every subscription whose filter matches the topic (real MQTT wildcard
 * semantics via the lib's `topicMatches`).
 */
export class FakeBus implements IMessagingService {
  readonly published: PublishedRecord[] = [];
  readonly requests: RequestRecord[] = [];
  readonly subscriptions = new Map<string, MessageHandler>();
  readonly unsubscribed: string[] = [];
  connectedState = true;
  /**
   * Optional C4 request scripting: given the outgoing request, return the reply
   * {@link Message} (or a promise, or throw/reject to simulate a timeout/transport
   * error). Absent ⇒ `request` returns a never-settling future (the pre-C4 behavior).
   */
  requestHandler?: (topic: string, msg: Message, timeoutMs?: number) => Message | Promise<Message>;

  async publish(topic: string, msg: Message): Promise<void> {
    this.published.push({ topic, message: msg });
  }
  async publishNorthbound(topic: string, msg: Message, _qos?: Qos): Promise<void> {
    this.published.push({ topic, message: msg });
  }
  async publishRaw(topic: string, payload: unknown): Promise<void> {
    this.published.push({ topic, message: Message.raw(payload) });
  }
  async publishNorthboundRaw(topic: string, payload: unknown, _qos?: Qos): Promise<void> {
    this.published.push({ topic, message: Message.raw(payload) });
  }

  async subscribe(filter: string, handler: MessageHandler): Promise<void> {
    this.subscriptions.set(filter, handler);
  }
  async subscribeNorthbound(filter: string, handler: MessageHandler): Promise<void> {
    this.subscriptions.set(filter, handler);
  }
  async unsubscribe(filter: string): Promise<void> {
    this.unsubscribed.push(filter);
    this.subscriptions.delete(filter);
  }
  async unsubscribeNorthbound(filter: string): Promise<void> {
    this.unsubscribed.push(filter);
    this.subscriptions.delete(filter);
  }

  request(topic: string, msg: Message, timeoutMs?: number): ReplyFuture {
    this.requests.push({ topic, message: msg, timeoutMs });
    if (this.requestHandler === undefined) {
      return new ReplyFuture(new Promise<Message>(() => undefined), () => undefined);
    }
    const handler = this.requestHandler;
    const promise = Promise.resolve().then(() => handler(topic, msg, timeoutMs));
    return new ReplyFuture(promise, () => undefined);
  }
  requestNorthbound(topic: string, msg: Message, timeoutMs?: number): ReplyFuture {
    return this.request(topic, msg, timeoutMs);
  }
  async reply(): Promise<void> {}
  async replyNorthbound(): Promise<void> {}
  cancelRequest(reply: ReplyFuture): void {
    reply.cancel();
  }
  cancelRequestNorthbound(reply: ReplyFuture): void {
    reply.cancel();
  }
  connected(): boolean {
    return this.connectedState;
  }

  /** Deliver a wire payload to every matching subscription (awaits the handlers). */
  async emitWire(topic: string, payload: string): Promise<void> {
    for (const [filter, handler] of [...this.subscriptions.entries()]) {
      if (topicMatches(filter, topic)) {
        await handler(topic, Message.fromWire(payload));
      }
    }
  }
}

/** Build a validated identity: default single-level hierarchy `["device"]`. */
export function makeIdentity(
  device: string,
  component: string,
  instance = "main",
  site?: string,
): MessageIdentity {
  const hier =
    site !== undefined
      ? [
          { level: "site", value: site },
          { level: "device", value: device },
        ]
      : [{ level: "device", value: device }];
  return new MessageIdentity(hier, component, instance);
}

/** Serialize an envelope with a pinned timestamp (deterministic; optionally identityless). */
export function wireEnvelope(
  name: string,
  identity: MessageIdentity | undefined,
  body: unknown,
  tags?: MessageTags,
): string {
  const builder = MessageBuilder.create(name, "1.0")
    .withPayload(body)
    .withTimestamp("2026-07-03T00:00:00.000Z")
    .withUuid("00000000-0000-0000-0000-000000000000");
  if (identity !== undefined) builder.withIdentity(identity);
  if (tags !== undefined) builder.withTags(tags);
  return builder.build().toJSON();
}

/** The bridge's raw Last-Will payload, exactly as the broker publishes it (G5). */
export const RAW_LWT = '{"status":"UNREACHABLE"}';
