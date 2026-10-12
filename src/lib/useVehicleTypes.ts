import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { VehicleTypeItem } from "@/types";

/**
 * Danh mục loại xe (bảng `vehicle_types`) — nguồn duy nhất cho mọi bộ chọn
 * "Loại xe": form nhập xe, form thu xe, kho, tốc ký, Cài đặt.
 *
 * Nhân viên CHỈ chọn, không gõ tay; thêm loại mới là một INSERT do OWNER thực
 * hiện trong Cài đặt, không cần migration. Khóa query dùng chung nên lưu xong
 * là mọi form đang mở cập nhật ngay.
 */
export const VEHICLE_TYPES_QUERY_KEY = ["vehicle-types"] as const;

export type VehicleTypeChip = { value: string; label: string };

export function useVehicleTypes(enabled = true) {
  const query = useQuery({
    queryKey: VEHICLE_TYPES_QUERY_KEY,
    queryFn: () => api.listVehicleTypes(),
    staleTime: 5 * 60 * 1000,
    enabled,
  });

  const rawItems: VehicleTypeItem[] = query.data ?? [];
  const items: VehicleTypeItem[] = rawItems.filter(
    (item) => item.name.trim().toLowerCase() !== "chưa phân loại",
  );
  const chips: VehicleTypeChip[] = items.map((item) => ({
    value: item.id,
    label: item.name,
  }));

  return {
    items,
    chips,
    /** Tên loại xe theo id; rỗng khi danh mục chưa tải về. */
    nameOf: (id?: string | null) =>
      items.find((item) => item.id === id)?.name ?? "",
    isLoading: query.isPending,
  };
}

/** Invalidate after OWNER edits the catalogue in Settings. */
export function useVehicleTypesRefetch() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: VEHICLE_TYPES_QUERY_KEY });
}
