// Mints an App Store Connect API JWT (ES256) from a .p8 private key.
//
//   bun run asc-jwt.mjs <key.p8> <keyId> [issuerId]
//
// Team keys carry the team's issuer id in `iss`. Individual keys have no issuer:
// Apple wants `iss` omitted and `sub: "user"` instead, so pass no third argument.
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [keyPath, keyId, issuerId] = process.argv.slice(2)
if (!keyPath || !keyId) {
  console.error('usage: asc-jwt.mjs <key.p8> <keyId> [issuerId]')
  process.exit(1)
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const header = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })
const payload = b64({
  ...(issuerId ? { iss: issuerId } : { sub: 'user' }),
  iat: now,
  exp: now + 20 * 60,
  aud: 'appstoreconnect-v1',
})

const signer = createSign('SHA256')
signer.update(`${header}.${payload}`)
const sig = signer
  .sign({ key: readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' })
  .toString('base64url')

process.stdout.write(`${header}.${payload}.${sig}`)
