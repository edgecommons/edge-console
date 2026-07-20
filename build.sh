#!/usr/bin/env bash
#
# Custom GDK build for the edge-console Greengrass component (single-device IPC-local deployment).
#
# `gdk component build` invokes this (see gdk-config.json -> custom_build_command). The GDK contract
# for a custom build system is that this script must place:
#   - the recipe   in  greengrass-build/recipes/
#   - the artifact in  greengrass-build/artifacts/<ComponentName>/<ComponentVersion>/
# (GDK creates those folders before calling us.)
#
# The artifact is a zip that bundles two things the console needs on-device:
#   1. the gateway binary, built with the `greengrass` feature (Greengrass IPC). That SDK is a
#      Linux-only C-FFI crate (bindgen + libclang + cc), so build on a Linux host (or WSL). It will
#      not compile on Windows/MSVC.
#   2. the built UI (ui/dist) under `ui/`, which the console serves itself (recipe webRoot: "ui").
#
# WSL / cross note: the greengrass build must run on a Linux toolchain. Either run this whole script
# inside WSL/Linux, or set EDGECOMMONS_TARGET to a Linux triple you have a cross toolchain for, e.g.:
#   EDGECOMMONS_TARGET=x86_64-unknown-linux-gnu ./build.sh
set -euo pipefail

COMPONENT_NAME="com.mbreissi.edgecommons.EdgeConsole"
COMPONENT_VERSION="$(python3 -c 'import json; c = json.load(open("gdk-config.json"))["component"]; print(next(iter(c.values()))["version"])')"
BIN_NAME="edge-console-gateway"

# Greengrass-mode features for the device build (Greengrass IPC, no MQTT/standalone).
FEATURES="${EDGECOMMONS_FEATURES:-greengrass}"
TARGET="${EDGECOMMONS_TARGET:-}"
TARGET_DIR="${CARGO_TARGET_DIR:-target}"

# The gateway depends on the gitignored sibling-library link at local/edgecommons-rust. Create it if
# absent (npm run link:rust / scripts/link-sibling-rust.mjs). CI/on-device sets EDGECOMMONS_RUST_LIB.
if [[ ! -e "local/edgecommons-rust" ]]; then
  echo "Linking sibling edgecommons Rust library..."
  node scripts/link-sibling-rust.mjs
fi

echo "Building UI (protocol + ui/dist)..."
npm run build -w protocol
npm run build -w ui

echo "Building ${BIN_NAME} (release, features=${FEATURES})${TARGET:+ for ${TARGET}}..."
if [[ -n "${TARGET}" ]]; then
  cargo build --release --no-default-features --features "${FEATURES}" -p edge-console-gateway --target "${TARGET}"
  BIN_DIR="${TARGET_DIR}/${TARGET}/release"
else
  cargo build --release --no-default-features --features "${FEATURES}" -p edge-console-gateway
  BIN_DIR="${TARGET_DIR}/release"
fi

BIN_PATH="${BIN_DIR}/${BIN_NAME}"
if [[ ! -f "${BIN_PATH}" ]]; then
  echo "error: built binary not found at ${BIN_PATH}" >&2
  exit 1
fi

# Stage a zip whose top directory is `EdgeConsole/` (so it unpacks to
# {artifacts:decompressedPath}/EdgeConsole/... to match the recipe Run lifecycle).
STAGE_DIR="$(mktemp -d)/EdgeConsole"
mkdir -p "${STAGE_DIR}/ui"
cp "${BIN_PATH}" "${STAGE_DIR}/${BIN_NAME}"
chmod +x "${STAGE_DIR}/${BIN_NAME}" || true
cp -r ui/dist/. "${STAGE_DIR}/ui/"

ARTIFACT_DIR="greengrass-build/artifacts/${COMPONENT_NAME}/${COMPONENT_VERSION}"
RECIPE_DIR="greengrass-build/recipes"
mkdir -p "${ARTIFACT_DIR}" "${RECIPE_DIR}"

ZIP_PATH="$(pwd)/${ARTIFACT_DIR}/EdgeConsole.zip"
rm -f "${ZIP_PATH}"
( cd "$(dirname "${STAGE_DIR}")" && zip -rq "${ZIP_PATH}" "EdgeConsole" )
cp recipe.yaml "${RECIPE_DIR}/recipe.yaml"

echo "Staged artifact -> ${ARTIFACT_DIR}/EdgeConsole.zip"
echo "Staged recipe   -> ${RECIPE_DIR}/recipe.yaml"
