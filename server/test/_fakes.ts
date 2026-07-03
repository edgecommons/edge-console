/**
 * Shared test fakes — the console's fake bus (no live broker, the lib's
 * `RecordingMessagingService` pattern + wildcard routing via the lib's exported
 * `topicMatches`) and envelope helpers with pinned timestamps (no sleeps).
 */
import { Message, MessageBuilder, MessageIdentity, ReplyFuture, topicMatches } from "@edgecommons/ggcommons";
import type { IMessagingService, MessageHandler, MessageTags, Qos } from "@edgecommons/ggcommons";

/** A recorded publish. */
export interface PublishedRecord {
  topic: string;
  message: Message;
}

/**
 * An in-memory `IMessagingService`: records publishes; `emitWire` delivers a wire
 * payload to every subscription whose filter matches the topic (real MQTT wildcard
 * semantics via the lib's `topicMatches`).
 */
export class FakeBus implements IMessagingService {
  readonly published: PublishedRecord[] = [];
  readonly subscriptions = new Map<string, MessageHandler>();
  readonly unsubscribed: string[] = [];
  connectedState = true;

  async publish(topic: string, msg: Message): Promise<void> {
    this.published.push({ topic, message: msg });
  }
  async publishToIoTCore(topic: string, msg: Message, _qos?: Qos): Promise<void> {
    this.published.push({ topic, message: msg });
  }
  async publishRaw(topic: string, payload: unknown): Promise<void> {
    this.published.push({ topic, message: Message.raw(payload) });
  }
  async publishToIoTCoreRaw(topic: string, payload: unknown, _qos?: Qos): Promise<void> {
    this.published.push({ topic, message: Message.raw(payload) });
  }

  async subscribe(filter: string, handler: MessageHandler): Promise<void> {
    this.subscriptions.set(filter, handler);
  }
  async subscribeToIoTCore(filter: string, handler: MessageHandler): Promise<void> {
    this.subscriptions.set(filter, handler);
  }
  async unsubscribe(filter: string): Promise<void> {
    this.unsubscribed.push(filter);
    this.subscriptions.delete(filter);
  }
  async unsubscribeFromIoTCore(filter: string): Promise<void> {
    this.unsubscribed.push(filter);
    this.subscriptions.delete(filter);
  }

  request(_topic: string, _msg: Message, _timeoutMs?: number): ReplyFuture {
    return new ReplyFuture(new Promise<Message>(() => undefined), () => undefined);
  }
  requestFromIoTCore(topic: string, msg: Message, timeoutMs?: number): ReplyFuture {
    return this.request(topic, msg, timeoutMs);
  }
  async reply(): Promise<void> {}
  async replyToIoTCore(): Promise<void> {}
  cancelRequest(reply: ReplyFuture): void {
    reply.cancel();
  }
  cancelRequestFromIoTCore(reply: ReplyFuture): void {
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
