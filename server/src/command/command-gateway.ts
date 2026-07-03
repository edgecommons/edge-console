/**
 * CommandGateway — the C4 pure command core: `invoke-command` → RBAC → build the
 * target's `cmd` topic → `messaging().request()` → map the reply into a
 * `command-result`. The reconciliation §4 C4 row and G2/G13: the console issues
 * `uns().topicFor(target, Cmd, verb)` + `messaging().request(topic, msg, timeoutMs)`
 * on its ONE site-broker connection; the uns-bridge rewrites `reply_to` transparently,
 * so a site→device request/reply just works.
 *
 * PURE/IO split — the ONLY IO is the injected {@link CommandRequestFn} (in production
 * `(topic, msg, timeoutMs) => messaging.request(...)`, the thin edge). Everything else —
 * RBAC, topic/envelope construction, per-verb timeout selection + the ≤ bridge-TTL
 * clamp, reply/timeout/error mapping, elapsed timing — lives here and is unit-testable
 * over fakes with no bus and no sleeps (a fake `request` resolves/rejects synchronously).
 *
 * Reply contract (uns-test-vectors/commands.json, DESIGN-uns §9.5): a component answers
 * `{"ok": true, "result": <object>}` or `{"ok": false, "error": {"code", "message"}}`.
 * The component's own error codes (`UNKNOWN_VERB`/`HANDLER_ERROR`/`RELOAD_FAILED`/
 * `NO_CONFIG`) pass through verbatim; the gateway ADDS the console-side codes
 * ({@link import("@edgecommons/edge-console-protocol").ConsoleCommandErrorCode}):
 * `FORBIDDEN` (RBAC, never hits the bus), `TIMEOUT`, `REQUEST_FAILED`, `INVALID_TARGET`,
 * `MALFORMED_REPLY`.
 */
import { MessageIdentity, RequestTimeoutError, UnsClass } from "@edgecommons/ggcommons";
import type { Message, MessageBuilder, Uns } from "@edgecommons/ggcommons";
import { isPlainObject } from "@edgecommons/edge-console-protocol";
import type { CommandError, ComponentKey } from "@edgecommons/edge-console-protocol";
import type { Clock } from "../fleet/fleet-model";
import type { RbacPolicy } from "./rbac";

/** One command to issue, as the WS gateway hands it over. */
export interface InvokeRequest {
  requestId: string;
  key: ComponentKey;
  verb: string;
  args?: Record<string, unknown>;
}

/** The normalized outcome of one command (reply / timeout / error, all mapped here). */
export type CommandOutcome = { ok: true; result: unknown } | { ok: false; error: CommandError };

/** The full result the gateway returns — the `command-result` frame payload sans wire framing. */
export interface CommandResultData {
  requestId: string;
  key: ComponentKey;
  verb: string;
  ok: boolean;
  result?: unknown;
  error?: CommandError;
  elapsedMs: number;
}

/**
 * The IO edge: issue the request on the site bus, resolve with the reply {@link Message}
 * or reject (RequestTimeoutError / transport error). Production wires
 * `(topic, msg, timeoutMs) => messaging.request(topic, msg, timeoutMs)` — the lib's
 * `ReplyFuture` is a `PromiseLike<Message>`, so `await` works directly and the lib owns
 * the deadline + reply-subscription cleanup (G13).
 */
export type CommandRequestFn = (topic: string, msg: Message, timeoutMs: number) => PromiseLike<Message>;

/** Injected collaborators — all substitutable in tests. */
export interface CommandGatewayDeps {
  /** The console's identity-bound topic builder (`gg.uns()`) — same instance BusIngress uses. */
  uns: Uns;
  /** Envelope factory stamping the console's identity (`MessageBuilder.create(verb,"1.0").withConfig(...)`). */
  newMessage: (name: string) => MessageBuilder;
  /** The site-bus request edge (production: `messaging.request`). */
  request: CommandRequestFn;
  /** The authorization policy (config-driven; deny ⇒ FORBIDDEN before the bus). */
  rbac: RbacPolicy;
  /** Injected clock for `elapsedMs` (tests). */
  clock: Clock;
  /** The default per-command deadline (ms) when a verb has no specific one. Default 30 000. */
  defaultTimeoutMs?: number;
  /** The hard ceiling (ms) — the bridge reply-map TTL (paired-knob rule, D-B9). Default 60 000. */
  maxTimeoutMs?: number;
  /** Optional per-verb deadline override (ms); `undefined` ⇒ the default. */
  timeoutForVerb?: (verb: string) => number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Map a reply envelope body into a {@link CommandOutcome}. The wire contract is
 * `{ok: true, result}` / `{ok: false, error: {code, message}}`; anything else is a
 * MALFORMED_REPLY (a foreign responder, or a component bug) rather than a crash.
 */
export function mapReplyBody(body: unknown): CommandOutcome {
  if (isPlainObject(body)) {
    if (body.ok === true) {
      return { ok: true, result: "result" in body ? body.result : {} };
    }
    if (body.ok === false) {
      const err = isPlainObject(body.error) ? body.error : {};
      const code = typeof err.code === "string" && err.code !== "" ? err.code : "ERROR";
      const message = typeof err.message === "string" ? err.message : "";
      return { ok: false, error: { code, message } };
    }
  }
  return {
    ok: false,
    error: {
      code: "MALFORMED_REPLY",
      message: "the command reply body was not the {ok, result|error} shape",
    },
  };
}

/** Map a thrown request error: the lib's deadline ⇒ TIMEOUT, anything else ⇒ REQUEST_FAILED. */
export function mapRequestError(e: unknown, timeoutMs: number): CommandOutcome {
  const isTimeout = e instanceof RequestTimeoutError || (e as { name?: unknown })?.name === "RequestTimeoutError";
  if (isTimeout) {
    return { ok: false, error: { code: "TIMEOUT", message: `no reply within ${timeoutMs} ms` } };
  }
  return { ok: false, error: { code: "REQUEST_FAILED", message: errMsg(e) } };
}

/** The C4 pure command core. */
export class CommandGateway {
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;

  constructor(private readonly deps: CommandGatewayDeps) {
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = deps.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  }

  /**
   * Invoke `req.verb` on `req.key` as the connection's `role`. Never throws — every
   * failure mode is a `{ok: false, error}` result. Concurrency/correlation is the
   * caller's (the WS gateway keys on `requestId`); this method is stateless per call,
   * so N concurrent invokes are N independent promises.
   */
  async invoke(req: InvokeRequest, role: string): Promise<CommandResultData> {
    const start = this.deps.clock();
    const finish = (outcome: CommandOutcome): CommandResultData => ({
      requestId: req.requestId,
      key: req.key,
      verb: req.verb,
      ...(outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error }),
      elapsedMs: Math.max(0, this.deps.clock() - start),
    });

    // 1. RBAC — a denied command never reaches the bus (the enforcement point).
    if (!this.deps.rbac.can(role, req.verb)) {
      return finish({
        ok: false,
        error: { code: "FORBIDDEN", message: `role '${role}' is not permitted to invoke '${req.verb}'` },
      });
    }

    // 2. Build the target's own cmd inbox topic + the request envelope. A bad token/depth
    //    is a caller error (INVALID_TARGET), not a bus round-trip.
    let topic: string;
    let msg: Message;
    try {
      const target = new MessageIdentity(
        [{ level: "device", value: req.key.device }],
        req.key.component,
        req.key.instance,
      );
      topic = this.deps.uns.topicFor(target, UnsClass.Cmd, req.verb);
      // header.name = verb (the inbox requires header.name === the topic verb); body = args.
      msg = this.deps.newMessage(req.verb).withPayload(req.args ?? {}).build();
    } catch (e) {
      return finish({ ok: false, error: { code: "INVALID_TARGET", message: errMsg(e) } });
    }

    // 3. Issue + await on the site bus; the bridge rewrites reply_to transparently.
    const timeoutMs = this.timeoutFor(req.verb);
    try {
      const reply = await this.deps.request(topic, msg, timeoutMs);
      return finish(mapReplyBody(reply.getBody()));
    } catch (e) {
      return finish(mapRequestError(e, timeoutMs));
    }
  }

  /** The per-verb deadline (ms), clamped to `[1, maxTimeoutMs]` (≤ the bridge TTL). */
  private timeoutFor(verb: string): number {
    const chosen = this.deps.timeoutForVerb?.(verb) ?? this.defaultTimeoutMs;
    return Math.min(this.maxTimeoutMs, Math.max(1, chosen));
  }
}
