import type { Vehicle } from "@/types";
import { getRecentValues } from "./recentVehicles";

/**
 * Gợi ý giá trị đã dùng gần đây cho ô Màu sắc. Hãng/Dòng xe/Phiên bản đã bị
 * xoá vĩnh viễn nên không còn loại gợi ý nào khác; loại xe lấy từ danh mục
 * `vehicle_types` (bộ chọn riêng), không suy ra từ dữ liệu cũ.
 */
export function vehicleSuggestions(
  vehicles: Vehicle[],
  field: "color",
  userId?: string,
) {
  const recent = getRecentValues(field, userId);
  const counts = new Map<string, { value: string; count: number }>();
  for (const vehicle of vehicles) {
    const value = vehicle[field]?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const old = counts.get(key);
    counts.set(key, {
      value: old?.value ?? value,
      count: (old?.count ?? 0) + 1,
    });
  }
  const values = [
    ...recent,
    ...[...counts.values()]
      .sort((a, b) => b.count - a.count)
      .map((item) => item.value),
  ];
  const seen = new Set<string>();
  return values
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}
