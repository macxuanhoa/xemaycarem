/**
 * The domain rules the pixel locator and the OCR engine cannot infer: which
 * province codes exist, which letters a series may hold, what shapes a
 * Vietnamese motorbike plate compresses to, and what a stamped chassis code
 * is allowed to contain. These tables are the reason a read can be *proved*
 * rather than merely believed.
 */
import { describe, expect, it } from "vitest";
import {
  DIGIT_LIKE_GLYPHS,
  FRAME_WMI,
  PLATE_SERIES_LETTERS,
  PLATE_SHAPES,
  PROVINCE_CODES,
  VIN_FORBIDDEN,
  WEIGHT_AS_IS,
  WEIGHT_DIGIT_TO_LETTER,
  WEIGHT_ILLEGAL_TO_LEGAL,
  WEIGHT_LETTER_TO_DIGIT,
  glyphsConfusable,
  gradeFrame,
  isSeriesLetter,
  provinceWeight,
  slotAlternatives,
} from "../../src/lib/smartcam/local/grammar";

describe("province code table", () => {
  it("accepts the codes in circulation, including the merged 34-province set", () => {
    // Real values from the shop's own inventory plus the post-merger allocation.
    for (const code of ["41", "49", "59", "61", "72", "76", "82", "92", "11", "12", "14", "99"])
      expect(provinceWeight(code), code).toBe(1);
    expect(PROVINCE_CODES.has("50")).toBe(true);
    expect(PROVINCE_CODES.has("58")).toBe(true);
  });
  it("rejects codes that were never issued to a motorbike", () => {
    // The old pipeline accepted anything from 11 to 99, so `13` and `44`
    // could be reported as a confident plate that cannot exist.
    for (const code of ["13", "42", "44", "45", "46", "00", "10", "99X"])
      expect(provinceWeight(code), code).toBe(0);
  });
  it("keeps agency and transitional codes as leads, never as locks", () => {
    for (const code of ["80", "87", "91", "96"]) {
      expect(provinceWeight(code), code).toBeGreaterThan(0);
      expect(provinceWeight(code), code).toBeLessThan(1);
    }
  });
});

describe("series letter pool", () => {
  it("holds exactly the 20 regulated letters", () => {
    expect([...PLATE_SERIES_LETTERS].sort().join("")).toBe(
      "ABCDEFGHKLMNPSTUVXYZ",
    );
  });
  it("excludes the letters regulation never issues", () => {
    // This is the strongest veto available: an OCR `O` in a series slot is
    // proof of a misread rather than a rare letter.
    for (const letter of ["I", "O", "Q", "R", "W", "J"])
      expect(isSeriesLetter(letter), letter).toBe(false);
    for (const letter of ["S", "B", "Z", "L", "T", "N"])
      expect(isSeriesLetter(letter), letter).toBe(true);
  });
});

describe("plate shapes", () => {
  it("covers the four compact lengths a real plate compresses to", () => {
    expect(PLATE_SHAPES.map((shape) => [shape.id, shape.slots.length])).toEqual([
      ["modern", 9],
      ["series", 9],
      ["legacy4", 8],
      ["legacy6", 10],
    ]);
  });
  it("lists the two-letter modern layout first so it wins an equal read", () => {
    expect(PLATE_SHAPES[0].id).toBe("modern");
    expect(PLATE_SHAPES[0].slots.filter((slot) => slot === "letter")).toHaveLength(2);
  });
});

describe("slot alternatives", () => {
  it("keeps a legal glyph as-is and offers no cheaper alternative", () => {
    expect(slotAlternatives("province", "5")).toEqual([
      { char: "5", weight: WEIGHT_AS_IS },
    ]);
    expect(slotAlternatives("letter", "S")).toEqual([
      { char: "S", weight: WEIGHT_AS_IS },
    ]);
  });
  it("prices a letter-read-as-digit above its reverse", () => {
    expect(slotAlternatives("digit", "S")).toEqual([
      { char: "5", weight: WEIGHT_LETTER_TO_DIGIT },
    ]);
    expect(slotAlternatives("letter", "5")).toEqual([
      { char: "S", weight: WEIGHT_DIGIT_TO_LETTER },
    ]);
    expect(WEIGHT_LETTER_TO_DIGIT).toBeGreaterThan(WEIGHT_DIGIT_TO_LETTER);
  });
  it("treats an illegal letter in a series slot as the weakest reading", () => {
    const options = slotAlternatives("letter", "I");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(isSeriesLetter(option.char)).toBe(true);
      expect(option.weight).toBe(WEIGHT_ILLEGAL_TO_LEGAL);
      expect(option.weight).toBeLessThan(WEIGHT_LETTER_TO_DIGIT);
    }
  });
  it("offers nothing for a glyph no slot can justify", () => {
    expect(slotAlternatives("digit", "E")).toEqual([]);
    expect(slotAlternatives("province", "B")).toEqual([{ char: "8", weight: WEIGHT_LETTER_TO_DIGIT }]);
    expect(slotAlternatives("digit", "%")).toEqual([]);
  });
  it("exposes every digit-slot lookalike to the lexical window finder", () => {
    // The pattern in candidates.ts is built from this string, so a `T` or `G`
    // misread in a serial position cannot silently cost recall.
    for (const glyph of "0123456789OSILTZSRGBQ")
      expect(DIGIT_LIKE_GLYPHS.includes(glyph), glyph).toBe(true);
  });
});

describe("chassis stamp rules", () => {
  it("forbids the letters a VIN cannot contain", () => {
    expect(VIN_FORBIDDEN.test("RLH16OKD12345")).toBe(true);
    expect(gradeFrame("RLH16OKD12345").valid).toBe(false);
    expect(gradeFrame("RLH160KD12345").valid).toBe(true);
  });
  it("requires a 17-character VIN to carry a legal model-year glyph", () => {
    expect(gradeFrame("RLH160KD12345ABCD").yearPositionValid).toBe(true);
    expect(gradeFrame("RLH160KD1U345ABCD").valid).toBe(false);
  });
  it("recognises a maker prefix and a domestic short stamp", () => {
    expect(FRAME_WMI.test("RLH")).toBe(true);
    expect(FRAME_WMI.test("VF1")).toBe(true);
    expect(gradeFrame("JA29E1234567").shortStamp).toBe(true);
    expect(gradeFrame("JA29E1234567").knownWmi).toBe(false);
    // A labelled stamp needs no known prefix to be believed.
    expect(gradeFrame("AB12C123456", true).valid).toBe(true);
    expect(gradeFrame("AB12C123456").weight).toBeLessThan(
      gradeFrame("AB12C123456", true).weight,
    );
  });
  it("mirrors the storage contract the server enforces", () => {
    expect(gradeFrame("12345678901").valid).toBe(false); // no letter
    expect(gradeFrame("ABCDEFGHIJKLM").valid).toBe(false); // no digit
    expect(gradeFrame("GEN3F2A1B9C8D7E").valid).toBe(false); // server placeholder
    expect(gradeFrame("RLH160KD12345").weight).toBeGreaterThan(0.6);
  });
  it("rewards the digit tail the duplicate signature is taken from", () => {
    expect(gradeFrame("RLH160KD12345").digitTail).toBe(true);
    expect(gradeFrame("RLH160KD1234X").digitTail).toBe(false);
  });
});

describe("confusable glyph pairs", () => {
  it("accepts the classic confusions and refuses unrelated swaps", () => {
    expect(glyphsConfusable("S", "5")).toBe(true);
    expect(glyphsConfusable("5", "S")).toBe(true);
    expect(glyphsConfusable("O", "0")).toBe(true);
    expect(glyphsConfusable("I", "1")).toBe(true);
    expect(glyphsConfusable("A", "B")).toBe(false);
    expect(glyphsConfusable("3", "8")).toBe(false);
    expect(glyphsConfusable("6", "6")).toBe(true);
  });
});
