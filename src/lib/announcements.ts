import type { Announcement } from "@/types";

// Phase 1 dismissal is intentionally per-device (localStorage) keyed by the
// announcement id + its updated_at version, so an edited notice resurfaces.
const STORAGE_KEY = "carem:announcement-dismissed";

type DismissMap = Record<string, string>;

function readMap(): DismissMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DismissMap) : {};
  } catch {
    return {};
  }
}

function writeMap(map: DismissMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — dismissal simply will not persist */
  }
}

export function isDismissed(a: Announcement): boolean {
  if (!a.dismissible) return false;
  const map = readMap();
  return map[a.id] !== undefined && map[a.id] === (a.updated_at ?? "");
}

export function dismissAnnouncement(a: Announcement) {
  if (!a.dismissible) return;
  const map = readMap();
  map[a.id] = a.updated_at ?? "";
  writeMap(map);
}
