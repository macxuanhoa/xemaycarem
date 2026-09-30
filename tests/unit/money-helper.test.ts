import { describe, expect, it } from "vitest";
import {
  parseMoneyInput,
  formatVndNumber,
  formatVndDisplay,
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
