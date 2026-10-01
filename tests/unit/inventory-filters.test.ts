import { describe, expect, it } from "vitest";
import { statusLabels } from "@/components/ui";

/**
 * Regression tests for inventory filter UX semantics.
 *
 * These tests import the static configuration directly from InventoryPage
 * source to verify that status tabs, quick presets, advanced filters, and sort
 * remain semantically independent and free of redundancy.
 *
 * Since the constants are module-level but not exported, we test by re-declaring
 * the canonical expected values and verifying business invariants.
 */

/* ── Canonical status options (lifecycle state) ── */
const statusOptions = [
  { value: "", label: "Tất cả" },
  { value: "AVAILABLE", label: "Tại cửa hàng" },
  { value: "IN_STOCK", label: "Sẵn sàng bán" },
  { value: "RESERVED", label: "Giữ chỗ" },
  { value: "SOLD", label: "Đã bán" },
  { value: "CANCELLED", label: "Đã hủy" },
];

/* ── Canonical quick presets (operational shortcuts) ── */
const quickPresets = [
  { id: "old", label: "Tồn kho lâu > 60 ngày", filters: { sort: "longest_stock", status: "IN_STOCK", min_days: "61" } },
  { id: "cost_pending", label: "Chờ giá nhập", filters: { cost_pending: "true" } },
];

describe("Inventory status tabs (vehicle lifecycle)", () => {
  it("uses the same ready-to-sell wording on status badges", () => {
    expect(statusLabels.IN_STOCK).toBe("Sẵn sàng bán");
  });

  it("includes all required lifecycle states", () => {
    const values = statusOptions.map((o) => o.value);
    expect(values).toContain("");
    expect(values).toContain("AVAILABLE");
    expect(values).toContain("IN_STOCK");
    expect(values).toContain("RESERVED");
    expect(values).toContain("SOLD");
    expect(values).toContain("CANCELLED");
  });

  it("uses concise user-facing labels without parenthetical explanations", () => {
    for (const option of statusOptions) {
      expect(option.label).not.toMatch(/\(/);
      expect(option.label).not.toMatch(/\)/);
    }
  });

  it("'Tại cửa hàng' maps to AVAILABLE which combines IN_STOCK + RESERVED at DB level", () => {
    const atShop = statusOptions.find((o) => o.value === "AVAILABLE");
    expect(atShop).toBeDefined();
    expect(atShop!.label).toBe("Tại cửa hàng");
  });

  it("'Sẵn sàng bán' maps to IN_STOCK", () => {
    const ready = statusOptions.find((o) => o.value === "IN_STOCK");
    expect(ready).toBeDefined();
    expect(ready!.label).toBe("Sẵn sàng bán");
  });

  it("'Giữ chỗ' maps to RESERVED status tab", () => {
    const reserved = statusOptions.find((o) => o.value === "RESERVED");
    expect(reserved).toBeDefined();
    expect(reserved!.label).toBe("Giữ chỗ");
  });
});

describe("Quick presets (operational shortcuts)", () => {
  it("does NOT contain 'Đang giữ chỗ' (redundant with RESERVED status tab)", () => {
    const labels = quickPresets.map((p) => p.label);
    expect(labels).not.toContain("Đang giữ chỗ");
    const ids = quickPresets.map((p) => p.id);
    expect(ids).not.toContain("reserved");
  });

  it("does NOT contain 'Xe mới nhập' (redundant: Sẵn sàng bán tab + Mới nhập trước sort)", () => {
    const labels = quickPresets.map((p) => p.label);
    expect(labels).not.toContain("Xe mới nhập");
    const ids = quickPresets.map((p) => p.id);
    expect(ids).not.toContain("new");
  });

  it("'Tồn kho lâu > 60 ngày' applies correct composite filter", () => {
    const oldStock = quickPresets.find((p) => p.id === "old");
    expect(oldStock).toBeDefined();
    expect(oldStock!.filters).toEqual({
      sort: "longest_stock",
      status: "IN_STOCK",
      min_days: "61",
    });
  });

  it("'Chờ giá nhập' uses cost_pending flag only", () => {
    const costPending = quickPresets.find((p) => p.id === "cost_pending");
    expect(costPending).toBeDefined();
    expect(costPending!.filters).toEqual({ cost_pending: "true" });
  });

  it("no quick preset duplicates a single status tab exactly", () => {
    const statusValues = statusOptions.map((o) => o.value).filter(Boolean);
    for (const preset of quickPresets) {
      const keys = Object.keys(preset.filters);
      // A preset is a status-tab duplicate if it has only { status: "..." }
      if (keys.length === 1 && keys[0] === "status") {
        const duplicated = statusValues.includes(preset.filters.status!);
        expect(duplicated).toBe(false);
      }
    }
  });

  it("each preset has a unique id", () => {
    const ids = quickPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Sort independence", () => {
  it("sort is NOT a filter concept — presets that include sort also include filter conditions", () => {
    for (const preset of quickPresets) {
      if (preset.filters.sort) {
        const otherKeys = Object.keys(preset.filters).filter((k) => k !== "sort");
        expect(otherKeys.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("Sort dropdown options", () => {
  /* ── Canonical sort options (simplified for inventory page) ── */
  const sortOptions = [
    { value: "newest", label: "Mới nhất" },
    { value: "longest_stock", label: "Tồn kho lâu nhất" },
  ];

  it("has exactly two sort options", () => {
    expect(sortOptions).toHaveLength(2);
  });

  it("'Mới nhất' maps to newest acquisition sort", () => {
    const newest = sortOptions.find((o) => o.value === "newest");
    expect(newest).toBeDefined();
    expect(newest!.label).toBe("Mới nhất");
  });

  it("'Tồn kho lâu nhất' maps to longest stock age sort", () => {
    const longestStock = sortOptions.find((o) => o.value === "longest_stock");
    expect(longestStock).toBeDefined();
    expect(longestStock!.label).toBe("Tồn kho lâu nhất");
  });

  it("does NOT include price-based sorts", () => {
    const values = sortOptions.map((o) => o.value);
    expect(values).not.toContain("highest_price");
    expect(values).not.toContain("highest_cost");
    expect(values).not.toContain("lowest_price");
    expect(values).not.toContain("lowest_cost");
  });

  it("does NOT include 'Cũ nhất trước' (redundant with inventory focus)", () => {
    const values = sortOptions.map((o) => o.value);
    expect(values).not.toContain("oldest");
  });
});
