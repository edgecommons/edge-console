#!/usr/bin/env node
/**
 * Local-dev sibling Rust-library link.
 *
 * The gateway crate depends on a gitignored path dependency at local/edgecommons-rust.
 * This script creates directory links to the sibling core Rust crates so local builds,
 * Docker builds, and CI can all build the gateway without needing registry/network
 * access for unpublished EdgeCommons crates.
 *
 * Set EDGECOMMONS_RUST_LIB to override the default ../core/libs/rust checkout.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuredSibling = process.env.EDGECOMMONS_RUST_LIB?.trim();
const rustLib = configuredSibling ? resolve(configuredSibling) : resolve(root, "..", "core", "libs", "rust");
const streamlogLib = resolve(rustLib, "..", "rust-streamlog");
const protoDir = resolve(rustLib, "..", "..", "proto");
const localRoot = join(root, "local");
const rustLink = join(localRoot, "edgecommons-rust");
const streamlogLink = join(localRoot, "rust-streamlog");
const protoLink = join(root, "proto");

function ensureCrate(path, expectedName) {
  const pkgPath = join(path, "Cargo.toml");
  if (!existsSync(pkgPath)) {
    console.error(`Rust crate not found at ${path}`);
    process.exit(1);
  }
  const cargo = readFileSync(pkgPath, "utf8");
  if (!cargo.includes(`name = "${expectedName}"`)) {
    console.error(`Rust crate at ${path} is not '${expectedName}'`);
    process.exit(1);
  }
}

function replaceLink(target, link) {
  if (existsSync(link)) {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) {
      console.error(`${link} already exists and is not a generated link`);
      process.exit(1);
    }
    rmSync(link, { force: true });
  }
  symlinkSync(target, link, "junction");
}

ensureCrate(rustLib, "edgecommons");
ensureCrate(streamlogLib, "edgestreamlog");
if (!existsSync(join(protoDir, "edgecommons", "v1", "value.proto"))) {
  console.error(`EdgeCommons proto directory not found at ${protoDir}`);
  process.exit(1);
}
mkdirSync(localRoot, { recursive: true });
replaceLink(rustLib, rustLink);
replaceLink(streamlogLib, streamlogLink);
replaceLink(protoDir, protoLink);

console.log(`linked edgecommons Rust -> ${rustLib} (stub at ${rustLink})`);
