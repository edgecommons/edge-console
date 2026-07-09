/**
 * CommandControls (slice C4) — the per-component command affordance surfaced inside an
 * expanded fleet row. Faithful to the hi-fi mockup's component-detail button row
 * (`Ping` / `Get config` / …): a button group for the operator-facing universal verbs
 * (`ping`, `reload-config`, `get-configuration`), plus a generic "Send command…" form for
 * custom/advanced verbs. The fourth universal built-in, `describe`, is reserved for
 * descriptor discovery and is surfaced through the Component Detail Panel tab.
 *
 * Capability discovery now rides the `describe` manifest. This compact control still keeps the
 * generic verb+args form because not every advertised command has a dedicated UI affordance.
 *
 * State handling (pending / success / error / FORBIDDEN / timeout): each button reads its
 * latest command entry from the store (`latestByComponentVerb`) — pending disables +
 * spins, a FORBIDDEN result disables it (retrying would deny again — "not permitted for
 * your role"), and the outcome renders inline beneath the row (a toast mirrors it, see
 * `CommandToasts`). Purely presentational: `onInvoke` is the only side-effect seam.
 */
import { useState } from "react";
import {
  Button,
  InlineLoading,
  InlineNotification,
  Modal,
  Tag,
  TextArea,
  TextInput,
} from "@carbon/react";
import { SendAlt } from "@carbon/react/icons";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import type { CommandEntry, CommandView } from "../fleet/command-store";
import { commandSlot } from "../fleet/command-store";
import type { ComponentView } from "../fleet/store";

/** The universal built-in verbs, in the mockup's button order. */
const BUILTINS: { verb: string; label: string; kind: "primary" | "secondary" | "tertiary" }[] = [
  { verb: "ping", label: "Ping", kind: "primary" },
  { verb: "get-configuration", label: "Get configuration", kind: "secondary" },
  { verb: "reload-config", label: "Reload config", kind: "tertiary" },
];

/** Pretty-print a result/config object for the inline detail pane. */
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A one-line human summary of a successful built-in result (falls back to JSON). */
function successSummary(verb: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  if (verb === "ping" && typeof r.status === "string") {
    const up = typeof r.uptimeSecs === "number" ? ` · uptime ${r.uptimeSecs}s` : "";
    return `${r.status}${up}`;
  }
  if (verb === "reload-config") return r.reloaded === true ? "Configuration reloaded" : "Acknowledged";
  if (verb === "get-configuration") return "Effective configuration received";
  return "Acknowledged";
}

/** The inline outcome line for one component/verb (pending / ok / error). */
function ResultLine({ entry, id }: { entry: CommandEntry; id: string }): React.JSX.Element {
  if (entry.phase === "pending") {
    return (
      <div className="ec-cmd-result" data-testid={`cmd-result-${entry.verb}-${id}`}>
        <InlineLoading description={`${entry.verb}…`} />
      </div>
    );
  }
  if (entry.phase === "error") {
    const code = entry.error?.code ?? "ERROR";
    const forbidden = code === "FORBIDDEN";
    const timeout = code === "TIMEOUT";
    const label = forbidden
      ? "Not permitted for your role"
      : timeout
        ? "Timed out — no reply"
        : (entry.error?.message ?? code);
    return (
      <div className="ec-cmd-result ec-cmd-result--error" data-testid={`cmd-result-${entry.verb}-${id}`}>
        <Tag size="sm" type="red" className="ec-tag">
          {entry.verb}
        </Tag>
        <span className="ec-cmd-result__msg">
          {label} <span className="ec-dim ec-mono">({code})</span>
        </span>
      </div>
    );
  }
  // ok
  const showJson = entry.verb === "get-configuration";
  const jsonBody =
    entry.verb === "get-configuration"
      ? ((entry.result as { config?: unknown } | undefined)?.config ?? entry.result)
      : entry.result;
  return (
    <div className="ec-cmd-result ec-cmd-result--ok" data-testid={`cmd-result-${entry.verb}-${id}`}>
      <Tag size="sm" type="green" className="ec-tag">
        {entry.verb}
      </Tag>
      <span className="ec-cmd-result__msg">{successSummary(entry.verb, entry.result)}</span>
      {entry.elapsedMs !== undefined && <span className="ec-dim ec-mono"> · {entry.elapsedMs}ms</span>}
      {showJson && <pre className="ec-cmd-json" data-testid={`cmd-json-${id}`}>{pretty(jsonBody)}</pre>}
    </div>
  );
}

export interface CommandControlsProps {
  comp: ComponentView;
  commands: CommandView;
  onInvoke: (key: ComponentKey, verb: string, args?: Record<string, unknown>) => void;
}

export function CommandControls({ comp, commands, onInvoke }: CommandControlsProps): React.JSX.Element {
  const id = comp.id;
  const [modalOpen, setModalOpen] = useState(false);
  const [verb, setVerb] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const latest = (v: string): CommandEntry | undefined =>
    commands.latestByComponentVerb[commandSlot(id, v)];
  const isPending = (v: string): boolean => latest(v)?.phase === "pending";
  const isForbidden = (v: string): boolean => {
    const e = latest(v);
    return e?.phase === "error" && e.error?.code === "FORBIDDEN";
  };

  const submitGeneric = (): void => {
    const trimmed = verb.trim();
    if (trimmed === "") {
      setFormError("Enter a verb (e.g. restart-pipeline).");
      return;
    }
    let args: Record<string, unknown> = {};
    const raw = argsText.trim();
    if (raw !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        setFormError("Arguments must be valid JSON.");
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setFormError("Arguments must be a JSON object, e.g. { \"level\": \"DEBUG\" }.");
        return;
      }
      args = parsed as Record<string, unknown>;
    }
    onInvoke(comp.key, trimmed, args);
    setFormError(undefined);
    setVerb("");
    setArgsText("{}");
    setModalOpen(false);
  };

  // The verbs with a recent outcome to surface (built-ins first, then any custom verb).
  const resultVerbs = Array.from(
    new Set([
      ...BUILTINS.map((b) => b.verb),
      ...commands.recent.filter((e) => e.componentId === id).map((e) => e.verb),
    ]),
  ).filter((v) => latest(v) !== undefined);

  return (
    <div className="ec-cmd" data-testid={`cmd-controls-${id}`}>
      <div className="ec-cmd__hd">
        <span className="ec-cmd__label">Controls</span>
        <span className="ec-dim">
          built-in verbs · <span className="ec-mono">{comp.key.component}</span>
        </span>
      </div>
      <div className="ec-cmd__row">
        {BUILTINS.map((b) => (
          <Button
            key={b.verb}
            size="sm"
            kind={b.kind}
            disabled={isPending(b.verb) || isForbidden(b.verb)}
            data-testid={`cmd-btn-${b.verb}-${id}`}
            onClick={() => onInvoke(comp.key, b.verb)}
          >
            {b.label}
          </Button>
        ))}
        <Button
          size="sm"
          kind="ghost"
          renderIcon={SendAlt}
          data-testid={`cmd-send-open-${id}`}
          onClick={() => {
            setFormError(undefined);
            setModalOpen(true);
          }}
        >
          Send command…
        </Button>
      </div>

      {resultVerbs.length > 0 && (
        <div className="ec-cmd__results" data-testid={`cmd-results-${id}`}>
          {resultVerbs.map((v) => {
            const entry = latest(v);
            return entry !== undefined ? <ResultLine key={v} entry={entry} id={id} /> : null;
          })}
        </div>
      )}

      <p className="ec-cmd__note ec-dim">
        Operational buttons stay limited to safe universal commands. Component-specific
        capabilities appear in the Panel tab when advertised; use <b> Send command…</b> to invoke a
        known verb by name.
      </p>

      <Modal
        open={modalOpen}
        modalHeading={`Send command · ${comp.key.component}`}
        modalLabel={comp.key.device}
        primaryButtonText="Send"
        secondaryButtonText="Cancel"
        data-testid={`cmd-send-modal-${id}`}
        onRequestClose={() => setModalOpen(false)}
        onRequestSubmit={submitGeneric}
      >
        <p className="ec-dim ec-cmd-modal__lead">
          Invoke any verb the component answers. The verb becomes the command topic; the
          arguments are the request body (an empty body sends <span className="ec-mono">{"{}"}</span>).
        </p>
        <TextInput
          id={`cmd-send-verb-${id}`}
          data-testid={`cmd-send-verb-${id}`}
          labelText="Verb"
          placeholder="e.g. restart-pipeline or sb/status"
          value={verb}
          onChange={(e) => setVerb(e.target.value)}
        />
        <TextArea
          id={`cmd-send-args-${id}`}
          data-testid={`cmd-send-args-${id}`}
          labelText="Arguments (JSON object)"
          rows={4}
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
        />
        {formError !== undefined && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Invalid command"
            subtitle={formError}
            data-testid={`cmd-send-error-${id}`}
          />
        )}
      </Modal>
    </div>
  );
}
