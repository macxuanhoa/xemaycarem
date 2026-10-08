/**
 * Local smart-camera pipeline logic: OCR-text candidate parsing (the exact
 * glyph confusions a real plate/stamp produces), stable-frame voting,
 * adaptive sampling, the paid-cloud budget ledger, and the transaction-id
 * correlation that replaced substring vehicle lookups.
 */
import { describe, expect, it } from "vitest";
import {
  bestCandidate,
  candidatesFromOcr,
  parseFrameCandidates,
  parsePlateCandidates,
} from "../../src/lib/smartcam/local/candidates";
import { nextTickMs, pushVote, shouldDecodeCodes } from "../../src/lib/smartcam/local/voting";
import { cloudAllowed, DEFAULT_BUDGET, recordCall, summarize, type CloudCall } from "../../src/lib/smartcam/local/budget";
import { alignCreatedIds, hasTrustedIds } from "../../src/lib/smartcam/correlate";

describe("plate OCR candidate parsing", () => {
  it("accepts raw, dashed and glued plate renderings with the validator as gate", () => {
    expect(parsePlateCandidates("59-B1 234.56", 90).map((c) => c.value)).toContain("59-B1 234.56");
    expect(parsePlateCandidates("59B123456", 90).map((c) => c.value)).toContain("59-B1 234.56");
    expect(parsePlateCandidates("59-A1\n234.56", 90).map((c) => c.value)).toContain("59-A1 234.56");
    expect(parsePlateCandidates("29-B1 \n 1234", 90).map((c) => c.value)).toContain("29-B1 1234");
    expect(parsePlateCandidates("43-C1\r\n888.88", 90).map((c) => c.value)).toContain("43-C1 888.88");
    expect(parsePlateCandidates("bien so 30-D2 888.88 trong khung", 80).map((c) => c.value)).toContain("30-D2 888.88");
  });
  it("rescues glyph confusions but discounts their confidence", () => {
    const clean = parsePlateCandidates("59-B1 234.56", 90);
    const confused = parsePlateCandidates("59-BI 234.56", 90);
    expect(confused.map((c) => c.value)).toContain("59-B1 234.56");
    expect(bestCandidate(confused)!.confidence).toBeLessThanOrEqual(90);
    expect(bestCandidate(clean)!.confidence).toBe(90);
  });
  it("rejects non-plates instead of guessing", () => {
    expect(parsePlateCandidates("12345", 95)).toEqual([]);
    expect(parsePlateCandidates("ABC DEF", 95)).toEqual([]);
    // 00–10 prefixes were never issued for civilian plates — must not invent.
    expect(parsePlateCandidates("00-A1 123.45", 95)).toEqual([]);
    expect(parsePlateCandidates("10-B2 345.67", 95)).toEqual([]);
  });
  it("accepts legacy and special province codes plate.ts deems canonical", () => {
    // 11/12/14/15–20 are real current-or-legacy prefixes; 80 is government-
    // bound machinery plates; the camera layer only mirrors canonical rules.
    for (const plate of ["11-B5 123.45", "12-A2 345.67", "14-D1 555.55", "17-A3 111.11", "19-B1 222.33", "20-C2 444.55", "80-A3 999.99", "99-P1 123.45"]) {
      expect(parsePlateCandidates(plate, 90).map((c) => c.value), plate).toContain(plate);
    }
  });
});

describe("frame OCR candidate parsing", () => {
  it("finds VIN-like frame codes across separators", () => {
    expect(parseFrameCandidates("khung RLH160KD12345", 88).map((c) => c.value)).toContain("RLH160KD12345");
    expect(parseFrameCandidates("R1H5-4XAB7-12345", 80).map((c) => c.value)).toContain("R1H54XAB712345");
  });
  it("does not mistake a bare plate serial for a frame", () => {
    expect(parseFrameCandidates("59B123456", 90)).toEqual([]);
  });
  it("rejects short engine-style codes: nothing under 11 chars is a frame", () => {
    // Số máy đã bị xoá khỏi hồ sơ xe (08/10/2026) nên bộ đọc tại máy không còn
    // nhánh nào cho nó; mã kiểu KF30E chỉ được coi là khung khi đủ dài.
    expect(parseFrameCandidates("KF30E-74123", 90)).toEqual([]);
    expect(parseFrameCandidates("E3T123456", 90)).toEqual([]);
    expect(parseFrameCandidates("KF30E-7412345", 90).map((c) => c.value)).toContain("KF30E7412345");
  });
  it("hands the OCR layer exactly two fields: plate and frame", () => {
    const draft = candidatesFromOcr("bien so 59-B1 234.56 khung RLH160KD12345", 90);
    // Không còn khoá nào thuộc nhóm trường đã bị xoá vĩnh viễn.
    expect(Object.keys(draft).sort()).toEqual(["frame_number", "license_plate"]);
    expect(draft.license_plate).toBe("59-B1 234.56");
  });
});

describe("stable-frame voting and adaptive sampling", () => {
  it("only settles after repeated identical reads with enough confidence", () => {
    let outcome = pushVote(null, "59-B1 234.56", 90);
    expect(outcome.settled).toBe(false);
    outcome = pushVote(outcome.state, "59-B1 234.56", 85);
    expect(outcome.settled).toBe(true);
    expect(outcome.confidence).toBeCloseTo(87.5);
  });
  it("a high-confidence one-off guess never fires, a changed read restarts", () => {
    let outcome = pushVote(null, "59-B1 234.56", 99);
    expect(outcome.settled).toBe(false);
    outcome = pushVote(outcome.state, "59-B1 234.57", 99);
    expect(outcome.state?.count).toBe(1);
    expect(outcome.settled).toBe(false);
  });
  it("low-confidence streaks do not settle even when repeated", () => {
    let outcome = pushVote(null, "61-B1 777.77", 40);
    outcome = pushVote(outcome.state, "61-B1 777.77", 40);
    expect(outcome.settled).toBe(false);
  });
  it("an unreadable tick resets the streak (scene moved on)", () => {
    const half = pushVote(null, "59-B1 234.56", 90);
    const reset = pushVote(half.state, "", 0);
    expect(reset.state).toBeNull();
    expect(reset.settled).toBe(false);
  });
  it("sampling backs off on misses and speeds up while a pass is in flight", () => {
    expect(nextTickMs({ busy: true, missStreak: 0, sharp: true })).toBeLessThan(400);
    expect(nextTickMs({ busy: false, missStreak: 0, sharp: true })).toBeLessThanOrEqual(800);
    const starved = nextTickMs({ busy: false, missStreak: 12, sharp: true });
    expect(starved).toBeGreaterThan(nextTickMs({ busy: false, missStreak: 1, sharp: true }));
    expect(starved).toBeLessThanOrEqual(2400);
  });
  it("barcode decoding runs on a slower cadence than the loop", () => {
    expect(shouldDecodeCodes(0)).toBe(true);
    expect(shouldDecodeCodes(1)).toBe(false);
    expect(shouldDecodeCodes(2)).toBe(true);
  });
});

describe("cloud budget ledger", () => {
  const call = (over: Partial<CloudCall> = {}): CloudCall => ({
    ts: Date.now(),
    targetKey: "vehicle:abc",
    latencyMs: 900,
    imageBytes: 120_000,
    outcome: "ok",
    ...over,
  });
  it("allows the first call for a target and blocks repeats within the hour", () => {
    const now = Date.now();
    expect(cloudAllowed([], now, "vehicle:abc", DEFAULT_BUDGET)).toEqual({ ok: true });
    const denied = cloudAllowed([call({ ts: now - 1000 })], now, "vehicle:abc");
    expect(denied.ok === false ? denied.reason : null).toBe("TARGET_LIMIT");
    expect(cloudAllowed([call({ ts: now - 1000 })], now, "vehicle:other").ok).toBe(true);
  });
  it("enforces the hourly cap across all targets and forgets old calls", () => {
    const now = Date.now();
    const many = Array.from({ length: DEFAULT_BUDGET.perHour }, (_, i) => call({ ts: now - i * 1000, targetKey: `t${i}` }));
    const capped = cloudAllowed(many, now, "new-target");
    expect(capped.ok === false ? capped.reason : null).toBe("HOURLY_LIMIT");
    const stale = many.map((row) => ({ ...row, ts: now - 3_600_001 }));
    expect(cloudAllowed(stale, now, "new-target").ok).toBe(true);
  });
  it("records calls, caps the ledger size and summarizes usage", () => {
    let ledger: CloudCall[] = [];
    for (let i = 0; i < 400; i++) ledger = recordCall(ledger, call({ ts: Date.now() - 10, imageBytes: 1000 }));
    expect(ledger).toHaveLength(300);
    const summary = summarize(ledger, Date.now());
    expect(summary.callsToday).toBe(300);
    expect(summary.bytesToday).toBe(300_000);
  });
});

describe("created-vehicle id correlation", () => {
  const idA = "44444444-4444-4444-8444-444444444444";
  const idB = "55555555-5555-4555-8555-555555555555";
  it("trusts a full well-formed id list aligned by row order", () => {
    const aligned = alignCreatedIds(2, [idA, idB]);
    expect(aligned).toEqual([idA, idB]);
    expect(hasTrustedIds(aligned)).toBe(true);
  });
  it("treats a misaligned or malformed list as absent — never a partial guess", () => {
    expect(alignCreatedIds(2, [idA])).toEqual([null, null]);
    expect(alignCreatedIds(1, ["not-a-uuid"])).toEqual([null]);
    expect(alignCreatedIds(1, null)).toEqual([null]);
    // A non-v4 uuid is as untrusted as junk.
    expect(alignCreatedIds(1, ["44444444-4444-1444-8444-444444444444"])).toEqual([null]);
    expect(hasTrustedIds([idA, null])).toBe(false);
  });
});
