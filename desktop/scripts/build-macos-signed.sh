#!/usr/bin/env bash
# Builds the macOS desktop bundle, signs it with the Developer ID Application
# certificate, notarizes it with Apple and staples the ticket, so the .dmg can
# be handed to anyone and opens without a Gatekeeper warning.
#
#   ASC_KEY=~/private_keys/AuthKey_XXXX.p8 ASC_KEY_ID=XXXX ASC_ISSUER_ID=uuid \
#     ./build-macos-signed.sh
#
# Signing identity is picked up from the keychain (see create-devid-cert.sh).
set -euo pipefail

: "${ASC_KEY:?set ASC_KEY to the .p8 path}"
: "${ASC_KEY_ID:?set ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"

identity="${APPLE_SIGNING_IDENTITY:-$(
  security find-identity -v -p codesigning |
    sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1
)}"
[ -n "$identity" ] || {
  echo "no Developer ID Application identity in the keychain — run create-devid-cert.sh first" >&2
  exit 1
}
team="$(printf '%s' "$identity" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')"
echo "==> signing as: $identity (team $team)"

# Tauri signs and notarizes in-process when these are set; the API key covers
# notarytool, so no app-specific password is needed.
export APPLE_SIGNING_IDENTITY="$identity"
export APPLE_TEAM_ID="$team"
export APPLE_API_KEY="$ASC_KEY_ID"
export APPLE_API_ISSUER="$ASC_ISSUER_ID"
export APPLE_API_KEY_PATH="$ASC_KEY"

cd "$desktop"
# CI makes the dmg bundler pass --skip-jenkins, skipping the Finder AppleScript
# that lays the window out. That AppleScript times out (-1712) in any shell
# without Automation permission for Finder, and its only effect is cosmetic.
CI=true bun run tauri build --config src-tauri/tauri.dist.conf.json

app="$desktop/src-tauri/target/release/bundle/macos/sharp.app"
dmg="$(ls -1t "$desktop/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null | head -1)"

# Tauri notarizes and staples the .app but only signs the .dmg. Notarizing the
# disk image too means the ticket travels with the file that actually gets sent,
# so it verifies even on a Mac that is offline the first time it mounts it.
if [ -n "$dmg" ]; then
  echo
  echo "==> notarizing the disk image"
  xcrun notarytool submit "$dmg" \
    --key "$ASC_KEY" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait
  xcrun stapler staple "$dmg"
fi

echo
echo "==> verifying"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=4 "$app" || true
xcrun stapler validate "$app" || true
if [ -n "$dmg" ]; then
  xcrun stapler validate "$dmg" || true
  echo
  echo "$dmg"
  shasum -a 256 "$dmg"
fi
