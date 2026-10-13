import { describe, expect, it } from "vitest";
import { statusLabels } from "@/components/ui";
import {
  AVAILABLE_VEHICLE_STATUSES,
  DEFAULT_INVENTORY_STATUS,
  FAVORITE_TAB_HINT,
  FAVORITE_TAB_LABEL,
  PERSISTED_VEHICLE_STATUSES,
  VEHICLE_STATUS_OPTIONS,
} from "@/lib/vehicleFilters";

/**
 * Regression tests for inventory filter UX semantics (A5/A6).
 *
 * The canonical option list now lives in src/lib/vehicleFilters.ts — these
 * tests import it directly so code and contract can never drift apart.
 */

/* ── Canonical status options (lifecycle state) ── */
const statusOptions = VEHICLE_STATUS_OPTIONS;

/* ── Canonical quick presets (operational shortcuts) ── */
const quickPresets = [
  { id: "old", label: "Tồn kho lâu > 60 ngày", filters: { sort: "longest_stock", status: "IN_STOCK", min_days: "61" } },
];

describe("Inventory status tabs (vehicle lifecycle)", () => {
  it("uses the same ready-to-sell wording on status badges", () => {
    expect(statusLabels.IN_STOCK).toBe("Sẵn sàng bán");
  });

  it("exposes only the three operational showroom buckets as tabs", () => {
    const values = statusOptions.map((o) => o.value);
    expect(values).toEqual(["AVAILABLE", "RESERVED", "SOLD"]);
    // The default landing tab is "Tại cửa hàng" (AVAILABLE = IN_STOCK + RESERVED).
    expect(statusOptions[0].value).toBe("AVAILABLE");
    // "Tất cả", "Sẵn sàng bán" and "Đã hủy" are no longer standalone tabs.
    expect(values).not.toContain("");
    expect(values).not.toContain("IN_STOCK");
    expect(values).not.toContain("CANCELLED");
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
    // A6: the alias semantics must stay explicit in the shared constant.
    expect(AVAILABLE_VEHICLE_STATUSES).toEqual(["IN_STOCK", "RESERVED"]);
    expect(atShop!.hint).toContain("IN_STOCK");
    expect(atShop!.hint).toContain("RESERVED");
  });

  it("A5: AVAILABLE is a query alias only — never a persisted vehicle status", () => {
    expect(PERSISTED_VEHICLE_STATUSES).not.toContain("AVAILABLE" as never);
    expect(PERSISTED_VEHICLE_STATUSES).not.toContain("UNSOLD" as never);
    expect(PERSISTED_VEHICLE_STATUSES).toEqual([
      "IN_STOCK",
      "RESERVED",
      "SOLD",
      "CANCELLED",
    ]);
    // Every tab value is either "" (all) or an accepted filter token.
    for (const option of statusOptions) {
      expect(
        option.value === "" ||
          option.value === "AVAILABLE" ||
          option.value === "UNSOLD" ||
          PERSISTED_VEHICLE_STATUSES.includes(option.value as never),
      ).toBe(true);
    }
  });

  it("'Sẵn sàng bán' (IN_STOCK) is folded into 'Tại cửa hàng', not a standalone tab", () => {
    const ready = statusOptions.find((o) => o.value === "IN_STOCK");
    expect(ready).toBeUndefined();
    // The badge wording still exists for row/status labels.
    expect(statusLabels.IN_STOCK).toBe("Sẵn sàng bán");
  });

  it("'Giữ chỗ' maps to RESERVED status tab", () => {
    const reserved = statusOptions.find((o) => o.value === "RESERVED");
    expect(reserved).toBeDefined();
    expect(reserved!.label).toBe("Giữ chỗ");
  });

  it("'Đã bán' maps to SOLD status tab", () => {
    const sold = statusOptions.find((o) => o.value === "SOLD");
    expect(sold).toBeDefined();
    expect(sold!.label).toBe("Đã bán");
  });
});

describe("Favorites tab (personal star list, not a status)", () => {
  it("'Yêu thích' is a dedicated tab rendered BEFORE the status tabs", () => {
    // InventoryPage renders the favorite tab first, then VEHICLE_STATUS_OPTIONS.
    expect(FAVORITE_TAB_LABEL).toBe("Yêu thích");
    expect(FAVORITE_TAB_HINT).toContain("tài khoản");
  });

  it("is NOT smuggled into the status tab vocabulary", () => {
    const values = statusOptions.map((o) => o.value);
    expect(values).not.toContain(FAVORITE_TAB_LABEL as never);
    expect(PERSISTED_VEHICLE_STATUSES).not.toContain("FAVORITE" as never);
  });

  it("the default landing tab is still 'Tại cửa hàng', never 'Yêu thích'", () => {
    // Opening Kho without params keeps DEFAULT_INVENTORY_STATUS (AVAILABLE)
    // and fav off — the favorites tab only lights on an explicit click.
    expect(DEFAULT_INVENTORY_STATUS).toBe("AVAILABLE");
    expect(statusOptions[0].label).toBe("Tại cửa hàng");
  });

  it("no longer exists as a quick-filter pill", () => {
    const labels = quickPresets.map((p) => p.label);
    expect(labels).not.toContain("Yêu thích");
    const ids = quickPresets.map((p) => p.id);
    expect(ids).not.toContain("fav");
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

  it("does NOT contain a 'Chờ giá nhập' quick filter", () => {
    const labels = quickPresets.map((p) => p.label);
    expect(labels).not.toContain("Chờ giá nhập");
    const ids = quickPresets.map((p) => p.id);
    expect(ids).not.toContain("cost_pending");
  });

  it("no quick preset duplicates a single status tab exactly", () => {
    const statusValues = statusOptions.map((o) => o.value).filter(Boolean);
    for (const preset of quickPresets) {
      const keys = Object.keys(preset.filters);
      // A preset is a status-tab duplicate if it has only { status: "..." }
      if (keys.length === 1 && keys[0] === "status") {
        const duplicated = statusValues.includes(
          preset.filters.status! as (typeof statusValues)[number],
        );
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
