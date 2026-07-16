#!/usr/bin/env bash
# sharp — build the native macOS desktop app (Tauri 2).
#
# `tauri build` first runs the web build (beforeBuildCommand: bun --cwd ../web
# run build → tsc + vite build into web/dist), then compiles the Rust shell and
# bundles a macOS .app + .dmg. VITE_API_URL is deliberately left UNSET so the
# desktop app asks for a server URL at login (see CLAUDE.md).
#
#   scripts/build-native.sh                              # .app + .dmg for this Mac's arch
#   scripts/build-native.sh --target universal-apple-darwin   # universal (Intel + Apple Silicon)
#   scripts/build-native.sh --debug                      # faster, unoptimized build
#   scripts/build-native.sh --bundles app                # extra args pass straight to tauri
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "error: this build script is macOS-only (ran on $(uname -s))"
  exit 1
}

for bin in bun cargo; do
  command -v "$bin" >/dev/null || {
    echo "error: '$bin' is required (install it first)"
    exit 1
  }
done

# Desktop points at a user-entered server, not a baked-in API URL.
unset VITE_API_URL

echo "==> installing JS deps (web + desktop) if needed"
[ -d web/node_modules ] || bun --cwd web install
[ -d desktop/node_modules ] || bun --cwd desktop install

# Default to macOS .app + .dmg bundles; skip if the caller already passed
# their own --bundles / --target.
EXTRA=("$@")
if [[ " $* " != *" --bundles "* && " $* " != *" --target "* ]]; then
  EXTRA=(--bundles app,dmg "$@")
fi

echo "==> building macOS app (first build compiles Rust from scratch — minutes)"
(cd desktop && bun run build "${EXTRA[@]}")

# Locate the bundle dir (host-arch → target/release; --target → target/<triple>).
PROFILE="release"
[[ " $* " == *" --debug "* ]] && PROFILE="debug"
BUNDLE_DIR="desktop/src-tauri/target/$PROFILE/bundle"
if [[ " $* " == *" --target "* ]]; then
  TRIPLE="$(sed -n 's/.*--target \([^ ]*\).*/\1/p' <<<" $* ")"
  BUNDLE_DIR="desktop/src-tauri/target/$TRIPLE/$PROFILE/bundle"
fi

echo
if [[ -d "$BUNDLE_DIR" ]]; then
  echo "==> done. macOS bundles in $BUNDLE_DIR:"
  find "$BUNDLE_DIR" -maxdepth 2 \( -name '*.dmg' -o -name '*.app' \) -print
else
  echo "==> build finished, but no bundle dir at $BUNDLE_DIR — check the tauri output above"
fi
