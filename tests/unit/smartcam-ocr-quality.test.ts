import { describe, expect, it } from "vitest";
import { candidatesFromOcr, parseFrameCandidates, parsePlateCandidates } from "../../src/lib/smartcam/local/candidates";
import { chooseIdentifierRead, type OcrPass } from "../../src/lib/smartcam/local/ocr";
import { parseIdentityDocumentQr, parseIdentityDocumentText } from "../../src/lib/smartcam/local/identity";
import { toGray } from "../../src/lib/smartcam/local/frames";

const pass = (text: string, confidence = 92): OcrPass => ({ text, confidence, ms: 20 });

it("skips an empty QR crop without attempting invalid pixel reads", () => {
  const canvas = { width: 1, height: 0, getContext: () => { throw new Error("must not read an empty image"); } } as unknown as HTMLCanvasElement;
  expect(toGray(canvas)).toBeNull();
});

describe("focused identifier extraction", () => {
  it("extracts the actual stamp without joining brand, plate and hotline text", () => {
    const text = "HONDA 2020\nBiển số: 59-B1 234.56\nHOTLINE 0901234567\nSố khung: RLH160KD12345\nAC2026GREEN";
    expect(parseFrameCandidates(text, 90).map((candidate) => candidate.value)).toEqual(["RLH160KD12345"]);
    expect(candidatesFromOcr(text, 90)).toEqual({ license_plate: "59B1-234.56", frame_number: "RLH160KD12345" });
  });

  it("rejects arbitrary page text and an overlong token instead of inventing a suffix", () => {
    for (const text of ["HONDA 2020 BIEN SO 59 B1 23456", "PARKING2WHEEL2025", "RLH123456789012345678901", "DATE20261009", "AC2026GREEN"]) {
      expect(parseFrameCandidates(text, 95), text).toEqual([]);
    }
  });

  it("joins spaced stamp glyphs with a frame label or a known maker prefix", () => {
    expect(parseFrameCandidates("Số khung: RLH 160 KD 12345\nNăm 2023", 90).map((candidate) => candidate.value)).toEqual(["RLH160KD12345"]);
    expect(parseFrameCandidates("RLH 160 KD 12345", 90).map((candidate) => candidate.value)).toEqual(["RLH160KD12345"]);
    expect(parseFrameCandidates("HONDA RLH 160 KD 12345", 90)).toEqual([]);
    expect(parseFrameCandidates("Số khung RLH160KD12345 2023", 90).map((candidate) => candidate.value)).toEqual(["RLH160KD12345"]);
  });

  it("does not read an embedded plate inside another identifier", () => {
    expect(parsePlateCandidates("RLH59B123456XYZ", 90)).toEqual([]);
    expect(parsePlateCandidates("12359B123456", 90)).toEqual([]);
  });

  it("keeps corrected numeric glyph positions for red highlighting", () => {
    const candidate = parsePlateCandidates("S9-BI 234.S6", 95)[0];
    expect(candidate.value).toBe("59B1-234.56");
    expect(candidate.uncertainCharacters).toEqual([0, 3, 7]);
    expect(candidate.confidence).toBeLessThan(95);
  });
});

describe("photo ambiguity and symbol confidence", () => {
  it("ignores a glyph-clipped crop instead of treating a damaged read as a second object", () => {
    const read = chooseIdentifierRead([{ ...pass("11A1-494.90", 2), clipped: true }, pass("59A1-234.56", 83)]);
    expect(read.license_plate).toBe("59A1-234.56");
    expect(read.ambiguous).toEqual([]);
    expect(chooseIdentifierRead([pass("11A1-494.90"), pass("59A1-234.56")]).license_plate).toBe("");
  });

  it("refuses a whole photo containing two plates even when the crop found one first", () => {
    const read = chooseIdentifierRead([pass("59-B1 234.56"), pass("59-B1 234.56\n61-A1 777.77")]);
    expect(read.license_plate).toBe("");
    expect(read.ambiguous).toEqual(["license_plate"]);
  });

  it("refuses two competing frame stamps instead of choosing whichever is first", () => {
    const read = chooseIdentifierRead([pass("RLH160KD12345\nRLC160KD54321")]);
    expect(read.frame_number).toBe("");
    expect(read.ambiguous).toEqual(["frame_number"]);
  });

  it("accepts agreeing regions and limits output to the chosen identifier target", () => {
    const passes = [pass("59-B1 234.56\nRLH160KD12345"), pass("59B123456")];
    expect(chooseIdentifierRead(passes).license_plate).toBe("59B1-234.56");
    expect(chooseIdentifierRead(passes, "plate").frame_number).toBe("");
    expect(chooseIdentifierRead(passes, "frame").license_plate).toBe("");
    expect(chooseIdentifierRead(passes, "frame").frameConfidence).toBe(92);
  });

  it("marks one low-confidence glyph even when surrounding text is clear", () => {
    const raw = "59B123456";
    const read = chooseIdentifierRead([{ ...pass("59B1-234.56"), glyphs: [...raw].map((character, index) => ({ character, confidence: index === 7 ? 40 : 98 })) }]);
    expect(read.license_plate).toBe("59B1-234.56");
    expect(read.warnings.license_plate).toEqual([7]);
  });
});

describe("identity-card OCR and native QR parsing", () => {
  it("accepts a CCCD card number and preserves suspicious digits", () => {
    expect(parseIdentityDocumentText("CĂN CƯỚC CÔNG DÂN\nSố: 079203012345", 90)?.document_number).toBe("079203012345");
    const read = parseIdentityDocumentText("CITIZEN IDENTITY CARD\nNo: O792030I2345", 90);
    expect(read?.document_number).toBe("079203012345");
    expect(read?.uncertainCharacters).toEqual([0, 7]);
  });

  it("accepts legacy CMND only in legacy-document context", () => {
    expect(parseIdentityDocumentText("CHỨNG MINH NHÂN DÂN\nSố: 123456789")?.document_number).toBe("123456789");
    expect(parseIdentityDocumentText("CĂN CƯỚC CÔNG DÂN\n123456789")).toBeNull();
  });

  it("rejects dates, random phone numbers, unrelated QR payloads and competing IDs", () => {
    for (const text of ["079203012345", "CĂN CƯỚC CÔNG DÂN\n01/01/2003\n12/12/2020", "CCCD\nPhone: 079203012345", "CCCD\n079203012345\n079203054321", "CCCD\n000000000000"]) {
      expect(parseIdentityDocumentText(text), text).toBeNull();
    }
    expect(parseIdentityDocumentQr("079203012345")).toBeNull();
    expect(parseIdentityDocumentQr("https://example.test/079203012345")).toBeNull();
  });

  it("accepts native CCCD QR only with valid dates and matching encoded birth year", () => {
    expect(parseIdentityDocumentQr("079090123456||NGUYEN VAN A|15051990|Nam|TP Ho Chi Minh|01012020")?.document_number).toBe("079090123456");
    const payload = "079203012345|123456789|Nguyễn Văn An|01012003|Nam|Quận 1 TP Hồ Chí Minh|12122020";
    expect(parseIdentityDocumentQr(payload)).toEqual({ document_number: "079203012345", confidence: 100, uncertainCharacters: [] });
    expect(parseIdentityDocumentQr(payload.replace("01012003", "31022003"))).toBeNull();
    expect(parseIdentityDocumentQr(payload.replace("01012003", "01012004"))).toBeNull();
    expect(parseIdentityDocumentQr(payload.replace("Nguyễn Văn An", "12345678"))).toBeNull();
  });
});
