import type { Vehicle } from "@/types";
import { getRecentValues } from "./recentVehicles";

/**
 * Gợi ý giá trị đã dùng gần đây, tính trực tiếp từ danh sách xe đã lưu trong
 * Kho: DISTINCT theo `field`, bỏ trùng không phân biệt hoa/thường (giữ cách
 * viết gặp đầu tiên), sắp theo số lần dùng. Dùng cho ô Màu sắc và ô Loại xe
 * (tên mẫu xe nhập tự do — yêu cầu: gợi ý học từ xe thật, không phải danh mục
 * seed). Giá trị mới nhập sẽ nổi lên sau khi danh sách xe được refresh.
 */
export function vehicleSuggestions(
  vehicles: Vehicle[],
  field: "color" | "vehicle_type",
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
