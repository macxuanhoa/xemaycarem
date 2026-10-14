// Sinh cặp khóa VAPID ES256 (RFC 8292) cho Web Push — chạy cục bộ, không mạng.
// Usage: node scripts/generate-vapid-keys.mjs
// Kết quả DÁN vào Supabase Edge Function secrets (KHÔNG commit):
//   VAPID_PUBLIC_KEY   (+ bản client: VITE_VAPID_PUBLIC_KEY trong .env)
//   VAPID_PRIVATE_JWK  (chỉ server)
// Chạy lại mỗi khi cần xoay khóa; khóa cũ thu hồi bằng cách xóa secret.
import { generateKeyPairSync } from 'node:crypto'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pub = publicKey.export({ format: 'jwk' })
const priv = privateKey.export({ format: 'jwk' })

// VAPID yêu cầu khóa công khai raw uncompressed 65 byte (0x04 || x || y), base64url.
const publicKeyB64 = (() => {
  const x = Buffer.from(pub.x, 'base64url')
  const y = Buffer.from(pub.y, 'base64url')
  const bytes = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(32 - x.length), x, Buffer.alloc(32 - y.length), y])
  if (bytes.length !== 65) throw new Error('unexpected P-256 public key length')
  return bytes.toString('base64url')
})()

console.log('VAPID_PUBLIC_KEY=' + publicKeyB64)
console.log('VITE_VAPID_PUBLIC_KEY=' + publicKeyB64)
console.log('VAPID_PRIVATE_JWK=' + JSON.stringify({ kty: 'EC', crv: 'P-256', d: priv.d, x: pub.x, y: pub.y, ext: false }))
console.log('\n# Kiểm tra nhanh: public phải khớp private khi import lại:')
const reimported = privateKey.export({ format: 'jwk' })
if (reimported.d !== priv.d) throw new Error('JWK round-trip mismatch')
