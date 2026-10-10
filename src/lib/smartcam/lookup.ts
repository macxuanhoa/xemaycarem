/**
 * CRM identity lookup for the Smart Camera. Reads go through the same
 * dedicated, role-guarded exact-identifier RPC. Unlike paginated inventory
 * search, it examines every eligible vehicle and returns identity fields only.
 */
import { api } from "@/lib/api";
import { normalizePlate } from "@/lib/plate";
import { AppError } from "@/lib/errors";
import {
  type ScannedFields,
  type ScannedVehicleBrief,
  type VehicleMatch,
  matchIdentity,
} from "./recognition";

type IdentifierLookup = {
  plate_matches: ScannedVehicleBrief[];
  frame_matches: ScannedVehicleBrief[];
};

const compact = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Partial chassis fragments are leads, never an automatic vehicle identity. */
function fullFrame(value: string): string | null {
  if (!/^[A-Z0-9\s.-]+$/i.test(value) || /^\s*GEN-/i.test(value)) return null;
  const normalized = compact(value);
  return normalized.length >= 11 &&
    normalized.length <= 100 &&
    /[A-Z]/.test(normalized) &&
    /[0-9]/.test(normalized)
    ? normalized
    : null;
}

function exactBriefs(
  rows: ScannedVehicleBrief[] | undefined,
  key: "license_plate" | "frame_number",
  value: string | null,
): ScannedVehicleBrief[] {
  if (!value || !Array.isArray(rows)) return [];
  const wanted = compact(value);
  return Array.from(
    new Map(
      rows
        .filter(
          (row) =>
            row &&
            typeof row.id === "string" &&
            typeof row[key] === "string" &&
            compact(row[key]) === wanted,
        )
        .map((row) => [row.id, row]),
    ).values(),
  );
}

/**
 * One read finds both identifiers across the whole inventory. No suffix,
 * substring, wildcard or ambiguous OCR-glyph substitution is attempted.
 * Server errors propagate: a failed read must never pretend a vehicle is new.
 */
export async function lookupScan(fields: ScannedFields): Promise<VehicleMatch> {
  const plate = /^[A-Z0-9\s.-]+$/i.test(fields.license_plate)
    ? normalizePlate(fields.license_plate)
    : null;
  const frame = fullFrame(fields.frame_number);
  if (!plate && !frame) return { state: "none" };
  const result = await api.call<IdentifierLookup>(
    "lookup_vehicle_identifiers",
    {
      p_license_plate: plate,
      p_frame_number: frame,
    },
  );
  if (
    !result ||
    !Array.isArray(result.plate_matches) ||
    !Array.isArray(result.frame_matches)
  ) {
    throw new AppError("Chưa thể đối chiếu xe trong kho. Hãy thử quét lại.");
  }
  return matchIdentity(
    fields,
    exactBriefs(result?.plate_matches, "license_plate", plate),
    exactBriefs(result?.frame_matches, "frame_number", frame),
  );
}

/** Never substitute ambiguous OCR glyphs or match an incomplete CCCD number. */
export function normalizeIdentityNumber(value: string): string | null {
  if (!/^[0-9\s.-]+$/.test(value)) return null;
  const digits = value.replace(/[\s.-]/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

/**
 * Resolve a recognized CCCD through a dedicated OWNER/MANAGER-only read RPC.
 * The server matches the entire number, returns only vehicles still at the
 * store, and never sends identity-document rows or card photos to the camera.
 */
export async function lookupIdentityDocument(
  idNumber: string,
): Promise<VehicleMatch> {
  const normalized = normalizeIdentityNumber(idNumber);
  if (!normalized) {
    throw new AppError(
      "Số CCCD cần đủ 12 chữ số rõ ràng. Hãy đưa căn cước vào khung và quét lại.",
    );
  }
  const rows = await api.call<ScannedVehicleBrief[]>(
    "lookup_identity_document_vehicles",
    {
      p_id_number: normalized,
    },
  );
  const candidates = Array.from(
    new Map(
      (rows ?? [])
        .filter(
          (vehicle) =>
            vehicle.status === "IN_STOCK" || vehicle.status === "RESERVED",
        )
        .map((vehicle) => [vehicle.id, vehicle]),
    ).values(),
  );
  if (candidates.length === 1)
    return { state: "unique", vehicle: candidates[0] };
  if (candidates.length > 1) return { state: "ambiguous", candidates };
  return { state: "none" };
}
