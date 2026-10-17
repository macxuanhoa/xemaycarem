/**
 * Grammar-constrained decoding: readings are ranked against the domain rules
 * instead of being folded in one direction. The behaviour that matters here is
 * not only "which string won" but "what the code is willing to do without a
 * human" — a silent substitution at full confidence is exactly the defect this
 * layer replaces.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_GLYPH_CONFIDENCE,
  AUTO_MARGIN,
  autoLockEligible,
  decodeFrame,
  decodePlate,
  decodePlateRun,
  marginOf,
} from "../../src/lib/smartcam/local/decoder";
import {
  chooseIdentifierRead,
  type OcrPass,
} from "../../src/lib/smartcam/local/ocr";
import {
  parsePlateCandidates,
  uniqueCandidate,
} from "../../src/lib/smartcam/local/candidates";

const pass = (text: string, confidence = 92): OcrPass => ({
  text,
  confidence,
  ms: 20,
});

describe("plate decoding", () => {
  it("locks a clean read with no rival and no substituted glyph", () => {
    const decoded = decodePlateRun("59-B1 234.56", 90);
    expect(decoded.top?.value).toBe("59B1-234.56");
    expect(decoded.top?.disputed).toEqual([]);
    expect(decoded.margin).toBeGreaterThanOrEqual(AUTO_MARGIN);
    expect(autoLockEligible(decoded)).toBe(true);
  });
  it("rescues a misread glyph but reports the position it had to change", () => {
    const decoded = decodePlateRun("S9-BI 234.S6", 95);
    expect(decoded.top?.value).toBe("59B1-234.56");
    expect(decoded.top?.disputed).toEqual([0, 3, 7]);
    // The old code reported this at a discounted confidence and called it done.
    expect(autoLockEligible(decoded)).toBe(false);
  });
  it("prefers the classic I-read-as-1 over inventing a second series letter", () => {
    const ranked = decodePlate("59-BI 234.56", 90);
    expect(ranked[0].value).toBe("59B1-234.56");
    expect(ranked.map((item) => item.value)).toContain("59BL2-3456");
    expect(ranked[0].weight).toBeGreaterThan(ranked[1].weight);
    expect(marginOf(ranked)).toBeLessThan(AUTO_MARGIN);
  });
  it("refuses a province code that was never issued", () => {
    expect(decodePlateRun("13-B1 234.56", 95).top).toBeNull();
    expect(decodePlateRun("00-A1 123.45", 95).top).toBeNull();
    expect(parsePlateCandidates("13-B1 234.56", 95)).toEqual([]);
  });
  it("keeps an agency code as a lead only", () => {
    const decoded = decodePlateRun("80-A3 999.99", 95);
    expect(decoded.top?.value).toBe("80A3-999.99");
    expect(decoded.top?.autoEligible).toBe(true);
    expect(decoded.top?.confidence).toBeLessThan(95);
  });
  it("reads the two-letter layout introduced on 15/08/2023", () => {
    const decoded = decodePlateRun("59-XA 123.45", 90);
    expect(decoded.top?.compact).toBe("59XA12345");
    expect(decoded.top?.shape).toBe("modern");
    // Canonical display still follows plate.ts; the P4 fix changes both at once.
    expect(decoded.top?.value).toBe("59XA1-2345");
    expect(autoLockEligible(decoded)).toBe(true);
  });
  it("keeps the legacy serial lengths readable", () => {
    expect(decodePlateRun("29-B1-1234", 90).top?.value).toBe("29B1-1234");
    expect(decodePlateRun("92-D1-728282", 90).top?.value).toBe("92D1-728282");
  });
  it("uses per-glyph confidence instead of the whole-line average", () => {
    const glyphs = [..."59B123456"].map((character, index) => ({
      character,
      confidence: index === 8 ? 30 : 96,
    }));
    const decoded = decodePlateRun("59B123456", 96, glyphs);
    expect(decoded.top?.value).toBe("59B1-234.56");
    expect(decoded.top?.minGlyphConfidence).toBe(30);
    expect(decoded.top?.confidence).toBeLessThan(96);
    expect(autoLockEligible(decoded)).toBe(false);
  });
  it("ignores a glyph run that cannot be a plate at all", () => {
    expect(decodePlateRun("ABCDEFG", 95).top).toBeNull();
    expect(decodePlateRun("12345678", 95).top).toBeNull();
  });
});

describe("chassis decoding", () => {
  it("treats an ISO-illegal glyph as proof of a misread, not a letter", () => {
    const read = decodeFrame("RLH16OKD12345");
    expect(read?.compact).toBe("RLH160KD12345");
    expect(read?.disputed).toEqual([5]);
    // The digit reading wins, but the position stays a human's decision.
    expect(read?.autoEligible).toBe(false);
  });
  it("accepts a clean maker-prefix stamp for an auto-lock", () => {
    const read = decodeFrame("RLH160KD12345");
    expect(read?.verdict.valid).toBe(true);
    expect(read?.disputed).toEqual([]);
    expect(read?.autoEligible).toBe(true);
  });
  it("keeps a plausible but ungraded stamp readable without locking it", () => {
    const read = decodeFrame("R1H54XAB712345");
    expect(read?.compact).toBe("R1H54XAB712345");
    expect(read?.verdict.knownWmi).toBe(false);
    expect(read?.autoEligible).toBe(!!read?.verdict.valid && read.verdict.weight >= 0.6);
  });
  it("refuses anything shorter than the storage contract allows", () => {
    expect(decodeFrame("KF30E74123")).toBeNull();
    expect(decodeFrame("RLH160KD12345")?.compact.startsWith("R")).toBe(true);
  });
});

describe("read merging keeps the conservative verdict", () => {
  it("keeps an auto-lock only while every agreeing pass earns one", () => {
    const clean = chooseIdentifierRead([pass("59-B1 234.56"), pass("59B123456")]);
    expect(clean.license_plate).toBe("59B1-234.56");
    expect(clean.autoEligible.license_plate).toBe(true);
    expect(clean.warnings.license_plate).toEqual([]);
    // One pass had to substitute a glyph: the field is agreed, not proven.
    const folded = chooseIdentifierRead([
      pass("59-B1 234.56"),
      pass("59-BI 234.56"),
    ]);
    expect(folded.license_plate).toBe("59B1-234.56");
    expect(folded.autoEligible.license_plate).toBe(false);
    expect(folded.warnings.license_plate).toContain(3);
  });
  it("reports the runner-up so the confirm strip has something to offer", () => {
    const read = chooseIdentifierRead([pass("59-BI 234.56")]);
    expect(read.alternatives.license_plate.length).toBeGreaterThan(0);
  });
  it("still refuses two different identifiers in one photo", () => {
    const read = chooseIdentifierRead([pass("59-B1 234.56\n61-A1 777.77")]);
    expect(read.license_plate).toBe("");
    expect(read.ambiguous).toEqual(["license_plate"]);
    expect(read.autoEligible.license_plate).toBe(false);
  });
  it("merges agreement across passes with the weaker margin", () => {
    const candidates = parsePlateCandidates("59-BI 234.56", 90);
    const merged = uniqueCandidate([...candidates, ...candidates]);
    expect(merged?.value).toBe("59B1-234.56");
    expect(merged?.margin).toBe(candidates[0].margin);
    expect(merged?.autoEligible).toBe(false);
  });
  it("never auto-locks a glyph the engine itself was unsure about", () => {
    expect(AUTO_GLYPH_CONFIDENCE).toBeGreaterThan(70);
    const read = chooseIdentifierRead([
      {
        ...pass("59-B1 234.56"),
        glyphs: [..."59B123456"].map((character) => ({
          character,
          confidence: 75,
        })),
      },
    ]);
    expect(read.license_plate).toBe("59B1-234.56");
    expect(read.autoEligible.license_plate).toBe(false);
  });
});
