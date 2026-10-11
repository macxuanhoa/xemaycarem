export interface RecentVehicleItem {
  id: string;
  /** Tên loại xe trong danh mục — không còn hãng/dòng xe. */
  vehicle_type?: string;
  internal_code?: string;
  frame_number?: string;
  license_plate?: string;
  status: string;
  updated_at: number;
}

// v3: bản nháp xe cũ lưu Hãng/Dòng xe/Số máy/Số km/Giá dự kiến — nay các trường đó
// không còn nữa, đổi khoá để chúng bị loại thay vì nạp lại vào form mới.
const PREFIX = "xe_crm_ux_v3";
const MAX_RECENT_VEHICLES = 8;

function key(category: string, userId?: string) {
  return userId ? `${PREFIX}:${userId}:${category}` : null;
}

function read(category: string, userId?: string): unknown {
  const storageKey = key(category, userId);
  if (!storageKey) return null;
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? "null");
  } catch {
    return null;
  }
}

function write(category: string, value: unknown, userId?: string) {
  const storageKey = key(category, userId);
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Convenience storage must never prevent a server-confirmed operation.
  }
}

export function getRecentVehicles(userId?: string): RecentVehicleItem[] {
  const raw = read("vehicles", userId);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is RecentVehicleItem =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.status === "string" &&
        Number.isFinite(item.updated_at),
    )
    .slice(0, MAX_RECENT_VEHICLES);
}

export function addRecentVehicle(
  vehicle: {
    id: string;
    vehicle_type?: string | null;
    internal_code?: string;
    frame_number?: string;
    license_plate?: string;
    status?: string;
  },
  userId?: string,
): void {
  if (!vehicle.id || !userId) return;
  const existing = getRecentVehicles(userId).filter(
    (item) => item.id !== vehicle.id,
  );
  const updated: RecentVehicleItem = {
    id: vehicle.id,
    vehicle_type: vehicle.vehicle_type || undefined,
    internal_code: vehicle.internal_code,
    frame_number: vehicle.frame_number,
    license_plate: vehicle.license_plate,
    status: vehicle.status || "IN_STOCK",
    updated_at: Date.now(),
  };
  write(
    "vehicles",
    [updated, ...existing].slice(0, MAX_RECENT_VEHICLES),
    userId,
  );
}

export function removeRecentVehicle(id: string, userId?: string): void {
  write(
    "vehicles",
    getRecentVehicles(userId).filter((item) => item.id !== id),
    userId,
  );
}

export function clearRecentVehicles(userId?: string): void {
  const storageKey = key("vehicles", userId);
  if (!storageKey) return;
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* Optional storage. */
  }
}

function safeCategory(category: string) {
  return /^(vehicle_type|color|payment_method)$/.test(
    category,
  );
}

export function getRecentValues(category: string, userId?: string): string[] {
  if (!safeCategory(category)) return [];
  const raw = read(`values:${category}`, userId);
  return Array.isArray(raw)
    ? raw
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length <= 250,
        )
        .slice(0, 6)
    : [];
}

export function saveRecentValue(
  category: string,
  value: string,
  userId?: string,
): void {
  const trimmed = value.trim();
  if (!safeCategory(category) || !trimmed || trimmed.length > 250) return;
  const existing = getRecentValues(category, userId).filter(
    (v) => v.toLowerCase() !== trimmed.toLowerCase(),
  );
  write(`values:${category}`, [trimmed, ...existing].slice(0, 6), userId);
}

export function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return "Vừa xong";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? "Hôm qua" : `${diffDays} ngày trước`;
}
