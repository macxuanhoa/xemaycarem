/**
 * CRM identity lookup for the Smart Camera. Reads go through the same
 * RLS-guarded `list_vehicles` RPC every other screen uses — the camera never
 * gets a wider view of the inventory than the signed-in role already has.
 *
 * `list_vehicles` matches `search` as a substring, so candidates are filtered
 * again with the exact canonical comparison from `recognition.ts`.
 */
import { api } from "@/lib/api";
import { canonicalizePlate } from "@/lib/plate";
import { filterExactMatches, type ScannedFields, type VehicleMatch, matchIdentity } from "./recognition";
import type { Paged, Vehicle } from "@/types";

async function searchVehicles(query: string): Promise<Vehicle[]> {
  if (!query.trim()) return [];
  const page = await api.call<Paged<Vehicle>>("list_vehicles", {
    p_filters: { search: query.trim(), limit: 25 },
  });
  return page.items ?? [];
}

/**
 * Look the scanned identifiers up securely. Plates can be stored with or
 * without separators in older rows, so when the canonical query finds nothing
 * we retry once with the bare serial digits before concluding "unknown".
 */
export async function lookupScan(fields: ScannedFields): Promise<VehicleMatch> {
  let plateRows: Vehicle[] = [];
  if (fields.license_plate) {
    const canonical = canonicalizePlate(fields.license_plate);
    plateRows = await searchVehicles(canonical);
    if (!plateRows.length) {
      const digits = canonical.replace(/[^0-9]/g, "");
      if (digits.length >= 4) plateRows = await searchVehicles(digits);
    }
  }
  const frameRows = fields.frame_number ? await searchVehicles(fields.frame_number) : [];
  return matchIdentity(
    fields,
    filterExactMatches(plateRows, "license_plate", fields.license_plate),
    filterExactMatches(frameRows, "frame_number", fields.frame_number),
  );
}
