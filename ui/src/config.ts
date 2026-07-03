/**
 * UI configuration — the gateway WS URL.
 *
 * Resolution order (documented in the README):
 *  1. `VITE_CONSOLE_WS_URL` (build/dev-time env override, e.g. `ws://lab:9000/ws`);
 *  2. derived from the page origin: `ws(s)://{host}/ws` — the production shape
 *     (browsers reach the console over one origin; the gateway serves `/ws`), and
 *     the dev shape too, because `vite.config.ts` proxies `/ws` to the local
 *     gateway (default `127.0.0.1:8443`, the server's `console.ws.port` default).
 */

/** The subset of `window.location` the resolver needs (injectable for tests). */
export interface LocationLike {
  protocol: string;
  host: string;
}

/** Resolve the gateway WS URL from an optional override or the page origin. */
export function resolveWsUrl(location: LocationLike, override?: string): string {
  if (override !== undefined && override.trim() !== "") return override.trim();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

/** The default WS URL for the running page (env override honored). */
export function defaultWsUrl(): string {
  const env = import.meta.env as Record<string, unknown>;
  const override = typeof env.VITE_CONSOLE_WS_URL === "string" ? env.VITE_CONSOLE_WS_URL : undefined;
  return resolveWsUrl(window.location, override);
}
