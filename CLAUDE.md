# edge-console (Claude Code)

EdgeCommons **console** component: the Rust gateway plus the TypeScript `ui`/`protocol` workspace.
The full picture — what this component is, the workspace layout, the design authority, config
location, validation expectations, and the baseline-adoption status — lives in `AGENTS.md` and is
shared with every agent tool. It is imported here in full:

@AGENTS.md

## Local-dev notes

- **Dual toolchain, one root `package.json`.** `gateway/` is the sole member of the root Cargo
  workspace (`Cargo.toml`); `ui/` and `protocol/` are npm workspaces off the root `package.json`.
  `npm run build` chains `protocol` → `ui` → `build:gateway` (which runs `link:rust` then
  `cargo build -p edge-console-gateway`).
- **Rust sibling link.** `npm run link:rust` (`scripts/link-sibling-rust.mjs`) generates the
  gitignored `local/edgecommons-rust` path that `gateway/Cargo.toml`'s `edgecommons` dependency
  points at — build the sibling `core/libs/rust` checkout first if it looks stale. CI checks out
  `edgecommons/edgecommons` at its default-branch HEAD and generates the same link (see
  `AGENTS.md`'s baseline-adoption note: this floating link is the P0-1 item deferred to the code
  phase, which replaces it with a git `rev=` pin).
- **TS side needs no sibling build.** Neither `ui/` nor `protocol/` depends on
  `@edgecommons/edgecommons` directly (that dependency lives only in the Rust gateway now), so a
  plain `npm install` at the repo root is enough.
- **Rust build on Windows** uses the installed MSVC Build Tools 2026 toolchain (native `cargo
  build`, no WSL needed for this repo — it has no Greengrass-IPC-only feature).
- `cargo test` (gateway) and `npm test` (protocol + ui) are the two local suites; `npm run
  coverage` (ui only, today) exercises the vitest coverage thresholds already configured in
  `ui/vitest.config.ts`.
