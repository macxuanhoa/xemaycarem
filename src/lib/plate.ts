/**
 * Vietnamese motorbike licence-plate helpers — the single source of truth for
 * how a plate is recognised, normalised and validated across the whole app
 * (manual vehicle/acquisition forms, the shorthand intake parser, and the
 * review cards). Keeping one implementation means a plate typed by hand and a
 * plate parsed from a phone note always converge on the same canonical string.
 *
 * Real-world motorbike plates read `59-A1 234.56`:
 *   • 2-digit province code (59 = TP.HCM, 29–33 = Hà Nội, 43 = Đà Nẵng…)
 *   • a series of 1–2 letters + a leading digit (A1, B2, X1, LN1…)
 *   • a 4–5 digit serial, dot-grouped as `XXX.XX` (5 digits) or left whole
 *     (legacy 4-digit serials such as `29-A1 1234`).
 * The database de-duplicates on the alphanumeric-only form, so the separators
 * here are purely for human display — but we standardise them so the placeholder,
 * the stored value and the edit screen all look identical.
 */

/** Example shown in every plate input's placeholder. */
export const PLATE_EXAMPLE = "59-A1 234.56";

/**
 * Fold any reasonable spelling (`59 a1 234.56`, `59A1-234.56`, `59-A123456`)
 * into the canonical `59-A1 234.56`. Returns null when the string is not a
 * well-formed Vietnamese plate, so callers can both normalise and validate.
 */
export function normalizePlate(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = compact.match(/^(\d{2})([A-Z]{1,2})(\d{5,7})$/);
  if (!m) return null;
  const [, prov, letters, rest] = m;
  // The first digit after the letters is the series number (A1, B2, …); the
  // remaining 4–6 digits are the serial.
  const series = letters + rest[0];
  const serial = rest.slice(1);
  const serialStr =
    serial.length === 5 ? `${serial.slice(0, 3)}.${serial.slice(3)}` : serial;
  return `${prov}-${series} ${serialStr}`;
}

/**
 * A plate is optional, but if present it must look like a real motorbike plate.
 * Empty/whitespace passes; anything else has to normalise successfully.
 */
export function isValidMotorbikePlate(raw: string): boolean {
  return raw.trim() === "" || normalizePlate(raw) !== null;
}

/**
 * Canonical value to persist: `""` stays empty, a valid plate is reformatted,
 * and an unrecognised string is left upper-cased (validation should have
 * already blocked it, but we never want to silently drop what a user typed).
 */
export function canonicalizePlate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return normalizePlate(trimmed) ?? trimmed.toUpperCase();
}

/** Vietnamese error copy reused by the form schemas. */
export const PLATE_INVALID_MESSAGE = `Biển số không đúng định dạng xe máy Việt Nam (ví dụ: ${PLATE_EXAMPLE}).`;
