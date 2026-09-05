# sharp desktop

A [Tauri 2](https://v2.tauri.app) shell that wraps the sharp web app as a native
desktop application for macOS, Windows and Linux.

The frontend is the built web SPA (`../web/dist`). Because `VITE_API_URL` is left
unset for desktop builds, the login screen shows a "server" field (detected via
`__TAURI_INTERNALS__`) where the user enters their server URL; it is persisted in
localStorage.

## Prerequisites

- Node 22+
- Rust (stable) + the platform build tools Tauri needs
  (see https://v2.tauri.app/start/prerequisites/)

## Develop

```bash
bun install
bun run tauri dev     # runs `bun run --cwd ../web dev` and opens the shell
```

## Build

```bash
bun run tauri build   # runs `bun run --cwd ../web build` first, then bundles
```

Set `CI=true` when building the `.dmg` from a shell that has no Automation
permission for Finder: the dmg bundler otherwise blocks on an AppleScript that
only arranges the disk-image window, and fails with `AppleEvent timed out
(-1712)`.

Bundle targets are `all` (macOS `.dmg`, Windows NSIS `.exe`, Linux AppImage/`.deb`),
resolved per host platform. CI builds these on tags via `tauri-apps/tauri-action`
(see `.github/workflows/release.yml`).

## Signed + notarized macOS build (shareable)

An unsigned bundle only runs on the machine that built it — anyone else gets
"sharp is damaged and can't be opened". To hand the `.dmg` to someone, it must be
signed with a **Developer ID Application** certificate (a paid Apple Developer
membership; an "Apple Development" certificate is *not* enough) and notarized.

Two one-time manual steps, because Apple gates each on a human:

1. **The certificate.** Xcode → Settings → Accounts → your Apple ID → *Manage
   Certificates…* → **+** → **Developer ID Application**. This is the short path:
   it creates the keypair and puts the identity straight in the login keychain.
   Creating one over the App Store Connect API is impossible — it is reserved for
   the *Account Holder*, a role no API key can hold (`403 FORBIDDEN_ERROR: This
   operation can only be performed by the Account Holder`). If you would rather
   use the portal, `scripts/create-devid-cert.sh` generates a CSR to upload at
   <https://developer.apple.com/account/resources/certificates/add> and imports
   the downloaded `.cer` back next to its key when re-run with
   `DEVID_CER=~/Downloads/developerID_application.cer`. Once the certificate
   exists on the account, plain runs of that script just fetch it — handy on a
   second machine. Its keypair lives in `scripts/.devid/` (gitignored); back that
   up, it is what lets another machine sign as the same identity.

2. **Notarization credentials.** An App Store Connect API key with the **Admin**
   role at <https://appstoreconnect.apple.com/access/integrations/api>: download
   the `AuthKey_<KEYID>.p8` (Apple allows exactly one download), and note the Key
   ID plus the Issuer ID shown above the table. Keep the key at
   `~/.appstoreconnect/private_keys/` with mode 600 — it grants Admin access to
   the whole account.

Then, per release:

```bash
export ASC_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

./scripts/build-macos-signed.sh    # build, sign, notarize, staple, verify
```

`build-macos-signed.sh` builds with `src-tauri/tauri.dist.conf.json`, which swaps
in `Entitlements.dist.plist`. That file deliberately drops
`com.apple.developer.aps-environment`: it is a *restricted* entitlement, and a
Developer-ID build that claims it without an embedded provisioning profile is
killed at launch. Native APNs is therefore off in shared builds and push falls
back to the WebSocket, local notifications and web push. To enable it, add the
Push Notifications capability to the `dev.sharp.app` App ID, create a Developer ID
provisioning profile, embed it as `Contents/embedded.provisionprofile`, and sign
with `Entitlements.plist`.

The result is `src-tauri/target/release/bundle/dmg/sharp_<version>_aarch64.dmg`,
stapled — it opens on any Mac with no right-click dance. Note it is an
Apple-silicon build; a colleague on an Intel Mac needs
`--target x86_64-apple-darwin` (or `universal-apple-darwin`) added to the build.

### Signing in CI

`.github/workflows/release.yml` builds both macOS architectures on every `v*`
tag and uses the same distribution config, so a tagged release can be signed and
notarized without a local build. It stays **unsigned** until these repository
secrets exist; the workflow imports a certificate only when `APPLE_CERTIFICATE`
is set, and notarizes only when the API key is present.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the Developer ID Application certificate as a base64 `.p12`: `security export -t identities -f pkcs12 -k login.keychain -P '<pw>' -o cert.p12` then `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `-P` password used above |
| `APPLE_SIGNING_IDENTITY` | the full identity string, e.g. `Developer ID Application: Your Name (TEAMID)` — `security find-identity -v -p codesigning` prints it |
| `APPLE_TEAM_ID` | the 10-character team id in the parentheses above |
| `APPLE_API_KEY_ID` | App Store Connect Key ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`) |
| `APPLE_API_ISSUER_ID` | App Store Connect Issuer ID |
| `APPLE_API_KEY_P8` | the `.p8` itself, base64-encoded: `base64 -i AuthKey_XXXXXXXXXX.p8` |

The `.p8` travels base64-encoded because notarization needs it as a file on
disk; the workflow decodes it to `$RUNNER_TEMP` and points `APPLE_API_KEY_PATH`
at it. Everything in that table grants access to the Apple account — they belong
in repository secrets, never in the tree.

Windows needs no secrets: the NSIS installer is unsigned, and code-signing it
would need a separate Authenticode certificate.

## Icons (required once, locally)

Icon binaries are **not** committed — the Tauri CLI generates every platform icon
from a single source SVG/PNG. `tauri.conf.json` references `icons/icon.png`, so run
this once (from `desktop/`) before your first `tauri build`:

```bash
bun run tauri icon assets/icon.svg
```

This creates `src-tauri/icons/` (icon.png, icon.icns, icon.ico, and the various
`*.png` sizes). The source mark is `assets/icon.svg` (the `#` glyph on the accent
background). The release CI workflow runs this step automatically.

## Plugins / permissions

Two plugins are registered in `src-tauri/src/lib.rs` and granted in
`src-tauri/capabilities/default.json`:

- **tauri-plugin-notification** (`notification:default`) — new-message notifications
  when the window is unfocused.
- **tauri-plugin-shell** (`shell:allow-open`) — open external links in the system
  browser.

v1 registers the plugins; the web frontend calls them through the Tauri JS API when
available (feature-detected), and falls back to browser behaviour otherwise.
