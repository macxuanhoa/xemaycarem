import type { VehicleStatus, VehicleStatusFilter } from "@/types";

/**
 * Canonical vehicle filter vocabulary (A5/A6). Persisted statuses live on
 * `VehicleStatus`; the list_vehicles RPC additionally accepts the query
 * aliases AVAILABLE/UNSOLD, which SQL expands to IN_STOCK + RESERVED.
 */

/** Statuses that may be persisted on vehicles.status (DB truth). */
export const PERSISTED_VEHICLE_STATUSES = [
  "IN_STOCK",
  "RESERVED",
  "SOLD",
  "CANCELLED",
] as const satisfies readonly VehicleStatus[];

/** The list_vehicles alias meaning "at the showroom": IN_STOCK + RESERVED. */
export const AVAILABLE_VEHICLE_STATUSES: readonly VehicleStatus[] = [
  "IN_STOCK",
  "RESERVED",
];

/** Filter alias (never a stored status) used by sell/expense pickers. */
export const AVAILABLE_VEHICLE_FILTER = "AVAILABLE" satisfies VehicleStatusFilter;

export type VehicleStatusOption = {
  value: VehicleStatusFilter | "";
  label: string;
  hint: string;
};

/**
 * Inventory tabs (A6). The showroom view defaults to "Tại cửa hàng" and only
 * exposes the three operational buckets staff act on day to day: at the shop
 * (AVAILABLE = IN_STOCK + RESERVED), reserved (RESERVED) and sold (SOLD).
 * Labels stay short (contract in tests/unit/inventory-filters.test.ts); `hint`
 * documents the exact SQL semantics so overlapping-sounding tabs are
 * unambiguous on hover/focus.
 */
export const VEHICLE_STATUS_OPTIONS: readonly VehicleStatusOption[] = [
  {
    value: "AVAILABLE",
    label: "Tại cửa hàng",
    hint: "Xe đang có tại cửa hàng: chờ bán (IN_STOCK) hoặc đang được giữ chỗ (RESERVED).",
  },
  { value: "RESERVED", label: "Giữ chỗ", hint: "Xe đang được khách giữ chỗ tạm thời." },
  { value: "SOLD", label: "Đã bán", hint: "Giao dịch bán đã hoàn tất." },
];

/** Default inventory tab when no `status` filter is present in the URL. */
export const DEFAULT_INVENTORY_STATUS = AVAILABLE_VEHICLE_FILTER;
