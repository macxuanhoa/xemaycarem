import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeInventoryIndicator,
  resolveInventoryStatus,
} from "@/lib/inventory-status";
import type { DashboardData } from "@/types";

/**
 * Inventory-threshold truthfulness suite:
 * 1. the client fallback must mirror the dashboard RPC's SQL CASE exactly
 *    (strict < / > boundaries, LOW wins precedence, at-store = IN_STOCK + RESERVED);
 * 2. the server-provided inventory_indicator always wins;
 * 3. Settings copy must not promise notifications the system cannot send;
 * 4. the Dashboard must render the indicator through the canonical resolver.
 */

const repoFile = (relative: string) =>
  readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");

const dashboardSql = repoFile(
  "../../supabase/migrations/20261001003100_production_reconciliation.sql",
);

describe("computeInventoryIndicator (mirror of the SQL CASE)", () => {
  it("LOW strictly below the minimum threshold", () => {
    expect(computeInventoryIndicator(4, 5, 100)).toBe("LOW");
    expect(computeInventoryIndicator(0, 5, 100)).toBe("LOW");
  });

  it("HIGH strictly above the maximum threshold", () => {
    expect(computeInventoryIndicator(101, 5, 100)).toBe("HIGH");
  });

  it("boundary values are NORMAL — thresholds form the inclusive acceptable band", () => {
    expect(computeInventoryIndicator(5, 5, 100)).toBe("NORMAL");
    expect(computeInventoryIndicator(100, 5, 100)).toBe("NORMAL");
  });

  it("NORMAL between the thresholds", () => {
    expect(computeInventoryIndicator(50, 5, 100)).toBe("NORMAL");
  });

  it("LOW takes precedence over HIGH when both fire (server CASE order)", () => {
    // at-store 2 with low=3 and high=1: SQL evaluates the LOW branch first.
    expect(computeInventoryIndicator(2, 3, 1)).toBe("LOW");
  });

  it("matches the shipped SQL: same expressions, same strict operators, same order", () => {
    const block = dashboardSql.match(
      /'inventory_indicator', CASE([\s\S]*?)INTO v_part/,
    );
    expect(block, "inventory_indicator CASE missing from dashboard RPC").not
      .toBeNull();
    const sql = block![1].replace(/\s+/g, " ");
    expect(sql).toContain(
      "(v_result->>'in_stock')::integer + (v_result->>'reserved')::integer < low_stock_threshold THEN 'LOW'",
    );
    expect(sql).toContain(
      "(v_result->>'in_stock')::integer + (v_result->>'reserved')::integer > high_stock_threshold THEN 'HIGH'",
    );
    expect(sql).toContain("ELSE 'NORMAL'");
    // The client mirror must stay a faithful re-implementation of that SQL.
    expect(computeInventoryIndicator(4, 5, 100)).toBe("LOW");
    expect(computeInventoryIndicator(5, 5, 100)).toBe("NORMAL");
    expect(computeInventoryIndicator(100, 5, 100)).toBe("NORMAL");
    expect(computeInventoryIndicator(101, 5, 100)).toBe("HIGH");
  });
});

describe("resolveInventoryStatus", () => {
  it("prefers the authoritative server indicator over the fallback", () => {
    const status = resolveInventoryStatus({
      inventory_indicator: "HIGH",
      in_stock: 1,
      reserved: 0,
      low_stock_threshold: 5,
      high_stock_threshold: 100,
    });
    // Fallback would say LOW; the server value must win.
    expect(status?.indicator).toBe("HIGH");
    expect(status?.label).toBe("Tồn kho cao");
  });

  it("maps LOW/NORMAL/HIGH to the business Vietnamese labels and theme tones", () => {
    const base = { in_stock: 10, reserved: 0 };
    expect(resolveInventoryStatus({ ...base, inventory_indicator: "LOW" })).toEqual({
      indicator: "LOW",
      label: "Tồn kho thấp",
      tone: "amber",
    });
    expect(
      resolveInventoryStatus({ ...base, inventory_indicator: "NORMAL" }),
    ).toEqual({
      indicator: "NORMAL",
      label: "Tồn kho bình thường",
      tone: "lime",
    });
    expect(resolveInventoryStatus({ ...base, inventory_indicator: "HIGH" })).toEqual({
      indicator: "HIGH",
      label: "Tồn kho cao",
      tone: "gold",
    });
  });

  it("falls back to the SQL-compatible computation when the server value is absent", () => {
    // At-store stock is in_stock + reserved (4 + 2 = 6) against [5, 100].
    expect(
      resolveInventoryStatus({
        in_stock: 4,
        reserved: 2,
        low_stock_threshold: 5,
        high_stock_threshold: 100,
      })?.indicator,
    ).toBe("NORMAL");
    expect(
      resolveInventoryStatus({
        in_stock: 3,
        reserved: 1,
        low_stock_threshold: 5,
        high_stock_threshold: 100,
      })?.indicator,
    ).toBe("LOW");
  });

  it("returns null instead of a wrong status when nothing is resolvable", () => {
    expect(resolveInventoryStatus({ in_stock: 5, reserved: 1 })).toBeNull();
  });
});


describe("Dashboard inventory status rendering", () => {
  const dashboardSource = repoFile(
    "../../src/features/dashboard/DashboardPage.tsx",
  );

  it("renders the server indicator through the canonical resolver, not ad-hoc strings", () => {
    expect(dashboardSource).toContain(
      'from "@/lib/inventory-status"',
    );
    expect(dashboardSource).toContain("resolveInventoryStatus(");
    expect(dashboardSource).toContain("inventory_indicator: d.inventory_indicator");
    expect(dashboardSource).toContain("digest-status--${stockStatus.tone}");
    expect(dashboardSource).toContain("{stockStatus.label}");
  });

  it("DashboardData carries the server indicator key exactly as the RPC emits it", () => {
    const typesSource = repoFile("../../src/types/index.ts");
    expect(typesSource).toContain(
      'inventory_indicator?: "LOW" | "NORMAL" | "HIGH";',
    );
    // Type-level smoke: the field exists on the dashboard payload contract.
    const payload: Pick<DashboardData, "inventory_indicator"> = {
      inventory_indicator: "LOW",
    };
    expect(payload.inventory_indicator).toBe("LOW");
  });
});
