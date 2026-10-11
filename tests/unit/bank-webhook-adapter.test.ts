import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseSePay,
  parseCasso,
  parseCassoEvents,
  verifySePaySignature,
  verifyCassoToken,
  verifyCassoSignature,
  verifySePayApiKey,
  verifyHmacSignature,
  safeEqual,
} from "../../supabase/functions/bank-webhook/adapter";

// Independent reference hashes (Node crypto) so the adapter is checked against a
// second implementation, never against itself.
const timestamp = String(Math.floor(Date.now() / 1000));
const sepaySig = (rawBody: string, secret: string, at = timestamp) =>
  "sha256=" + createHmac("sha256", secret).update(at + "." + rawBody, "utf8").digest("hex");
const hmacSig = (rawBody: string, secret: string) =>
  createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

describe("bank webhook provider adapters", () => {
  const sepayBody = {
    data: {
      id: "sp-1",
      amount: "30.000.000",
      description: "Thanh toán CAREM GD01001",
      transferred_at: "2026-10-11T08:00:00Z",
      sender_name: "NGUYEN VAN A",
      sender_vcsname: "VCB",
      type: "in",
    },
  };

  it("normalizes a SePay credit into the internal event shape", () => {
    const event = parseSePay(sepayBody);
    expect(event).not.toBeNull();
    expect(event?.provider).toBe("SEPAY");
    expect(event?.provider_txn_id).toBe("sp-1");
    expect(event?.amount).toBe("30000000");
    expect(event?.direction).toBe("in");
    expect(event?.transfer_content).toContain("CAREM GD01001");
  });

  it("marks debits as out so they never enter reconciliation", () => {
    const out = parseSePay({ ...sepayBody, data: { ...sepayBody.data, type: "out" } });
    expect(out?.direction).toBe("out");
  });

  it("rejects SePay payloads with no data envelope", () => {
    expect(parseSePay({ id: "x" })).toBeNull();
  });

  it("normalizes Casso only when the vqb_id key is present", () => {
    const event = parseCasso({
      vqb_id: "c-9",
      vqb_amount_in: "12000000",
      vqb_content_bank: "CAREM GD02002",
      vqb_date: "2026-10-11T09:00:00Z",
    });
    expect(event?.provider).toBe("CASSO");
    expect(event?.amount).toBe("12000000");
    expect(parseCasso({ amount: "1" })).toBeNull();
  });

  it("accepts a genuine SePay signature and rejects forged or malformed ones", async () => {
    const secret = "top-secret";
    const raw = JSON.stringify(sepayBody);
    expect(await verifySePaySignature(raw, sepaySig(raw, secret), secret, timestamp)).toBe(true);
    // Same body signed with the wrong secret must fail.
    expect(await verifySePaySignature(raw, sepaySig(raw, "other"), secret, timestamp)).toBe(false);
    // Missing / malformed signature header is rejected before any hashing.
    expect(await verifySePaySignature(raw, null, secret, timestamp)).toBe(false);
    expect(await verifySePaySignature(raw, "not-hmac", secret, timestamp)).toBe(false);
    // No secret configured => fail closed.
    expect(await verifySePaySignature(raw, sepaySig(raw, ""), "", timestamp)).toBe(false);
  });

  it("accepts a genuine HMAC-SHA256 signature and rejects a tampered body", async () => {
    const secret = "hmac-key";
    const raw = JSON.stringify(sepayBody);
    expect(await verifyHmacSignature(raw, hmacSig(raw, secret), secret)).toBe(true);
    // Attacker replays a valid signature against a different body: must fail.
    expect(await verifyHmacSignature(raw + " ", hmacSig(raw, secret), secret)).toBe(false);
    expect(await verifyHmacSignature(raw, "x".repeat(64), secret)).toBe(false);
  });

  it("accepts a genuine Casso bearer token and rejects everything else", () => {
    expect(verifyCassoToken("brl-token", "brl-token")).toBe(true);
    expect(verifyCassoToken("wrong", "brl-token")).toBe(false);
    expect(verifyCassoToken(null, "brl-token")).toBe(false);
    expect(verifyCassoToken("brl-token", "")).toBe(false);
  });

  it("safeEqual is length-guarded and content-constant", () => {
    expect(safeEqual("abcd", "abcd")).toBe(true);
    expect(safeEqual("abcd", "abce")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("accepts official SePay flat payloads and interprets bank dates in Vietnam", () => {
    const event = parseSePay({ id: 92704, transferAmount: 5000000, transferType: "in",
      content: "CAREM GD01001", transactionDate: "2024-07-02 11:08:33",
      accountNumber: "1017588888", gateway: "Vietcombank" });
    expect(event).toMatchObject({ provider_txn_id: "92704", amount: "5000000",
      account_number: "1017588888", transfer_at: "2024-07-02T04:08:33.000Z" });
  });

  it.each([-100, 1.5, "-100", "1.5", "1e6", "cash100", "1,00", "10000000000001", 0, {}, null])(
    "rejects malformed or oversized money instead of changing its value: %s", (amount) => {
      expect(parseSePay({ data: { ...sepayBody.data, amount } })).toBeNull();
    });

  it("rejects unknown direction, invalid dates and overlong transaction identities", () => {
    for (const extra of [{ type: undefined }, { type: "unknown" }, { transferred_at: "bad" },
      { transferred_at: "2026-02-30T08:00:00Z" }, { id: "a".repeat(81) }, { id: {} }]) {
      expect(parseSePay({ data: { ...sepayBody.data, ...extra } })).toBeNull();
    }
  });

  it("rejects expired, future and tampered SePay signatures", async () => {
    const raw = JSON.stringify(sepayBody), secret = "synthetic-key";
    for (const at of [String(Number(timestamp) - 301), String(Number(timestamp) + 301)]) {
      expect(await verifySePaySignature(raw, sepaySig(raw, secret, at), secret, at, Number(timestamp) * 1000)).toBe(false);
    }
    expect(await verifySePaySignature(raw + " ", sepaySig(raw, secret), secret, timestamp)).toBe(false);
    expect(verifySePayApiKey("Apikey synthetic-key", secret)).toBe(true);
    expect(verifySePayApiKey("Bearer synthetic-key", secret)).toBe(false);
    expect(verifySePayApiKey("Apikey wrong", secret)).toBe(false);
  });

  it("parses every Casso V1 transaction and preserves debits as outgoing", () => {
    const data = [{ id: 1, amount: 100, description: "CAREM GD01001", when: "2026-10-11 09:00:00", bank_sub_acc_id: "1234" },
      { id: 2, amount: -200, when: "2026-10-11 09:00:00", bank_sub_acc_id: "1234" }];
    expect(parseCassoEvents({ error: 0, data })).toMatchObject([
      { provider_txn_id: "1", amount: "100", account_number: "1234", direction: "in" },
      { provider_txn_id: "2", amount: "200", direction: "out" },
    ]);
    expect(parseCasso({ error: 0, data })).toBeNull();
    expect(parseCassoEvents({ error: 1, data })).toBeNull();
    expect(parseCassoEvents({ error: 0, data: [...data, null] })).toBeNull();
  });

  it("verifies documented Casso V2 sorted-data SHA512 and supports signed retries", async () => {
    const data = { id: 1, amount: 100, transactionDateTime: "2026-10-11 09:00:00", accountNumber: "1234" };
    const at = "1734924830020", secret = "synthetic-key";
    const sorted = Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key as keyof typeof data]]));
    const signature = "t=" + at + ",v1=" + createHmac("sha512", secret).update(at + "." + JSON.stringify(sorted)).digest("hex");
    expect(await verifyCassoSignature({ error: 0, data }, signature, secret)).toBe(true);
    expect(await verifyCassoSignature({ error: 0, data: { ...data, amount: 101 } }, signature, secret)).toBe(false);
    expect(await verifyCassoSignature({ error: 1, data }, signature, secret)).toBe(false);
    expect(await verifyCassoSignature({ error: 0, data }, signature, "wrong")).toBe(false);
  });
});
