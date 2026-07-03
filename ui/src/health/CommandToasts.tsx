/**
 * CommandToasts (slice C4) — the at-a-glance mirror of command outcomes. Each command
 * that SETTLES (ok or error) after this component mounts raises one Carbon
 * `ToastNotification` (success/error), auto-dismissing on its own timeout, dismissible by
 * hand. Complements the inline per-row result in {@link CommandControls}: the inline line
 * is the durable record; the toast is the momentary "it happened" — important for a
 * FORBIDDEN/TIMEOUT the operator might miss on a collapsed row.
 *
 * Only NEWLY-settled commands toast: entries already settled at mount are seeded into the
 * shown-set so navigating back to the view does not replay old outcomes.
 */
import { useEffect, useRef, useState } from "react";
import { ToastNotification } from "@carbon/react";
import type { CommandEntry, CommandView } from "../fleet/command-store";

/** How many toasts to stack at once (newest on top). */
const MAX_TOASTS = 4;
/** Auto-dismiss (ms). */
const TOAST_TIMEOUT_MS = 7000;

function subtitle(entry: CommandEntry): string {
  if (entry.phase === "ok") {
    const r = (entry.result ?? {}) as Record<string, unknown>;
    if (entry.verb === "ping" && typeof r.status === "string") {
      return `${r.status}${typeof r.uptimeSecs === "number" ? ` · uptime ${r.uptimeSecs}s` : ""}`;
    }
    if (entry.verb === "reload-config") return "Configuration reloaded";
    if (entry.verb === "get-configuration") return "Effective configuration received";
    return "Acknowledged";
  }
  const code = entry.error?.code ?? "ERROR";
  if (code === "FORBIDDEN") return "Not permitted for your role";
  if (code === "TIMEOUT") return "Timed out — no reply from the component";
  return `${code}: ${entry.error?.message ?? ""}`;
}

export function CommandToasts({ commands }: { commands: CommandView }): React.JSX.Element {
  const [toasts, setToasts] = useState<CommandEntry[]>([]);
  const shown = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    // Seed the shown-set on first run with everything ALREADY settled (no replay).
    if (shown.current === undefined) {
      shown.current = new Set(
        commands.recent.filter((e) => e.phase !== "pending").map((e) => e.requestId),
      );
      return;
    }
    const fresh = commands.recent.filter(
      (e) => e.phase !== "pending" && !shown.current!.has(e.requestId),
    );
    if (fresh.length === 0) return;
    for (const e of fresh) shown.current.add(e.requestId);
    setToasts((prev) => [...fresh, ...prev].slice(0, MAX_TOASTS));
  }, [commands.recent]);

  const dismiss = (requestId: string): void =>
    setToasts((prev) => prev.filter((t) => t.requestId !== requestId));

  if (toasts.length === 0) return <></>;
  return (
    <div className="ec-toasts" role="status" aria-live="polite" data-testid="cmd-toasts">
      {toasts.map((t) => (
        <ToastNotification
          key={t.requestId}
          kind={t.phase === "ok" ? "success" : "error"}
          lowContrast
          timeout={TOAST_TIMEOUT_MS}
          title={`${t.verb} · ${t.key.component}`}
          subtitle={subtitle(t)}
          data-testid={`cmd-toast-${t.requestId}`}
          onClose={() => {
            dismiss(t.requestId);
            return true;
          }}
        />
      ))}
    </div>
  );
}
