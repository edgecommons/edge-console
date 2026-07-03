import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev parity with production's origin-derived WS URL (`ws(s)://{host}/ws`,
      // see src/config.ts): the vite dev server proxies /ws to the local gateway
      // (the target is the server's `console.ws.port` default, 8443). Point the UI
      // somewhere else with VITE_CONSOLE_WS_URL instead of editing this.
      "/ws": {
        target: "http://127.0.0.1:8443",
        ws: true,
      },
    },
  },
  optimizeDeps: {
    // The workspace-linked protocol package is CommonJS (shared with the Node
    // server); linked packages bypass vite's dev-time prebundle (and with it the
    // CJS->ESM interop), so named imports 404 without this.
    include: ["@edgecommons/edge-console-protocol"],
  },
  build: {
    commonjsOptions: {
      // Same interop for the production build (rollup side).
      include: [/node_modules/, /protocol[\\/]dist/],
    },
  },
});
