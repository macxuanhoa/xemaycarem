/** Expands two-digit model years using the same 80/00 pivot as date entry. */
export function normalizeVehicleYear(
  value: string | number | null | undefined,
): number | undefined {
  if (value == null) return undefined;
  const raw = String(value).trim();
  if (/^\d{1,2}$/.test(raw)) {
    const year = Number(raw);
    if (year === 0) return undefined;
    return year > 80 ? 1900 + year : 2000 + year;
  }
  return /^\d{4}$/.test(raw) ? Number(raw) : undefined;
}

/** Parses either plain digits or Vietnamese thousands-grouped integers. */
export function parseGroupedInteger(
  value: string | number | null | undefined,
): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (value == null) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw) && !/^\d{1,3}(?:[., ]\d{3})+$/.test(raw))
    return undefined;
  const parsed = Number(raw.replace(/[., ]/g, ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function formatGroupedInteger(
  value: string | number | null | undefined,
): string {
  const parsed = parseGroupedInteger(value);
  if (parsed == null) return value == null ? "" : String(value);
  return String(parsed).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
