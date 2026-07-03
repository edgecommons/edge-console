#!/usr/bin/env node
/**
 * Local-dev sibling-library link — the npm analog of the bridge's gitignored
 * `.cargo/config.toml` `paths` override.
 *
 * The committed `server/package.json` declares the PUBLISHED dependency
 * (`"@edgecommons/ggcommons": "^0.1.1"`, GitHub Packages) so CI resolves the real
 * release. For local development against the sibling checkout
 * (`../ggcommons/libs/ts`, e.g. on `feat/unified-namespace` before it publishes),
 * this script generates the **gitignored** `local/ggcommons/` workspace stub:
 *
 *   - `package.json`  — name `@edgecommons/ggcommons`, the sibling's version, so the
 *     npm workspace satisfies the dependency by name and `npm install` never
 *     contacts the registry for it (no GH Packages auth needed locally);
 *   - `index.js` / `index.d.ts` — re-export the sibling's built `dist/`. The stub has
 *     ZERO dependencies, so npm never touches (hoists/prunes) the sibling's own
 *     node_modules: at runtime Node resolves the sibling's deps from the sibling's
 *     real path, exactly like cargo's `paths` override.
 *
 * Usage:  npm run link:lib   (then `npm install` as usual)
 * Requires the sibling lib to be built (`npm run build` in ggcommons/libs/ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sibling = resolve(root, "..", "ggcommons", "libs", "ts");
const stubDir = join(root, "local", "ggcommons");

if (!existsSync(join(sibling, "package.json"))) {
  console.error(`sibling ggcommons TS lib not found at ${sibling}`);
  process.exit(1);
}
if (!existsSync(join(sibling, "dist", "index.js"))) {
  console.error(
    `sibling lib has no dist/ build at ${sibling} - run \`npm run build\` there first`,
  );
  process.exit(1);
}

const siblingPkg = JSON.parse(readFileSync(join(sibling, "package.json"), "utf8"));
if (siblingPkg.name !== "@edgecommons/ggcommons") {
  console.error(`sibling package is '${siblingPkg.name}', expected '@edgecommons/ggcommons'`);
  process.exit(1);
}

mkdirSync(stubDir, { recursive: true });

// Relative from local/ggcommons/ to the sibling's dist (POSIX separators for portability).
const rel = "../../../ggcommons/libs/ts/dist/index";

writeFileSync(
  join(stubDir, "package.json"),
  JSON.stringify(
    {
      name: siblingPkg.name,
      version: siblingPkg.version,
      description: "GITIGNORED local-dev stub re-exporting the sibling ggcommons TS lib (scripts/link-sibling-lib.mjs).",
      main: "index.js",
      types: "index.d.ts",
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(join(stubDir, "index.js"), `module.exports = require("${rel}.js");\n`);
writeFileSync(join(stubDir, "index.d.ts"), `export * from "${rel}";\n`);

console.log(
  `linked @edgecommons/ggcommons@${siblingPkg.version} -> ${sibling} (stub at local/ggcommons; run npm install)`,
);
