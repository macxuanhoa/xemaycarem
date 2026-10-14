/**
 * webpush.ts — Trình gửi Web Push chuẩn RFC 8291 (aes128gcm) + RFC 8292 (VAPID),
 * viết thuần trên WebCrypto, KHÔNG dùng dependency ngoài.
 *
 * Lý do tự viết: các Edge Function của Cà Rem chạy với `--cached-only` trong
 * pipeline xác minh (scripts/check-edge-native.mjs); mọi gói npm mới đều phải
 * có sẵn trong cache Deno của máy CI. Tiền lệ trong repo: bank-webhook tự viết
 * MD5/HMAC thay vì kéo gói. WebCrypto có đủ ECDH P-256 + HKDF + AES-128-GCM.
 *
 * File này chỉ dùng API chuẩn (isolated-strict sạch): unit test Node có thể
 * import trực tiếp để kiểm round-trip với bản giải mã mô phỏng.
 */

export interface PushTarget {
  endpoint: string;
  /** Khóa công khai subscriber, base64url raw P-256 (65 byte). */
  p256dh: string;
  /** Khóa auth (16 byte), base64url. */
  auth: string;
}

export interface VapidConfig {
  /** Khóa công khai VAPID, base64url raw uncompressed (65 byte). */
  publicKey: string;
  /** Khóa riêng VAPID, JWK ES256 đã serialize (b64u đủ mọi trường). */
  privateKeyJwk: JsonWebKey;
  /** Ví dụ "mailto:it@carem.example". */
  subject: string;
}

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const MAX_PAYLOAD_BYTES = 4096;
const RECORD_SIZE = 4096;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  // HKDF trong WebCrypto gộp Extract+Expand: IKM nằm ở KEY HANDLE (baseKey),
  // salt/info nằm ở tham số deriveBits. Truyền nhầm salt làm key material sẽ
  // sinh khóa sai so với RFC 8291 và browser không giải mã được — unit test
  // round-trip (tests/unit/push-contract.test.ts) canh cửa này.
  const baseKey = await crypto.subtle.importKey('raw', ikm as unknown as ArrayBuffer, 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, info: info as unknown as ArrayBuffer },
    baseKey, length * 8,
  );
  return new Uint8Array(derived);
}

/**
 * Mã hóa payload theo RFC 8291 (content coding aes128gcm):
 *   ecdh_secret = ECDH(đôi_local_priv, ua_pub)
 *   key_info    = "WebPush: info" 0x00 || ua_pub || as_pub
 *   IKM(32)     = HKDF-Expand(HKDF-Extract(salt=auth, ikm=ecdh_secret), key_info)
 *   CEK(16) + NONCE(12); body = salt(16) || rs(4) || idlen(1) || as_pub(65) || records
 *   nonce ghi = NONCE[0..8] || uint32be(sequence)
 */
export async function encryptPushPayload(target: PushTarget, plaintext: Uint8Array): Promise<Uint8Array> {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new RangeError('PUSH_PAYLOAD_TOO_LARGE');
  // Chuỗi rác từ DB (thực ra đã bị RPC chặn ở cửa INVALID_KEY) vẫn không được
  // phép làm crash cả lô dispatch bằng DOMException 'Invalid character' —
  // trả về đúng mã lỗi hợp đồng để dispatcher phân loại PERMANENT.
  let uaPublic: Uint8Array;
  try { uaPublic = base64UrlDecode(target.p256dh); } catch { throw new RangeError('PUSH_SUBSCRIPTION_KEY_INVALID'); }
  if (uaPublic.length !== 65) throw new RangeError('PUSH_SUBSCRIPTION_KEY_INVALID');
  let authSecret: Uint8Array;
  try { authSecret = base64UrlDecode(target.auth); } catch { throw new RangeError('PUSH_SUBSCRIPTION_AUTH_INVALID'); }
  if (authSecret.length < 8 || authSecret.length > 32) throw new RangeError('PUSH_SUBSCRIPTION_AUTH_INVALID');

  const localPair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  const localPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', localPair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic as unknown as ArrayBuffer, P256, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, localPair.privateKey, 256));

  const keyInfo = concat(utf8('WebPush: info'), new Uint8Array([0]), uaPublic, localPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = ikm.subarray(0, 16);
  const nonce = ikm.subarray(16, 28);

  const cekKey = await crypto.subtle.importKey('raw', cek as unknown as ArrayBuffer, { name: 'AES-GCM', length: 128 }, false, ['encrypt']);
  const maxRecord = RECORD_SIZE - 16;
  // Kích thước thật = header(salt16+rs4+idlen1+as_pub65) + toàn bộ plaintext
  // + tag 16 byte MỖI record. Trần cũ '32+4096' tràn bộ đệm ngay với payload
  // > 1 record (vd 4096 byte → 2 record cần 4.214 byte).
  const recordCount = Math.max(1, Math.ceil(plaintext.length / maxRecord));
  const body = new Uint8Array(86 + plaintext.length + 16 * recordCount);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  body.set(salt, 0);
  const view = new DataView(body.buffer);
  view.setUint32(16, RECORD_SIZE);
  body[20] = localPublicRaw.length;
  body.set(localPublicRaw, 21);
  let written = 21 + localPublicRaw.length;
  let sequence = 0;
  let offset = 0;
  do {
    const chunk = plaintext.subarray(offset, offset + maxRecord);
    offset += chunk.length;
    const iv = new Uint8Array(12);
    iv.set(nonce.subarray(0, 8), 0);
    const counter = new DataView(iv.buffer);
    counter.setUint32(8, sequence);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, cekKey, chunk as unknown as ArrayBuffer));
    body.set(sealed, written);
    written += sealed.length;
    sequence += 1;
  } while (offset < plaintext.length);
  return body.subarray(0, written);
}

/** JWT VAPID ES256 (RFC 8292): aud = origin endpoint, exp = +12h, sub bắt buộc. */
export async function createVapidJwt(vapid: VapidConfig, endpoint: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = base64UrlEncode(utf8(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: vapid.publicKey })));
  // exp tuyệt đối, không quá 24h theo RFC 8292 §4.
  const claims = base64UrlEncode(utf8(JSON.stringify({ aud, exp: nowSeconds + 43200, sub: vapid.subject })));
  const privateKey = await crypto.subtle.importKey('jwk', vapid.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(`${header}.${claims}`) as unknown as ArrayBuffer));
  return `${header}.${claims}.${base64UrlEncode(signature)}`;
}

export interface PushSendResult {
  status: number;
  /** true khi endpoint đã chết (404/410) — phải quên subscription. */
  gone: boolean;
  /** true khi nên thử lại sau (429/5xx/lỗi mạng/timeout). */
  retryable: boolean;
}

/**
 * Gửi một push đã mã hóa. Timeout 5s/bước để worker không treo; mọi lỗi network
 * được coi là retryable — RPC complete phía DB quyết định backoff có trần.
 */
export async function sendPush(target: PushTarget, plaintext: string, vapid: VapidConfig, ttlSeconds = 3600): Promise<PushSendResult> {
  const body = await encryptPushPayload(target, utf8(plaintext));
  const jwt = await createVapidJwt(vapid, target.endpoint);
  try {
    const response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttlSeconds),
        Urgency: 'normal',
      },
      body: body as unknown as ArrayBuffer,
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      gone: response.status === 404 || response.status === 410,
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch {
    // fetch từ chối/timeout/DNS lỗi: không bao giờ được làm chết cả lô.
    return { status: 0, gone: false, retryable: true };
  }
}
