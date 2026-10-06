/**
 * Smart Camera recognition core — pure, testable logic shared by the Capture
 * page and the Shorthand Intake handoff.
 *
 * The page collects ONE normalized result from an image task (`vehicle_scan`
 * through the ai-assist edge contract) plus a secure CRM lookup, classifies
 * every field with a provenance status and hands the result to the EXISTING
 * intake workflow as an `IntakeEntry`. No parsing or save logic is duplicated:
 * validation, permissions and the confirmed `import_vehicles` RPC all keep
 * running through the paths the shorthand parser already established.
 */
import { canonicalizePlate, normalizePlate } from "@/lib/plate";
import type { IntakeEntry, IntakeFieldKey } from "@/lib/shorthand/parseIntakeNotes";
import type { Vehicle } from "@/types";

/** Provenance contract shared with the intake highlight UI (spec §3). */
export type RecognitionFieldStatus =
  | "VERIFIED" // backed by a validated identifier matched in the CRM
  | "SUGGESTED" // AI prediction — the user must confirm
  | "UNREADABLE" // the image gave no reliable value
  | "CONFLICT"; // identifiers contradict each other or CRM data

/** Identifier fields whose CRM match decides VERIFIED/CONFLICT. */
export const SCANNED_KEYS = [
  "license_plate",
  "frame_number",
  "engine_number",
  "brand",
  "model",
  "variant",
  "color",
  "year",
  "odometer",
] as const;
export type ScannedKey = (typeof SCANNED_KEYS)[number];

/** All-string shape mirrors `IntakeEntry.fields` so nothing new is invented. */
export type ScannedFields = Record<ScannedKey, string>;

export const emptyScannedFields = (): ScannedFields => ({
  license_plate: "",
  frame_number: "",
  engine_number: "",
  brand: "",
  model: "",
  variant: "",
  color: "",
  year: "",
  odometer: "",
});

/** Short identity summary kept from `list_vehicles` rows — never full records. */
export type ScannedVehicleBrief = {
  id: string;
  internal_code: string;
  license_plate: string;
  brand: string;
  model: string;
  frame_number: string;
  status: string;
};

export type VehicleMatch =
  | { state: "unique"; vehicle: ScannedVehicleBrief }
  | { state: "none" }
  | { state: "ambiguous"; candidates: ScannedVehicleBrief[] }
  | { state: "conflict"; candidates: ScannedVehicleBrief[] };

export type Recognition = {
  version: 1;
  scannedAt: string;
  fields: ScannedFields;
  statuses: Record<ScannedKey, RecognitionFieldStatus>;
  match: VehicleMatch;
  /** dataURL photos the user explicitly approved in the camera UI. */
  photos: string[];
  /** Which engine produced the read: free on-device OCR or the paid provider. */
  source?: "local" | "cloud";
};

const LIMITS: Partial<Record<ScannedKey, number>> = {
  license_plate: 30,
  frame_number: 100,
  engine_number: 100,
  brand: 80,
  model: 120,
  variant: 120,
  color: 80,
  year: 4,
  odometer: 9,
};

/** Only characters a stamped code can legitimately contain. */
const CODE_SAFE = /[^A-Z0-9]/g;

function textOf(value: unknown, key: ScannedKey): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  // Provider OCR text may smuggle control characters; strip them deliberately.
  // eslint-disable-next-line no-control-regex
  const raw = String(value).replace(/[\u0000-\u001f]/g, "").trim();
  return raw.slice(0, (LIMITS[key] ?? 120) * 2);
}

/**
 * Fold one raw ai-assist `vehicle_scan` draft into normalized strings, using
 * the same CRM rules the manual forms use: plates canonicalize through
 * `@/lib/plate`, stamped codes keep only A–Z0–9, year and odometer are range
 * checked exactly like `validateIntakeEntry`. Anything questionable degrades
 * to "" (UNREADABLE) instead of a guessed value.
 */
export function normalizeScan(draft: Record<string, unknown>): ScannedFields {
  const fields = emptyScannedFields();
  const plateRaw = textOf(draft.license_plate, "license_plate");
  if (plateRaw) {
    // Keep what the model saw even if malformed (the intake form can still
    // show it for correction), but store it in canonical form when possible.
    fields.license_plate = (normalizePlate(plateRaw) ?? plateRaw.toUpperCase()).slice(0, 30);
  }
  for (const key of ["frame_number", "engine_number"] as const) {
    fields[key] = textOf(draft[key], key).toUpperCase().replace(CODE_SAFE, "").slice(0, LIMITS[key]);
  }
  for (const key of ["brand", "model", "variant", "color"] as const) {
    const value = textOf(draft[key], key).replace(/\s+/g, " ");
    // A pure digit can never be a name — treat it as an unreadable artifact.
    fields[key] = /^\d+$/.test(value) ? "" : value.slice(0, LIMITS[key]);
  }
  const year = typeof draft.year === "number" ? draft.year : Number(textOf(draft.year, "year")) || null;
  fields.year = year != null && Number.isInteger(year) && year >= 1900 && year <= 2100 ? String(year) : "";
  const odo = typeof draft.odometer === "number" ? draft.odometer : Number(textOf(draft.odometer, "odometer").replace(/\D/g, "")) || null;
  fields.odometer = odo != null && Number.isInteger(odo) && odo >= 0 && odo <= 10_000_000 ? String(odo) : "";
  return fields;
}

const compact = (value: string) => value.toUpperCase().replace(CODE_SAFE, "");

export function briefOf(vehicle: Vehicle): ScannedVehicleBrief {
  return {
    id: vehicle.id,
    internal_code: vehicle.internal_code ?? "",
    license_plate: vehicle.license_plate ?? "",
    brand: vehicle.brand ?? "",
    model: vehicle.model ?? "",
    frame_number: vehicle.frame_number ?? "",
    status: String(vehicle.status ?? ""),
  };
}

/** Exact (not substring) match against the canonical values the CRM stores. */
export function filterExactMatches(rows: Vehicle[], field: "license_plate" | "frame_number", value: string): ScannedVehicleBrief[] {
  if (!value) return [];
  const wanted = compact(field === "license_plate" ? canonicalizePlate(value) : value);
  const seen = new Set<string>();
  const out: ScannedVehicleBrief[] = [];
  for (const row of rows) {
    const stored = compact(field === "license_plate" ? canonicalizePlate(row.license_plate ?? "") : row.frame_number ?? "");
    if (!stored || stored !== wanted || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(briefOf(row));
  }
  return out;
}

/**
 * Decide CRM identity from the two identifier lookups. An unknown vehicle is
 * only "new" when NEITHER identifier exists; plate and frame pointing at
 * different records is a conflict, never an automatic conclusion.
 */
export function matchIdentity(
  fields: ScannedFields,
  plateMatches: ScannedVehicleBrief[],
  frameMatches: ScannedVehicleBrief[],
): VehicleMatch {
  const union = new Map<string, ScannedVehicleBrief>();
  for (const row of [...plateMatches, ...frameMatches]) if (!union.has(row.id)) union.set(row.id, row);
  if (!union.size) return { state: "none" };
  const plateId = fields.license_plate && plateMatches.length === 1 ? plateMatches[0].id : "";
  const frameId = fields.frame_number && frameMatches.length === 1 ? frameMatches[0].id : "";
  if (plateId && frameId && plateId !== frameId) return { state: "conflict", candidates: [...union.values()] };
  const single = plateId || frameId;
  if (single && union.size === 1) return { state: "unique", vehicle: union.get(single)! };
  if (union.size > 1) return { state: "ambiguous", candidates: [...union.values()] };
  // One side matched a single record, the other matched several or conflicting
  // rows on the same id — still exactly one vehicle in the union.
  const only = [...union.values()][0];
  return plateMatches.length > 1 || frameMatches.length > 1
    ? { state: "ambiguous", candidates: [...union.values()] }
    : { state: "unique", vehicle: only };
}

/**
 * Per-field provenance (spec §3): identifiers confirmed against exactly one
 * CRM record are VERIFIED, contradictions are CONFLICT, everything the model
 * read stays SUGGESTED and empty values are UNREADABLE.
 */
export function classifyFields(fields: ScannedFields, match: VehicleMatch): Record<ScannedKey, RecognitionFieldStatus> {
  const statuses = {} as Record<ScannedKey, RecognitionFieldStatus>;
  for (const key of SCANNED_KEYS) statuses[key] = fields[key] ? "SUGGESTED" : "UNREADABLE";
  if (match.state === "unique") {
    if (fields.license_plate && compact(canonicalizePlate(match.vehicle.license_plate)) === compact(canonicalizePlate(fields.license_plate)))
      statuses.license_plate = "VERIFIED";
    if (fields.frame_number && compact(match.vehicle.frame_number) === compact(fields.frame_number))
      statuses.frame_number = "VERIFIED";
  }
  if (match.state === "conflict") {
    if (fields.license_plate) statuses.license_plate = "CONFLICT";
    if (fields.frame_number) statuses.frame_number = "CONFLICT";
  }
  if (match.state === "ambiguous") {
    // The identifier exists in the CRM but does not resolve to one vehicle —
    // it is a lead that must be confirmed by a human, never auto-applied.
    if (fields.license_plate && match.candidates.some((row) => compact(canonicalizePlate(row.license_plate)) === compact(canonicalizePlate(fields.license_plate))))
      statuses.license_plate = "CONFLICT";
    if (fields.frame_number && match.candidates.some((row) => compact(row.frame_number) === compact(fields.frame_number)))
      statuses.frame_number = "CONFLICT";
  }
  return statuses;
}

/** One beep per distinct target; repeated scans of the same vehicle stay quiet. */
export function scanTargetKey(match: VehicleMatch, fields: ScannedFields): string {
  if (match.state === "unique") return `vehicle:${match.vehicle.id}`;
  if (match.state === "none") return `new:${compact(fields.license_plate)}|${compact(fields.frame_number)}`;
  return `${match.state}:${match.candidates.map((row) => row.id).sort().join(",")}`;
}

/** Field keys the intake cards render, mapped 1:1 from the scan contract. */
const INTAKE_KEY: Record<ScannedKey, IntakeFieldKey> = {
  license_plate: "license_plate",
  frame_number: "frame_number",
  engine_number: "engine_number",
  brand: "brand",
  model: "model",
  variant: "variant",
  color: "color",
  year: "year",
  odometer: "odometer",
};

/**
 * Hand the single normalized result to the EXISTING shorthand intake workflow
 * as one reviewed entry. `sourceLine` documents the origin; `provenance` keeps
 * "camera" as the teach-token; `fieldStatus` drives the verify highlights.
 */
export function recognitionToIntakeEntry(
  recognition: Recognition,
  id: string,
  purchaseDate: string,
): IntakeEntry {
  const fields: Partial<Record<IntakeFieldKey, string>> = { purchase_date: purchaseDate };
  const provenance: Partial<Record<IntakeFieldKey, string>> = {};
  const fieldStatus: Partial<Record<IntakeFieldKey, RecognitionFieldStatus>> = {};
  for (const key of SCANNED_KEYS) {
    const value = recognition.fields[key];
    if (!value) continue;
    fields[INTAKE_KEY[key]] = value;
    provenance[INTAKE_KEY[key]] = "camera";
    fieldStatus[INTAKE_KEY[key]] = recognition.statuses[key];
  }
  const note =
    recognition.match.state === "none"
      ? "Chưa tìm thấy trong kho — kiểm tra lại trước khi thu."
      : "";
  if (note) fields.notes = note;
  return {
    id,
    sourceLine: "Camera thông minh",
    fields,
    provenance,
    unknownTokens: [],
    fieldStatus,
  };
}

// ---------------------------------------------------------------------------
// Draft retention across the camera ↔ intake navigation (spec §4/§G).
// Only the normalized text result is persisted — photos deliberately stay in
// memory so no image of a vehicle (or worse, a document) lingers in storage.
// ---------------------------------------------------------------------------

const DRAFT_PREFIX = "xe_crm_smartcam_v1";
const DRAFT_MAX_AGE_MS = 60 * 60 * 1000;

export function saveRecognitionDraft(userId: string | undefined, recognition: Recognition): boolean {
  if (!userId) return false;
  try {
    sessionStorage.setItem(
      `${DRAFT_PREFIX}:${userId}`,
      JSON.stringify({ savedAt: Date.now(), recognition: { ...recognition, photos: [] } }),
    );
    return true;
  } catch {
    return false; // private mode / quota — the in-memory handoff still works
  }
}

export function readRecognitionDraft(userId: string | undefined): Recognition | null {
  if (!userId) return null;
  try {
    const raw = JSON.parse(sessionStorage.getItem(`${DRAFT_PREFIX}:${userId}`) ?? "null");
    if (!raw || !Number.isFinite(raw.savedAt) || Date.now() - raw.savedAt > DRAFT_MAX_AGE_MS) return null;
    const parsed = parseRecognition(raw.recognition);
    return parsed ? { ...parsed, photos: [] } : null;
  } catch {
    return null;
  }
}

export function clearRecognitionDraft(userId: string | undefined): void {
  if (!userId) return;
  try {
    sessionStorage.removeItem(`${DRAFT_PREFIX}:${userId}`);
  } catch {
    /* Optional storage. */
  }
}

/** Strict re-validation for anything crossing a boundary (router state, storage). */
export function parseRecognition(value: unknown): Recognition | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.scannedAt !== "string") return null;
  const source = raw.fields;
  if (!source || typeof source !== "object") return null;
  const fields = normalizeScan(source as Record<string, unknown>);
  const match = raw.match as VehicleMatch | undefined;
  const states = ["unique", "none", "ambiguous", "conflict"];
  if (!match || !states.includes(match.state)) return null;
  if (match.state === "unique" && !match.vehicle?.id) return null;
  if ((match.state === "ambiguous" || match.state === "conflict") && !Array.isArray(match.candidates)) return null;
  const statuses = {} as Record<ScannedKey, RecognitionFieldStatus>;
  const given = (raw.statuses ?? {}) as Record<string, unknown>;
  for (const key of SCANNED_KEYS) {
    const status = given[key];
    statuses[key] = ["VERIFIED", "SUGGESTED", "UNREADABLE", "CONFLICT"].includes(String(status))
      ? (status as RecognitionFieldStatus)
      : fields[key]
        ? "SUGGESTED"
        : "UNREADABLE";
  }
  const photos = Array.isArray(raw.photos)
    ? raw.photos.filter((photo): photo is string => typeof photo === "string" && photo.startsWith("data:image/")).slice(0, 4)
    : [];
  const engine = raw.source === "local" || raw.source === "cloud" ? raw.source : undefined;
  return { version: 1, scannedAt: raw.scannedAt, fields, statuses, match, photos, ...(engine ? { source: engine } : {}) };
}
