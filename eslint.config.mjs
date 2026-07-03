// ESLint flat config for the edge-console workspace (protocol / server / ui / scripts).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "local/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // The ingress/normalizer works over `unknown` wire payloads by design; narrow with guards.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "ui/vite.config.ts", "server/vitest.config.ts"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
);
