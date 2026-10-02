import { describe, expect, it } from "vitest";
import { mergeSearchParams } from "@/lib/urlParams";

/**
 * A7 regression: changing one search param must preserve all unrelated
 * params (search, page, date range, customer, active filters). Only an
 * intentional empty value clears a param.
 */

describe("mergeSearchParams", () => {
  const prev = new URLSearchParams({
    payment_status: "DEBT_ONLY",
    search: "0914",
    page: "3",
    from: "2026-09-01",
    to: "2026-09-30",
    customer: "tranvanA",
  });

  it("updates payment_status while preserving every other param", () => {
    const next = mergeSearchParams(prev, { payment_status: "OVERDUE" });
    expect(next.get("payment_status")).toBe("OVERDUE");
    expect(next.get("search")).toBe("0914");
    expect(next.get("page")).toBe("3");
    expect(next.get("from")).toBe("2026-09-01");
    expect(next.get("to")).toBe("2026-09-30");
    expect(next.get("customer")).toBe("tranvanA");
  });

  it("removes ONLY the param explicitly cleared", () => {
    const next = mergeSearchParams(prev, { payment_status: "" });
    expect(next.has("payment_status")).toBe(false);
    expect(next.get("search")).toBe("0914");
    expect(next.get("page")).toBe("3");
  });

  it("adds a brand new param without touching the rest", () => {
    const next = mergeSearchParams(prev, { sort: "due_date" });
    expect(next.get("sort")).toBe("due_date");
    expect([...next.keys()].filter((k) => k !== "sort")).toEqual([
      ...prev.keys(),
    ]);
  });

  it("supports chained functional updates like useSearchParams(prev => ...)", () => {
    const next = mergeSearchParams(mergeSearchParams(prev, { page: "1" }), {
      payment_status: "PAID",
    });
    expect(next.get("page")).toBe("1");
    expect(next.get("payment_status")).toBe("PAID");
    expect(next.get("search")).toBe("0914");
  });

  it("never mutates the previous URLSearchParams instance", () => {
    const snapshot = prev.toString();
    mergeSearchParams(prev, { payment_status: "ALL", page: "" });
    expect(prev.toString()).toBe(snapshot);
  });
});
