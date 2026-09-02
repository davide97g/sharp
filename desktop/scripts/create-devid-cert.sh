#!/usr/bin/env bash
# Creates a "Developer ID Application" certificate through the App Store Connect
# API and imports it (with its private key) into the login keychain.
#
#   ASC_KEY=~/private_keys/AuthKey_XXXX.p8 ASC_KEY_ID=XXXX ASC_ISSUER_ID=uuid \
#     ./create-devid-cert.sh
#
# Idempotent: if a Developer ID Application certificate matching our private key
# already exists on the account, it is downloaded instead of creating a second
# one (Apple caps a team at 5).
#
# Creating one over the API needs the Account Holder role, which an App Store
# Connect API key cannot hold ("403 FORBIDDEN_ERROR ... only be performed by the
# Account Holder"). So the first run prints the CSR to upload at
# https://developer.apple.com/account/resources/certificates/add; feed the
# downloaded .cer back with DEVID_CER=~/Downloads/developerID_application.cer.
# Afterwards the certificate is on the account and plain runs just fetch it.
set -euo pipefail

: "${ASC_KEY:?set ASC_KEY to the .p8 path}"
: "${ASC_KEY_ID:?set ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"

here="$(cd "$(dirname "$0")" && pwd)"
work="${DEVID_WORKDIR:-$here/.devid}"
mkdir -p "$work"
chmod 700 "$work"

jwt="$(bun run "$here/asc-jwt.mjs" "$ASC_KEY" "$ASC_KEY_ID" "$ASC_ISSUER_ID")"
# -g so curl leaves the filter[...] brackets alone instead of reading a range.
api() { curl -sS -g -H "Authorization: Bearer $jwt" "$@"; }

# A downloaded certificate is only usable alongside the private key its CSR was
# made from, so keep both here.
if [ ! -f "$work/devid.key" ]; then
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "$work/devid.key" -out "$work/devid.csr" \
    -subj "/CN=Sharp Developer ID/C=IT" 2>/dev/null
fi

existing="$(api 'https://api.appstoreconnect.apple.com/v1/certificates?filter[certificateType]=DEVELOPER_ID_APPLICATION&limit=200')"
case "$existing" in *'"errors"'*) echo "$existing"; exit 1;; esac

our_pub="$(openssl rsa -in "$work/devid.key" -pubout 2>/dev/null | openssl md5)"
content=""
for c in $(printf '%s' "$existing" | bun -e '
  const d = JSON.parse(await Bun.stdin.text()).data ?? []
  console.log(d.map((x) => x.attributes.certificateContent).join(" "))
'); do
  printf '%s' "$c" | base64 -d > "$work/candidate.der" 2>/dev/null || continue
  cand="$(openssl x509 -inform der -in "$work/candidate.der" -pubkey -noout 2>/dev/null | openssl md5)"
  if [ "$cand" = "$our_pub" ]; then content="$c"; break; fi
done

if [ -z "$content" ] && [ -n "${DEVID_CER:-}" ]; then
  # Manual route: a .cer downloaded from the portal for the CSR in $work.
  echo "==> importing $DEVID_CER"
  content="$(base64 < "$DEVID_CER" | tr -d '\n')"
elif [ -z "$content" ]; then
  echo "==> requesting a new Developer ID Application certificate"
  body="$(CSR_PATH="$work/devid.csr" bun -e '
    const csr = await Bun.file(process.env.CSR_PATH).text()
    console.log(JSON.stringify({ data: { type: "certificates", attributes: {
      certificateType: "DEVELOPER_ID_APPLICATION", csrContent: csr } } }))
  ')"
  resp="$(api -X POST -H 'Content-Type: application/json' -d "$body" \
    https://api.appstoreconnect.apple.com/v1/certificates)"
  case "$resp" in
    *FORBIDDEN_ERROR*)
      cat >&2 <<MSG
Apple refuses to mint a Developer ID certificate over the API: that is reserved
for the Account Holder, a role no API key can hold. Do it once by hand instead —

  1. open https://developer.apple.com/account/resources/certificates/add
  2. pick "Developer ID Application", upload this CSR:
       $work/devid.csr
  3. download the .cer, then re-run:
       DEVID_CER=~/Downloads/developerID_application.cer $0

Or in Xcode: Settings > Accounts > (your Apple ID) > Manage Certificates > "+" >
Developer ID Application. That puts the identity straight in the keychain and
this script becomes unnecessary.
MSG
      exit 1;;
    *'"errors"'*) echo "$resp" >&2; exit 1;;
  esac
  content="$(printf '%s' "$resp" | bun -e '
    console.log(JSON.parse(await Bun.stdin.text()).data.attributes.certificateContent)
  ')"
else
  echo "==> reusing the existing certificate that matches our private key"
fi

printf '%s' "$content" | base64 -d > "$work/devid.cer"
openssl x509 -inform der -in "$work/devid.cer" -out "$work/devid.pem"
openssl pkcs12 -export -legacy \
  -inkey "$work/devid.key" -in "$work/devid.pem" \
  -out "$work/devid.p12" -passout pass:sharp -name "Sharp Developer ID"

echo "==> importing into the login keychain"
security import "$work/devid.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P sharp -T /usr/bin/codesign -T /usr/bin/productsign >/dev/null

echo
security find-identity -v -p codesigning | grep "Developer ID Application" ||
  echo "certificate imported but not listed — check Keychain Access"
