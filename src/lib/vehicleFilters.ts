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

/**
 * "Yêu thích" là một TAB đứng trước "Tại cửa hàng", không còn là pill lọc
 * trong hàng quick preset. Tab này không phải trạng thái xe (không được nhét
 * vào VEHICLE_STATUS_OPTIONS): bấm vào sẽ bật `fav=1` và xóa `status` trên
 * URL, danh sách lấy mọi xe được sao bất kể trạng thái (status ALL phía
 * server). Mặc định khi mở Kho vẫn là "Tại cửa hàng" vì `fav` chỉ bật khi
 * người dùng chủ động bấm tab.
 */
export const FAVORITE_TAB_LABEL = "Yêu thích";
export const FAVORITE_TAB_HINT =
  "Xe bạn đã đánh dấu sao — danh sách riêng theo tài khoản, gồm cả xe đã bán.";
