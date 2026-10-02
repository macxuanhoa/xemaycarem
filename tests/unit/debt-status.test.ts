import { describe, expect, it } from "vitest";
import { resolveDebtStatus, resolveIsOverdue } from "@/lib/debt";

/**
 * A3 regression: ONE canonical debt-status resolver for desktop + mobile.
 * Server-provided debt_status/is_overdue win whenever present; the client
 * fallback must match private.sale_json semantics exactly.
 */

const base = {
  status: "COMPLETED" as const,
  paid_amount: 0,
  remaining_amount: 0,
};

describe("resolveDebtStatus", () => {
  it("UNPAID: nothing paid and full amount still owing", () => {
    expect(
      resolveDebtStatus({ ...base, paid_amount: 0, remaining_amount: 50_000_000 }),
    ).toBe("UNPAID");
  });

  it("PARTIALLY_PAID: some money received, balance remains", () => {
    expect(
      resolveDebtStatus({ ...base, paid_amount: 20_000_000, remaining_amount: 30_000_000 }),
    ).toBe("PARTIALLY_PAID");
  });

  it("PAID: balance settled exactly", () => {
    expect(
      resolveDebtStatus({ ...base, paid_amount: 50_000_000, remaining_amount: 0 }),
    ).toBe("PAID");
  });

  it("PAID: overpaid edge case (server clamps remaining to 0) never becomes negative state", () => {
    expect(
      resolveDebtStatus({ ...base, paid_amount: 60_000_000, remaining_amount: 0 }),
    ).toBe("PAID");
    // Defensive: even a legacy payload with negative remaining lands on PAID.
    expect(
      resolveDebtStatus({ ...base, paid_amount: 60_000_000, remaining_amount: -10_000 }),
    ).toBe("PAID");
  });

  it("CANCELLED sales report CANCELLED regardless of amounts", () => {
    expect(
      resolveDebtStatus({
        status: "CANCELLED",
        paid_amount: 10_000_000,
        remaining_amount: 40_000_000,
      }),
    ).toBe("CANCELLED");
  });

  it("prefers the authoritative server debt_status over the fallback", () => {
    expect(
      resolveDebtStatus({
        ...base,
        paid_amount: 0,
        remaining_amount: 5_000_000,
        debt_status: "OVERDUE",
      }),
    ).toBe("OVERDUE");
  });

  it("desktop and mobile fallbacks are the same function — no missing UNPAID branch", () => {
    // The historic mobile bug: unpaid rows rendered as PARTIALLY_PAID.
    const sale = { ...base, paid_amount: 0, remaining_amount: 30_000_000 };
    expect(resolveDebtStatus(sale)).toBe("UNPAID");
    expect(resolveDebtStatus(sale)).not.toBe("PARTIALLY_PAID");
  });
});

describe("resolveIsOverdue", () => {
  it("prefers the server is_overdue flag", () => {
    expect(
      resolveIsOverdue({ ...base, due_date: "2099-01-01", is_overdue: true }, "2026-10-02"),
    ).toBe(true);
  });

  it("falls back to due_date < today with an open balance", () => {
    expect(
      resolveIsOverdue({ ...base, due_date: "2026-09-01", remaining_amount: 1_000_000 }, "2026-10-02"),
    ).toBe(true);
    expect(
      resolveIsOverdue({ ...base, due_date: "2026-11-01", remaining_amount: 1_000_000 }, "2026-10-02"),
    ).toBe(false);
    expect(
      resolveIsOverdue({ ...base, due_date: "2026-09-01", remaining_amount: 0 }, "2026-10-02"),
    ).toBe(false);
    expect(
      resolveIsOverdue({ ...base, due_date: null, remaining_amount: 5_000_000 }, "2026-10-02"),
    ).toBe(false);
  });

  it("cancelled sales are never overdue", () => {
    expect(
      resolveIsOverdue(
        { status: "CANCELLED", due_date: "2026-01-01", remaining_amount: 9_000_000 },
        "2026-10-02",
      ),
    ).toBe(false);
  });
});
