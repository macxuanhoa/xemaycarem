/**
 * Canonical inventory-status labels (single source of truth for the app).
 *
 * The dashboard RPC computes `inventory_indicator` server-side from vehicles
 * AT THE STORE (status IN_STOCK + RESERVED) against system_settings thresholds:
 * LOW when strictly below `low_stock_threshold`, HIGH when strictly above
 * `high_stock_threshold`, NORMAL in between (thresholds are the inclusive
 * acceptable band). The client fallback below mirrors that SQL CASE
 * expression exactly — same precedence, same strict boundaries — so the
 * dashboard never disagrees with the server. Reserved bikes are held for
 * customers, so this indicator is deliberately NOT "sẵn sàng bán"; wording
 * here must keep the "đang tại cửa hàng" semantics (see docs/DECISIONS.md).
 *
 * Worked example with low=5, high=100: 4 -> LOW, 5 -> NORMAL, 100 -> NORMAL,
 * 101 -> HIGH. These thresholds are operational dashboard indicators only and
 * never generate an email, push, or automatic `system_announcements`.
 */

export type InventoryIndicator = "LOW" | "NORMAL" | "HIGH";

const INVENTORY_STATUS_LABELS: Record<InventoryIndicator, string> = {
  LOW: "Tồn kho thấp",
  NORMAL: "Tồn kho bình thường",
  HIGH: "Tồn kho cao",
};

/** Digest color-class tone, reuses the existing status palette tokens. */
export type InventoryStatusTone = "lime" | "gold" | "amber";

const INVENTORY_STATUS_TONES: Record<InventoryIndicator, InventoryStatusTone> =
  {
    LOW: "amber",
    NORMAL: "lime",
    HIGH: "gold",
  };

export type InventoryStatus = {
  indicator: InventoryIndicator;
  label: string;
  tone: InventoryStatusTone;
};

/**
 * Mirror of public.dashboard()'s inventory_indicator CASE when the server
 * value is absent (older payloads, partial fixtures). Boundaries intentionally
 * replicate the SQL: strict `<` / `>` comparisons.
 */
export function computeInventoryIndicator(
  atStoreCount: number,
  lowStockThreshold: number,
  highStockThreshold: number,
): InventoryIndicator {
  if (atStoreCount < lowStockThreshold) return "LOW";
  if (atStoreCount > highStockThreshold) return "HIGH";
  return "NORMAL";
}

/**
 * Prefer the authoritative server `inventory_indicator`; fall back to the
 * SQL-compatible client computation only when the server value AND both
 * thresholds are available. Returns null when nothing can be resolved, so
 * callers render no status instead of a wrong one.
 */
export function resolveInventoryStatus(input: {
  inventory_indicator?: string | null;
  in_stock: number;
  reserved: number;
  low_stock_threshold?: number | null;
  high_stock_threshold?: number | null;
}): InventoryStatus | null {
  const server =
    input.inventory_indicator === "LOW" ||
    input.inventory_indicator === "NORMAL" ||
    input.inventory_indicator === "HIGH"
      ? input.inventory_indicator
      : null;
  const indicator =
    server ??
    (input.low_stock_threshold != null && input.high_stock_threshold != null
      ? computeInventoryIndicator(
          input.in_stock + input.reserved,
          input.low_stock_threshold,
          input.high_stock_threshold,
        )
      : null);
  if (!indicator) return null;
  return {
    indicator,
    label: INVENTORY_STATUS_LABELS[indicator],
    tone: INVENTORY_STATUS_TONES[indicator],
  };
}
