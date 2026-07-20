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

# Raise the AWS GG IPC SDK's concurrent-stream ceiling. aws-greengrass-component-sdk vendors a C
# header that caps concurrent IPC subscription streams at GG_IPC_MAX_STREAMS (default 16). The console
# opens ~13 concurrent IPC subscription streams at startup, so the default 16 is too tight and the
# component crash-loops on the nucleus. The header is #ifndef-guarded, so 64 is a supported override.
# The `cc` crate that compiles the SDK reads CFLAGS, so baking the define in here makes the committed
# greengrass build deployable with no manual env. (Only affects this greengrass build; the define is
# inert for any other C crate. HOST/standalone builds don't run this script.)
export CFLAGS="${CFLAGS:-} -DGG_IPC_MAX_STREAMS=64"

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

# Stage the binary + `ui/` at the ZIP ROOT (no extra top-level dir). Greengrass unpacks a ZIP
# artifact into a folder named after the archive minus its extension, i.e. EdgeConsole.zip ->
# {artifacts:decompressedPath}/EdgeConsole/<zip contents>. So the zip must contain the files at its
# root; a top-level EdgeConsole/ dir here would double-nest to
# {artifacts:decompressedPath}/EdgeConsole/EdgeConsole/... (broken on-device). The recipe Run
# lifecycle `cd {artifacts:decompressedPath}/EdgeConsole` then finds ./edge-console-gateway and ./ui.
STAGE_DIR="$(mktemp -d)"
mkdir -p "${STAGE_DIR}/ui"
cp "${BIN_PATH}" "${STAGE_DIR}/${BIN_NAME}"
chmod +x "${STAGE_DIR}/${BIN_NAME}" || true
cp -r ui/dist/. "${STAGE_DIR}/ui/"

ARTIFACT_DIR="greengrass-build/artifacts/${COMPONENT_NAME}/${COMPONENT_VERSION}"
RECIPE_DIR="greengrass-build/recipes"
mkdir -p "${ARTIFACT_DIR}" "${RECIPE_DIR}"

ZIP_PATH="$(pwd)/${ARTIFACT_DIR}/EdgeConsole.zip"
rm -f "${ZIP_PATH}"
( cd "${STAGE_DIR}" && zip -rq "${ZIP_PATH}" . )
cp recipe.yaml "${RECIPE_DIR}/recipe.yaml"

echo "Staged artifact -> ${ARTIFACT_DIR}/EdgeConsole.zip"
echo "Staged recipe   -> ${RECIPE_DIR}/recipe.yaml"
