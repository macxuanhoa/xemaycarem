/**
 * Post-save photo handoff. The intake batch still writes through the existing
 * confirmed `import_vehicles` RPC — and that RPC returns `vehicle_ids` aligned
 * with row order (the operation receipt stores the same result, so even a
 * reconciled replay carries them). Those server-issued ids are the only
 * trusted correlation. A substring re-search is a last-resort fallback for
 * legacy receipts and attaches a photo only when exactly one row matches the
 * entry's frame/plate exactly — never a first-hit guess under ambiguity.
 * Upload problems never affect the saved records; the page reports them
 * honestly and the gallery stays editable on the vehicle.
 */
import { api } from "@/lib/api";
import { canonicalizePlate } from "@/lib/plate";
import { alignCreatedIds } from "./correlate";
import { dataUrlToFile } from "./capture";
import type { IntakeEntry } from "@/lib/shorthand/parseIntakeNotes";
import type { Paged, Vehicle } from "@/types";

const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

export type PhotoOutcome = { uploaded: number; failed: number };

/** Exact-match re-lookup used only when the server gave no usable id. */
async function findUniqueCreatedVehicle(entry: IntakeEntry): Promise<Vehicle | null> {
  const frame = (entry.fields.frame_number ?? "").trim();
  const plate = (entry.fields.license_plate ?? "").trim();
  const query = frame || canonicalizePlate(plate);
  if (!query) return null;
  const page = await api.call<Paged<Vehicle>>("list_vehicles", {
    p_filters: { search: query, limit: 25 },
  });
  const exact = (page.items ?? []).filter((row) =>
    frame
      ? compact(row.frame_number ?? "") === compact(frame)
      : compact(canonicalizePlate(row.license_plate ?? "")) === compact(canonicalizePlate(plate)),
  );
  // Ambiguity (duplicate imports, shared plates) must never be guessed.
  return exact.length === 1 ? exact[0] : null;
}

export async function uploadEntryPhotos(entries: IntakeEntry[], createdIds?: unknown): Promise<PhotoOutcome> {
  const outcome: PhotoOutcome = { uploaded: 0, failed: 0 };
  const aligned = alignCreatedIds(entries.length, createdIds);
  for (const [index, entry] of entries.entries()) {
    if (!entry.photos?.length) continue;
    try {
      const vehicle =
        aligned[index] !== null
          ? { id: aligned[index] as string }
          : await findUniqueCreatedVehicle(entry);
      if (!vehicle) {
        outcome.failed += entry.photos.length;
        continue;
      }
      for (const [photoIndex, dataUrl] of entry.photos.entries()) {
        try {
          await api.uploadVehicleImage(vehicle.id, await dataUrlToFile(dataUrl, `camera-${photoIndex + 1}.jpg`));
          outcome.uploaded += 1;
        } catch {
          outcome.failed += 1;
        }
      }
    } catch {
      outcome.failed += entry.photos.length;
    }
  }
  return outcome;
}
