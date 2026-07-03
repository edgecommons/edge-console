import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    commonjsOptions: {
      // The workspace-linked protocol package is CommonJS (shared with the Node
      // server); linked packages bypass the default node_modules CJS interop.
      include: [/node_modules/, /protocol[\\/]dist/],
    },
  },
});
