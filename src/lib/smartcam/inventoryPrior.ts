/**
 * CRM inventory as a second pair of eyes — never as an automatic correction.
 *
 * The exact-match wall stays exactly where `lookup.ts` put it: an identifier
 * is only ever *VERIFIED* when it matches a stored record character for
 * character, and no server lookup ever substitutes an ambiguous glyph. This
 * module runs only after the camera has admitted it could not resolve one
 * position, and it produces a suggestion a human must tap. The search primitive
 * is the one the inventory screen already uses (`list_vehicles`), so no new
 * read path and no new privilege appears.
 */
import { api } from "@/lib/api";
import { canonicalizePlate } from "@/lib/plate";
import { glyphsConfusable } from "./local/grammar";
import {
  briefOf,
  type ScannedKey,
  type ScannedVehicleBrief,
} from "./recognition";
import type { Vehicle } from "@/types";

const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

export type NearMatch = {
  field: ScannedKey;
  vehicle: ScannedVehicleBrief;
  /** Compact position where the record and this read disagree. */
  position: number;
  readGlyph: string;
  storedGlyph: string;
  matched: number;
  total: number;
};

/**
 * Compact position → index in the displayed string, so a separator inserted by
 * canonicalization (`59B1-234.56`) cannot move a cut one character too early.
 */
function displayIndex(value: string, position: number): number {
  let seen = 0;
  for (let index = 0; index < value.length; index++) {
    if (!/[A-Z0-9]/i.test(value[index])) continue;
    if (seen === position) return index;
    seen++;
  }
  return value.length;
}

/**
 * The longest part of the read the camera is sure about, trimmed of dangling
 * separators. Which side wins depends on where the doubt sits: a CRM plate is
 * stored in the same canonical punctuation the read produced, so a prefix is a
 * literal match; a chassis stamp is stored with arbitrary dashes, so a clean
 * run that survives as a substring is the one that has to win. When neither is
 * long enough to search, nothing is suggested — an absent hint beats a guess.
 */
export function searchToken(
  field: ScannedKey,
  value: string,
  disputed: readonly number[],
): string {
  const trim = (part: string) =>
    part.replace(/^[.\-\s]+/, "").replace(/[.\-\s]+$/, "");
  if (!disputed.length) return trim(value);
  const first = displayIndex(value, Math.min(...disputed));
  const last = displayIndex(value, Math.max(...disputed));
  const prefix = trim(value.slice(0, first));
  const suffix = trim(value.slice(last + 1));
  // A tie goes to the plate's punctuation-stable prefix and to the stamp's
  // digit tail, so the same read always asks the same question.
  if (field === "license_plate") return prefix.length >= suffix.length ? prefix : suffix;
  return prefix.length > suffix.length ? prefix : suffix;
}

/** Rows whose compact identifier differs from the read at one sure position. */
export function rankNearMatches(
  field: ScannedKey,
  value: string,
  disputed: readonly number[],
  rows: readonly Vehicle[],
): NearMatch[] {
  const wanted = compact(field === "license_plate" ? canonicalizePlate(value) : value);
  const unsure = new Set(disputed);
  const seen = new Set<string>();
  const matches: NearMatch[] = [];
  for (const row of rows) {
    const stored = compact(
      field === "license_plate" ? row.license_plate ?? "" : row.frame_number ?? "",
    );
    // Same length, not already equal: an exact hit is `lookupScan`'s business,
    // and a length change means characters were lost, not misread.
    if (!row.id || stored.length !== wanted.length || stored === wanted) continue;
    if (seen.has(row.id)) continue;
    const differing: number[] = [];
    for (let index = 0; index < wanted.length; index++)
      if (stored[index] !== wanted[index]) differing.push(index);
    // Exactly one disagreement, at a position the read itself flagged, and
    // only when the two glyphs are the same physical mark. Anything looser
    // would be inventing a vehicle from a coincidence.
    if (differing.length !== 1) continue;
    const [position] = differing;
    if (!unsure.has(position) || !glyphsConfusable(wanted[position], stored[position]))
      continue;
    seen.add(row.id);
    matches.push({
      field,
      vehicle: briefOf(row),
      position,
      readGlyph: wanted[position],
      storedGlyph: stored[position],
      matched: wanted.length - 1,
      total: wanted.length,
    });
  }
  return matches.sort((a, b) => b.matched - a.matched || a.vehicle.internal_code.localeCompare(b.vehicle.internal_code));
}

/**
 * One bounded read over inventory. Fails quiet: a suggestion is a convenience,
 * and a network hiccup must never look like "this vehicle does not exist".
 */
export async function inventoryNearMatches(
  field: ScannedKey,
  value: string,
  disputed: readonly number[],
): Promise<NearMatch[]> {
  const token = searchToken(field, value, disputed);
  if (token.length < (field === "license_plate" ? 5 : 4)) return [];
  try {
    const page = await api.call<{ items?: Vehicle[] }>("list_vehicles", {
      p_filters: { search: token, limit: 25 },
    });
    return rankNearMatches(field, value, disputed, page?.items ?? []);
  } catch {
    return [];
  }
}

/** Vietnamese copy for the confirm strip — one record, or an even choice. */
export function nearMatchLabel(match: NearMatch): string {
  const label = match.field === "license_plate" ? "biển số" : "số khung";
  return `Trong kho có xe ${match.vehicle.license_plate || match.vehicle.internal_code} khớp ${match.matched}/${match.total} ký tự ${label}.`;
}
