// Hợp đồng Web Push: bản dựng phía server (supabase/functions/_shared) phải
// tương thích 100% bản parse phía client/SW (src/lib/pushContracts.ts), và
// bản mã hóa RFC 8291 phải giải được bằng subscriber mô phỏng độc lập
// (node:crypto cho HKDF + AES-128-GCM — không dùng lại helper của webpush.ts).
// Đổi một bên mà làm bên kia đỏ là mục tiêu của file này.
import { createDecipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parsePushPayload,
  safeDeepLink as clientSafeDeepLink,
  PUSH_FALLBACK_LINK,
  type CaremPushPayload,
} from "../../src/lib/pushContracts";
import {
  buildPushPayloadJson,
  safeDeepLink as serverSafeDeepLink,
  type ClaimedPushItem,
} from "../../supabase/functions/_shared/push-payload";
import {
  base64UrlDecode,
  base64UrlEncode,
  createVapidJwt,
  encryptPushPayload,
  type PushTarget,
  type VapidConfig,
} from "../../supabase/functions/_shared/webpush";

const DELIVERY_ID = "3f2b7c91-5a4d-4c1b-9d8e-1a2b3c4d5e6f";

const item = (overrides: Partial<ClaimedPushItem> = {}): ClaimedPushItem => ({
  delivery_id: DELIVERY_ID,
  kind: "NOTIFICATION",
  title: "Chờ đối soát 1 giao dịch",
  body: "Kiểm tra danh sách giao dịch ngân hàng.",
  link: "/doi-soat",
  ...overrides,
});

describe("push payload contract — server build ↔ client parse", () => {
  it("round-trips a normal notification with every field preserved", () => {
    const parsed = parsePushPayload(buildPushPayloadJson(item()));
    expect(parsed).not.toBeNull();
    const expected: CaremPushPayload = {
      v: 1,
      kind: "notification",
      id: DELIVERY_ID,
      title: "Chờ đối soát 1 giao dịch",
      body: "Kiểm tra danh sách giao dịch ngân hàng.",
      link: "/doi-soat",
    };
    expect(parsed).toEqual(expected);
  });

  it("maps TEST kind and keeps its /cai-dat link through the whitelist", () => {
    const parsed = parsePushPayload(
      buildPushPayloadJson(item({ kind: "TEST", title: "Kiểm tra thông báo đẩy", link: "/cai-dat" })),
    );
    expect(parsed?.kind).toBe("test");
    expect(parsed?.link).toBe("/cai-dat");
  });

  it("null/blank server text never produces a payload the client parser rejects", () => {
    const parsed = parsePushPayload(buildPushPayloadJson(item({ title: null, body: null, link: null })));
    expect(parsed).not.toBeNull(); // title fallback "Cà Rem", body "", link fallback
    expect(parsed?.title).toBe("Cà Rem");
    expect(parsed?.body).toBe("");
    expect(parsed?.link).toBe(PUSH_FALLBACK_LINK);
  });

  it("clamps oversized title/body to exactly the parser's caps (160/400)", () => {
    const parsed = parsePushPayload(
      buildPushPayloadJson(item({ title: "T".repeat(300), body: "B".repeat(900) })),
    );
    expect(parsed?.title.length).toBe(160);
    expect(parsed?.body.length).toBe(400);
  });

  const hostileLinks = [
    "//evil.example/x",
    "https://evil.example/x",
    "javascript:alert(1)",
    "/a\\b",
    "/ok\u0000../../etc",
    `/${"y".repeat(300)}`,
    "",
    undefined,
    42,
  ];
  it("hostile deep links are neutralized identically on both sides", () => {
    for (const link of hostileLinks) {
      expect(serverSafeDeepLink(link)).toBe(clientSafeDeepLink(link));
      const parsed = parsePushPayload(buildPushPayloadJson(item({ link: link as string | null })));
      expect(parsed?.link).toBe(PUSH_FALLBACK_LINK);
    }
  });

  it("client parser rejects malformed versions of its own contract", () => {
    expect(parsePushPayload(null)).toBeNull();
    expect(parsePushPayload("not json")).toBeNull();
    expect(parsePushPayload("[1,2]")).toBeNull();
    expect(parsePushPayload(JSON.stringify({ ...item(), v: 2 }))).toBeNull();
    expect(parsePushPayload(JSON.stringify({ v: 1, kind: "sms", id: "x", title: "t", body: "", link: "/" }))).toBeNull();
    expect(parsePushPayload(JSON.stringify({ v: 1, kind: "notification", id: "", title: "t", body: "", link: "/" }))).toBeNull();
    expect(parsePushPayload(JSON.stringify({ v: 1, kind: "notification", id: "x", title: "", body: "", link: "/" }))).toBeNull();
  });
});

// ---- RFC 8291: encrypt with webpush.ts, decrypt with an independent subscriber.
type Subscriber = { keyPair: CryptoKeyPair; uaPublicRaw: Uint8Array; authSecret: Uint8Array };

async function createSubscriber(): Promise<Subscriber> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    keyPair,
    uaPublicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
    authSecret: crypto.getRandomValues(new Uint8Array(16)),
  };
}

function subscriberTarget(sub: Subscriber): PushTarget {
  return {
    endpoint: "https://push.example.com/f/abc",
    p256dh: base64UrlEncode(sub.uaPublicRaw),
    auth: base64UrlEncode(sub.authSecret),
  };
}

/** Giải mã aes128gcm theo đúng RFC 8291 — HKDF/AES lấy từ node:crypto. */
async function decryptAsSubscriber(encrypted: Uint8Array, sub: Subscriber): Promise<Uint8Array> {
  const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  const recordSize = view.getUint32(16);
  const idlen = encrypted[20];
  const asPublic = encrypted.slice(21, 21 + idlen);
  let offset = 21 + idlen;

  const asKey = await crypto.subtle.importKey("raw", asPublic as unknown as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, sub.keyPair.privateKey, 256));
  const keyInfo = new Uint8Array([...new TextEncoder().encode("WebPush: info"), 0, ...sub.uaPublicRaw, ...asPublic]);
  // RFC 8291: salt HKDFExtract = auth_secret (KHÔNG phải salt 16 byte trong
  // header — trường đó chỉ là định danh message, không vào khóa).
  const ikm = new Uint8Array(hkdfSync("sha256", ecdhSecret, sub.authSecret, keyInfo, 32));
  const cek = ikm.slice(0, 16);
  const nonce = ikm.slice(16, 28);

  const out: Uint8Array[] = [];
  let sequence = 0;
  while (offset < encrypted.length) {
    const chunk = encrypted.slice(offset, offset + recordSize);
    offset += chunk.length;
    const iv = new Uint8Array(12);
    iv.set(nonce.slice(0, 8), 0);
    new DataView(iv.buffer).setUint32(8, sequence);
    const decipher = createDecipheriv("aes-128-gcm", cek, iv);
    decipher.setAuthTag(chunk.slice(chunk.length - 16));
    const plain = new Uint8Array(decipher.update(chunk.slice(0, chunk.length - 16)));
    decipher.final();
    out.push(plain);
    sequence += 1;
  }
  const total = out.reduce((s, c) => s + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of out) { joined.set(c, at); at += c.length; }
  return joined;
}

describe("RFC 8291 aes128gcm content coding", () => {
  it("a spec-conformant subscriber decrypts the exact JSON payload", async () => {
    const sub = await createSubscriber();
    const json = buildPushPayloadJson(item());
    const encrypted = await encryptPushPayload(subscriberTarget(sub), new TextEncoder().encode(json));
    // Header đúng khung: salt 16 + rs 4 + idlen 1 + 65 byte key công khai cục bộ.
    expect(encrypted[20]).toBe(65);
    expect(new DataView(encrypted.buffer, encrypted.byteOffset + 16, 4).getUint32(0)).toBe(4096);
    const decrypted = await decryptAsSubscriber(encrypted, sub);
    expect(new TextDecoder().decode(decrypted)).toBe(json);
    expect(parsePushPayload(new TextDecoder().decode(decrypted))).not.toBeNull();
  });

  it("splits a 4096-byte payload into multiple records and reassembles losslessly", async () => {
    const sub = await createSubscriber();
    const plaintext = crypto.getRandomValues(new Uint8Array(4096));
    const encrypted = await encryptPushPayload(subscriberTarget(sub), plaintext);
    const decrypted = await decryptAsSubscriber(encrypted, sub);
    expect(decrypted).toEqual(plaintext);
  });

  it("rejects oversized payloads and malformed subscription material", async () => {
    const sub = await createSubscriber();
    await expect(encryptPushPayload(subscriberTarget(sub), new Uint8Array(4097))).rejects.toThrow(/PUSH_PAYLOAD_TOO_LARGE/);
    await expect(
      encryptPushPayload({ ...subscriberTarget(sub), p256dh: "too-short" }, new Uint8Array(1)),
    ).rejects.toThrow(/PUSH_SUBSCRIPTION_KEY_INVALID/);
    await expect(
      encryptPushPayload({ ...subscriberTarget(sub), auth: base64UrlEncode(new Uint8Array(4)) }, new Uint8Array(1)),
    ).rejects.toThrow(/PUSH_SUBSCRIPTION_AUTH_INVALID/);
  });

  it("base64url helpers round-trip every byte value (no +, /, = leakage)", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const encoded = base64UrlEncode(all);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toEqual(all);
  });
});

describe("RFC 8292 VAPID", () => {
  async function makeVapid(): Promise<VapidConfig> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    return {
      publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      privateKeyJwk: { ...jwk, ext: false },
      subject: "mailto:it@carem.example",
    };
  }

  it("produces an ES256 JWT verifiable against the VAPID public key with RFC-bounded claims", async () => {
    const vapid = await makeVapid();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await createVapidJwt(vapid, "https://android.googleapis.com/gcm/send/abc", now);
    const [headerB64, claimsB64, sigB64] = jwt.split(".");
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(claimsB64)));
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: vapid.publicKey });
    expect(claims.aud).toBe("https://android.googleapis.com");
    expect(claims.sub).toBe("mailto:it@carem.example");
    expect(claims.exp).toBe(now + 43200); // ≤ 24h theo RFC 8292 §4
    const publicKey = await crypto.subtle.importKey(
      "raw", base64UrlDecode(vapid.publicKey) as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey,
      base64UrlDecode(sigB64) as unknown as ArrayBuffer,
      new TextEncoder().encode(`${headerB64}.${claimsB64}`) as unknown as ArrayBuffer,
    );
    expect(ok).toBe(true);
  });

  it("signature fails once anyone tampers with the claims", async () => {
    const vapid = await makeVapid();
    const jwt = await createVapidJwt(vapid, "https://push.example.com/x");
    const [headerB64, , sigB64] = jwt.split(".");
    const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ aud: "https://evil.example", exp: 0, sub: "mailto:x@x" })));
    const publicKey = await crypto.subtle.importKey(
      "raw", base64UrlDecode(vapid.publicKey) as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey,
      base64UrlDecode(sigB64) as unknown as ArrayBuffer,
      new TextEncoder().encode(`${headerB64}.${forged}`) as unknown as ArrayBuffer,
    );
    expect(ok).toBe(false);
  });
});
