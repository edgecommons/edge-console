/**
 * React bindings for the {@link FleetClient} — a thin `useSyncExternalStore` seam
 * (the client/store pair stays framework-free and unit-testable on its own).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ClientState, FleetClient } from "./client";

/** Subscribe a component to the client's state (connection + folded fleet view). */
export function useFleetState(client: FleetClient): ClientState {
  return useSyncExternalStore(
    (onChange) => client.subscribe(onChange),
    () => client.getState(),
  );
}

/** Start/stop the client with the owning component's lifecycle. */
export function useFleetLifecycle(client: FleetClient): void {
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
}

/**
 * A 1 Hz "now" (client-clock ms) — drives the ticking age/uptime cells. This is a
 * content update, not an animation, so it is not gated on `prefers-reduced-motion`.
 */
export function useNowTick(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}
