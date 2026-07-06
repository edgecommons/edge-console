import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // main.ts is the runnable process-entry harness (CLI boot + live broker) —
      // validated end-to-end against the dual-EMQX rig, not unit tests (the same
      // scoping the edgecommons TS lib applies to its *_verify entry points).
      exclude: ["src/main.ts"],
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
