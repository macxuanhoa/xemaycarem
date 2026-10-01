import { describe, expect, it } from "vitest";
import {
  parseMoneyInput,
  formatVndNumber,
  formatVndDisplay,
  formatVndApproxText,
  formatVndWords,
} from "@/lib/moneyHelper";

describe("parseMoneyInput", () => {
  it("parses raw numeric string", () => {
    expect(parseMoneyInput("82000000")).toBe(82000000);
    expect(parseMoneyInput("82.000.000")).toBe(82000000);
    expect(parseMoneyInput("82,000,000")).toBe(82000000);
    expect(parseMoneyInput("82 000 000")).toBe(82000000);
  });

  it("parses shorthand million (tr, m)", () => {
    expect(parseMoneyInput("82tr")).toBe(82000000);
    expect(parseMoneyInput("82m")).toBe(82000000);
    expect(parseMoneyInput("82.5tr")).toBe(82500000);
    expect(parseMoneyInput("82,5tr")).toBe(82500000);
    expect(parseMoneyInput("8.5m")).toBe(8500000);
  });

  it("parses shorthand thousand (k)", () => {
    expect(parseMoneyInput("150k")).toBe(150000);
    expect(parseMoneyInput("150.5k")).toBe(150500);
    expect(parseMoneyInput("200k")).toBe(200000);
  });

  it("parses numbers directly", () => {
    expect(parseMoneyInput(82000000)).toBe(82000000);
    expect(parseMoneyInput(0)).toBe(0);
  });

  it("handles empty or invalid inputs safely", () => {
    expect(parseMoneyInput("")).toBeUndefined();
    expect(parseMoneyInput("   ")).toBeUndefined();
    expect(parseMoneyInput(undefined)).toBeUndefined();
    expect(parseMoneyInput(null)).toBeUndefined();
    expect(parseMoneyInput("abc")).toBeUndefined();
  });

  it("formats VND numbers correctly", () => {
    expect(formatVndNumber(82000000)).toBe("82.000.000");
    expect(formatVndDisplay(82000000)).toContain("82.000.000");
  });
  it("rejects negative, malformed, fractional VND and unsafe amounts instead of stripping characters", () => {
    for (const value of [
      "-82000000",
      "82abc",
      "82.5",
      "1,23,456",
      "82.000,000",
      "9007199254740993",
      "1000000000001",
      "999999999999tr",
    ]) {
      expect(parseMoneyInput(value), value).toBeUndefined();
    }
    expect(parseMoneyInput(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseMoneyInput(82.5)).toBeUndefined();
    expect(parseMoneyInput(-1)).toBeUndefined();
  });
  it("normalizes valid currency paste and shorthand with integer arithmetic", () => {
    expect(parseMoneyInput("82.000.000 ₫")).toBe(82000000);
    expect(parseMoneyInput("82,000,000 VND")).toBe(82000000);
    expect(parseMoneyInput("0,1tr")).toBe(100000);
    expect(parseMoneyInput("1.2tỷ")).toBe(1200000000);
    expect(parseMoneyInput("0.000001m")).toBe(1);
  });
});

describe("formatVndApproxText", () => {
  it("formats millions, billions, and thousands into natural approximation", () => {
    expect(formatVndApproxText(82000000)).toBe("≈ 82 triệu đồng");
    expect(formatVndApproxText(82500000)).toBe("≈ 82,5 triệu đồng");
    expect(formatVndApproxText(1200000000)).toBe("≈ 1,2 tỷ đồng");
    expect(formatVndApproxText(150000)).toBe("≈ 150 nghìn đồng");
  });

  it("handles empty or zero safely", () => {
    expect(formatVndApproxText(0)).toBe("");
    expect(formatVndApproxText(undefined)).toBe("");
    expect(formatVndApproxText(null)).toBe("");
  });
});

describe("formatVndWords", () => {
  it("converts amounts to accurate Vietnamese words", () => {
    expect(formatVndWords(82000000)).toBe("Tám mươi hai triệu đồng");
    expect(formatVndWords(82500000)).toBe(
      "Tám mươi hai triệu năm trăm nghìn đồng",
    );
    expect(formatVndWords(1000000000)).toBe("Một tỷ đồng");
    expect(formatVndWords(15000000)).toBe("Mười lăm triệu đồng");
    expect(formatVndWords(21000000)).toBe("Hai mươi mốt triệu đồng");
    expect(formatVndWords(24000000)).toBe("Hai mươi tư triệu đồng");
    expect(formatVndWords(25000000)).toBe("Hai mươi lăm triệu đồng");
    expect(formatVndWords(0)).toBe("Không đồng");
  });

  it("handles negative or invalid values safely", () => {
    expect(formatVndWords(-100)).toBe("");
    expect(formatVndWords(undefined)).toBe("");
    expect(formatVndWords(null)).toBe("");
  });
});

describe("VND money input & formatting integrity", () => {
  it("82000000 displays as 82.000.000 and 82.000.000 submits as 82000000", () => {
    expect(formatVndNumber(82000000)).toBe("82.000.000");
    expect(parseMoneyInput("82.000.000")).toBe(82000000);
  });

  it("clearing field stays empty and does not silently become 0", () => {
    expect(parseMoneyInput("")).toBeUndefined();
    expect(parseMoneyInput("   ")).toBeUndefined();
    expect(parseMoneyInput(undefined)).toBeUndefined();
    expect(parseMoneyInput(null)).toBeUndefined();
    expect(formatVndNumber(undefined)).toBe("");
    expect(formatVndNumber(null)).toBe("");
  });

  it("safely handles invalid characters and negative values", () => {
    expect(parseMoneyInput("abc")).toBeUndefined();
    expect(parseMoneyInput("82abc")).toBeUndefined();
    expect(parseMoneyInput("-82000000")).toBeUndefined();
    expect(parseMoneyInput("-1")).toBeUndefined();
  });

  it("handles very large allowed VND values without floating point distortion", () => {
    const largeAmount = 999_000_000_000; // 999 tỷ VND
    expect(Number.isSafeInteger(largeAmount)).toBe(true);
    expect(formatVndNumber(largeAmount)).toBe("999.000.000.000");
    expect(parseMoneyInput("999.000.000.000")).toBe(largeAmount);
    expect(formatVndWords(largeAmount)).toBe("Chín trăm chín mươi chín tỷ đồng");

    const maxBound = 1_000_000_000_000; // 1 nghìn tỷ VND
    expect(formatVndNumber(maxBound)).toBe("1.000.000.000.000");
    expect(parseMoneyInput("1.000.000.000.000")).toBe(maxBound);

    // Beyond limit is safely rejected
    expect(parseMoneyInput("1.000.000.000.001")).toBeUndefined();
  });

  it("strictly preserves integer VND contract and prevents float conversion", () => {
    const rawDigits = "82000000";
    const parsed = parseMoneyInput(rawDigits);
    expect(parsed).toBe(82000000);
    expect(Number.isInteger(parsed)).toBe(true);
    expect(parsed! % 1).toBe(0);
    // Fractional VND without unit is rejected
    expect(parseMoneyInput("82000000.5")).toBeUndefined();
    expect(parseMoneyInput("82000000,5")).toBeUndefined();
  });
});


