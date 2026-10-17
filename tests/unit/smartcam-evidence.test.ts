/**
 * The decision layer: per-character evidence across frames, the AUTO/CONFIRM
 * tier it feeds, and the inventory suggestion that may only ever be accepted by
 * a person. Together these are what turns "the camera is usually right" into
 * "the camera is never silently wrong".
 */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LIMITS,
  pushEvidence,
  readEvidence,
  type Reading,
} from "../../src/lib/smartcam/local/voting";
import {
  decisionTier,
  normalizeScanRisks,
  parseRecognition,
  type Recognition,
  type ScannedFields,
  type VehicleMatch,
} from "../../src/lib/smartcam/recognition";
import {
  rankNearMatches,
  searchToken,
} from "../../src/lib/smartcam/inventoryPrior";

const read = (value: string, over: Partial<Reading> = {}): Reading => ({
  value,
  compact: value.replace(/[^A-Z0-9]/g, ""),
  confidence: 90,
  autoEligible: true,
  ...over,
});

describe("per-character evidence", () => {
  it("settles on agreement rather than on a single confident guess", () => {
    let evidence = pushEvidence(null, read("59B1-234.56"));
    expect(readEvidence(evidence).settled).toBe(false);
    evidence = pushEvidence(evidence, read("59B1-234.56"));
    const outcome = readEvidence(evidence);
    expect(outcome.settled).toBe(true);
    expect(outcome.autoEligible).toBe(true);
    expect(outcome.agreement).toBe(1);
  });
  it("a wobbling glyph is evidence, not a reset", () => {
    let evidence = pushEvidence(null, read("59B1-234.56"));
    evidence = pushEvidence(evidence, read("59B1-234.56"));
    evidence = pushEvidence(evidence, read("59B1-234.57", { confidence: 70 }));
    const outcome = readEvidence(evidence);
    // The old vote keyed on the whole string: this sequence would have been
    // thrown back to one frame and the read would have flickered on screen.
    expect(outcome.value).toBe("59B1-234.56");
    expect(outcome.agreement).toBeCloseTo(2 / 3);
    expect(outcome.settled).toBe(true);
    expect(outcome.alternatives).toEqual(["59B1-234.57"]);
  });
  it("an even split becomes a disputed position instead of a coin flip", () => {
    let evidence = pushEvidence(null, read("59B1-234.56", { confidence: 99 }));
    evidence = pushEvidence(evidence, read("59B1-234.57", { confidence: 99 }));
    const outcome = readEvidence(evidence);
    expect(outcome.settled).toBe(false);
    expect(outcome.autoEligible).toBe(false);
    // Compact position of the last serial digit, not a display index.
    expect(outcome.disputed).toEqual([8]);
  });
  it("carries a substituted position forward as disputed", () => {
    let evidence = pushEvidence(
      null,
      read("59B1-234.56", { disputed: [7], autoEligible: false }),
    );
    evidence = pushEvidence(
      evidence,
      read("59B1-234.56", { disputed: [7], autoEligible: false }),
    );
    const outcome = readEvidence(evidence);
    expect(outcome.settled).toBe(true);
    expect(outcome.disputed).toEqual([7]);
    // Agreed, but never proven — the human decides this one.
    expect(outcome.autoEligible).toBe(false);
  });
  it("needs every agreeing frame to be clean before it locks", () => {
    let evidence = pushEvidence(null, read("59B1-234.56"));
    evidence = pushEvidence(
      evidence,
      read("59B1-234.56", { autoEligible: false, disputed: [2] }),
    );
    expect(readEvidence(evidence).autoEligible).toBe(false);
  });
  it("a frame that read nothing drops the evidence (the scene moved on)", () => {
    const half = pushEvidence(null, read("59B1-234.56"));
    expect(pushEvidence(half, null)).toBeNull();
    expect(pushEvidence(half, read(""))).toBeNull();
    expect(readEvidence(null).settled).toBe(false);
  });
  it("keeps the settle bar reachable by two of three frames", () => {
    // 2/3 is the intent of minAgreement, so the threshold must sit below it.
    expect(2 / 3).toBeGreaterThanOrEqual(EVIDENCE_LIMITS.minAgreement);
    expect(EVIDENCE_LIMITS.autoAgreement).toBeGreaterThan(
      EVIDENCE_LIMITS.minAgreement,
    );
    expect(EVIDENCE_LIMITS.requiredFrames).toBe(2);
  });
});

describe("decision tier", () => {
  const fields = (over: Partial<ScannedFields> = {}): ScannedFields => ({
    license_plate: "59B1-234.56",
    frame_number: "",
    ...over,
  });
  const both = { license_plate: true, frame_number: true };
  const none = { license_plate: false, frame_number: false };
  const unknown = { state: "none" } as VehicleMatch;
  const stock = (license_plate: string, frame_number = ""): VehicleMatch => ({
    state: "unique",
    vehicle: {
      id: "v-1",
      internal_code: "XE-1",
      license_plate,
      frame_number,
      vehicle_type: "Xe số",
      status: "IN_STOCK",
    },
  });
  it("locks only a clean, evidenced identifier", () => {
    expect(decisionTier(fields(), {}, both, unknown)).toBe("AUTO");
    expect(decisionTier(fields(), { license_plate: [3] }, both, unknown)).toBe(
      "CONFIRM",
    );
    expect(
      decisionTier(fields(), {}, { license_plate: false, frame_number: true }, unknown),
    ).toBe("CONFIRM");
  });
  it("lets an exact stored record stand in for per-frame evidence", () => {
    // A gallery photo or a paid read has no frame vote, but nine glyphs landing
    // exactly on one bike in the shop's own database is proof of its own kind.
    expect(decisionTier(fields(), {}, none, stock("59B1-234.56"))).toBe("AUTO");
    expect(decisionTier(fields(), {}, none, stock("59-B1 234.56"))).toBe("AUTO");
  });
  it("does not let a near match count as corroboration", () => {
    expect(decisionTier(fields(), {}, none, stock("59B1-234.58"))).toBe("CONFIRM");
  });
  it("a risk mark vetoes even a corroborated read", () => {
    expect(
      decisionTier(fields(), { license_plate: [8] }, none, stock("59B1-234.56")),
    ).toBe("CONFIRM");
  });
  it("requires every identifier it read to be corroborated", () => {
    const bothRead = fields({ frame_number: "RLH160KD12345" });
    expect(
      decisionTier(bothRead, {}, none, stock("59B1-234.56", "RLH160KD12345")),
    ).toBe("AUTO");
    expect(
      decisionTier(bothRead, {}, none, stock("59B1-234.56", "RLH160KD12346")),
    ).toBe("CONFIRM");
  });
  it("ignores a field the read never produced", () => {
    expect(
      decisionTier(
        fields({ frame_number: "" }),
        {},
        { license_plate: true, frame_number: false },
        unknown,
      ),
    ).toBe("AUTO");
  });
  it("never locks when nothing was read at all", () => {
    expect(
      decisionTier({ license_plate: "", frame_number: "" }, {}, both, unknown),
    ).toBe("CONFIRM");
  });
  it("an engine-supplied risk mark blocks the lock through the draft path", () => {
    const draft = {
      license_plate: "59B1-234.56",
      uncertain_characters: { license_plate: [8], frame_number: [] },
    };
    const fieldsRead = { license_plate: "59B1-234.56", frame_number: "" };
    const risks = normalizeScanRisks(draft, fieldsRead);
    expect(decisionTier(fieldsRead, risks, both, unknown)).toBe("CONFIRM");
  });
});

describe("recognition draft keeps its tier honest", () => {
  const base = {
    version: 1 as const,
    scannedAt: new Date().toISOString(),
    fields: { license_plate: "59B1-234.56", frame_number: "" },
    statuses: { license_plate: "SUGGESTED" as const, frame_number: "UNREADABLE" as const },
    match: { state: "none" as const },
    photos: [],
  };
  it("carries an explicit AUTO through the storage boundary", () => {
    expect(parseRecognition({ ...base, tier: "AUTO" })?.tier).toBe("AUTO");
  });
  it("treats a missing or junk tier as CONFIRM", () => {
    expect(parseRecognition(base)?.tier).toBeUndefined();
    expect(parseRecognition({ ...base, tier: "GUESS" })?.tier).toBeUndefined();
  });
  it("demotes a stored AUTO that now carries an unresolved character", () => {
    const demoted = parseRecognition({
      ...base,
      tier: "AUTO",
      riskCharacters: { license_plate: [8] },
    });
    expect(demoted?.tier).toBe("CONFIRM");
  });
  it("bounds the runner-up list it is willing to re-show", () => {
    const parsed: Recognition | null = parseRecognition({
      ...base,
      alternatives: { license_plate: ["59B1-234.58", "59B1-234.50", 42, ""] },
    });
    expect(parsed?.alternatives?.license_plate).toEqual(["59B1-234.58", "59B1-234.50"]);
  });
});

describe("inventory prior is a suggestion, not a correction", () => {
  const rows = [
    { id: "a", internal_code: "XE-001", license_plate: "59B1-234.56", frame_number: "RLH160KD12345", vehicle_type: "Xe tay ga", status: "IN_STOCK" },
    { id: "b", internal_code: "XE-002", license_plate: "59B1-234.99", frame_number: "", vehicle_type: "", status: "IN_STOCK" },
  ] as never[];
  it("searches the trusted prefix of a plate, keeping its punctuation", () => {
    expect(searchToken("license_plate", "59B1-234.5S", [7])).toBe("59B1-234");
    expect(searchToken("license_plate", "59B1-234.56", [])).toBe("59B1-234.56");
  });
  it("searches the trusted tail of a stamp, whose stored dashes vary", () => {
    expect(searchToken("frame_number", "RLH160KD1234S", [12])).toBe("RLH160KD1234");
  });
  it("offers only a one-glyph difference at a position the read flagged", () => {
    const matches = rankNearMatches("license_plate", "59B1-234.S6", [7], rows);
    expect(matches).toHaveLength(1);
    expect(matches[0].vehicle.id).toBe("a");
    expect(matches[0].position).toBe(7);
    expect(matches[0].readGlyph).toBe("S");
    expect(matches[0].storedGlyph).toBe("5");
    expect(matches[0].matched).toBe(8);
    expect(matches[0].total).toBe(9);
  });
  it("refuses a difference at a position the camera claimed to be sure about", () => {
    expect(rankNearMatches("license_plate", "59B1-234.S6", [], rows)).toEqual([]);
    expect(rankNearMatches("license_plate", "59B1-234.S6", [3], rows)).toEqual([]);
  });
  it("refuses a non-confusable difference and an exact duplicate", () => {
    // `99` against `56` differs twice and is simply another bike.
    expect(rankNearMatches("license_plate", "59B1-234.5S", [7], [rows[1]] as never)).toEqual([]);
    expect(rankNearMatches("license_plate", "59B1-234.56", [8], rows)).toEqual([]);
  });
  it("matches on the compact form so stored separators cannot hide a record", () => {
    const dashed = [
      { id: "c", internal_code: "XE-003", license_plate: "59-B1 234.56", frame_number: "RLH-160KD12345", vehicle_type: "", status: "IN_STOCK" },
    ] as never[];
    expect(rankNearMatches("license_plate", "59B1-234.S6", [7], dashed)).toHaveLength(1);
  });
});
