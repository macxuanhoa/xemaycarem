import type { Vehicle } from "@/types";
import { getRecentValues } from "./recentVehicles";

export function vehicleSuggestions(
  vehicles: Vehicle[],
  field: "brand" | "model" | "variant" | "color",
  userId?: string,
  brand = "",
) {
  const category =
    field === "model" ? `model:${brand.trim().toLowerCase()}` : field;
  const recent = getRecentValues(category, userId);
  const matches =
    field === "model" || field === "variant"
      ? vehicles.filter(
          (vehicle) =>
            vehicle.brand.trim().toLowerCase() === brand.trim().toLowerCase(),
        )
      : vehicles;
  const counts = new Map<string, { value: string; count: number }>();
  for (const vehicle of matches) {
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
