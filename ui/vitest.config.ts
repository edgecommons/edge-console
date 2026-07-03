import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["test/_setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // main.tsx is the DOM bootstrap (createRoot on the real page) — exercised by
      // the built app, not unit tests (the same scoping as the server's main.ts).
      exclude: ["src/main.tsx"],
      reporter: ["text"],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 85,
        branches: 80,
      },
    },
  },
});
