import {
  normalizeVehicleYear,
  parseGroupedInteger,
} from "@/lib/vehicleInputFormatting";

const PREFIX = "xe_crm_draft_v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TEXT_FIELDS = [
  "frame_number",
  "engine_number",
  "license_plate",
  "brand",
  "model",
  "variant",
  "color",
  "acquisition_date",
  "purchase_date",
  "sale_date",
  "due_date",
] as const;
const NUMBER_FIELDS = ["year", "odometer"] as const;

export function draftFields(
  values: Record<string, unknown>,
): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const field of TEXT_FIELDS) {
    if (typeof values[field] === "string")
      safe[field] = values[field].slice(0, 250);
  }
  for (const field of NUMBER_FIELDS) {
    const parsed = parseGroupedInteger(
      values[field] as string | number | null | undefined,
    );
    if (parsed == null) continue;
    const normalized =
      field === "year" ? normalizeVehicleYear(parsed) ?? parsed : parsed;
    safe[field] = normalized;
  }
  return safe;
}

export function saveFormDraft(
  kind: string,
  userId: string | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!userId) return false;
  try {
    localStorage.setItem(
      `${PREFIX}:${userId}:${kind}`,
      JSON.stringify({ savedAt: Date.now(), fields: draftFields(values) }),
    );
    return true;
  } catch {
    return false;
  }
}

export function readFormDraft(
  kind: string,
  userId?: string,
): Record<string, string | number> | null {
  if (!userId) return null;
  try {
    const raw = JSON.parse(
      localStorage.getItem(`${PREFIX}:${userId}:${kind}`) ?? "null",
    );
    if (
      !raw ||
      !Number.isFinite(raw.savedAt) ||
      Date.now() - raw.savedAt > MAX_AGE_MS ||
      !raw.fields ||
      typeof raw.fields !== "object"
    )
      return null;
    const fields = draftFields(raw.fields);
    // Scrub old-format drafts on access without renewing their expiry.
    if (JSON.stringify(fields) !== JSON.stringify(raw.fields)) {
      try {
        localStorage.setItem(
          `${PREFIX}:${userId}:${kind}`,
          JSON.stringify({ savedAt: raw.savedAt, fields }),
        );
      } catch { /* Storage may be read-only; never restore excluded fields. */ }
    }
    return fields;
  } catch {
    return null;
  }
}

export function clearFormDraft(kind: string, userId?: string): void {
  if (!userId) return;
  try {
    localStorage.removeItem(`${PREFIX}:${userId}:${kind}`);
  } catch {
    /* Optional storage. */
  }
}
