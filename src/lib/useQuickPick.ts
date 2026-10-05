import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  BRAND_CHIPS,
  COMMON_MODELS_BY_BRAND,
} from "@/components/ui/QuickChips";

type QuickPickRow = {
  quickpick_brands?: string[] | null;
  quickpick_models?: Record<string, string[]> | null;
};

export type QuickPickChip = { value: string; label: string };

const FALLBACK_BRANDS = BRAND_CHIPS;
const FALLBACK_MODELS = COMMON_MODELS_BY_BRAND;

/**
 * Loads the shop's quick-pick catalog from `system_settings` so every
 * authenticated user (STAFF/MANAGER/OWNER) sees the same chip row in the
 * intake and acquisition forms. Falls back to the code defaults until the
 * OWNER customises them.
 *
 * Uses the shared `["settings"]` query key so a save from Cài đặt instantly
 * refreshes any mounted form on the same device.
 */
export function useQuickPick() {
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<QuickPickRow>("get_settings"),
    staleTime: 5 * 60 * 1000,
  });

  const rawBrands = query.data?.quickpick_brands;
  const brandList =
    Array.isArray(rawBrands) && rawBrands.length > 0
      ? rawBrands.map((b) => b.trim()).filter(Boolean)
      : FALLBACK_BRANDS.map((chip) => chip.value);
  const brandChips: QuickPickChip[] = brandList.map((value) => ({
    value,
    label: value,
  }));

  const rawModels = query.data?.quickpick_models;
  const hasCustomModels =
    rawModels && typeof rawModels === "object" && Object.keys(rawModels).length > 0;

  const modelsFor = (brand: string): QuickPickChip[] => {
    const key = brand.trim().toLowerCase();
    if (!key) return [];
    const list = hasCustomModels
      ? (rawModels as Record<string, string[]>)[key]
      : FALLBACK_MODELS[key];
    if (!Array.isArray(list)) return [];
    return list
      .map((model) => (typeof model === "string" ? model.trim() : ""))
      .filter(Boolean)
      .map((value) => ({ value, label: value }));
  };

  return {
    brandChips,
    modelsFor,
    isLoading: query.isPending,
  };
}
