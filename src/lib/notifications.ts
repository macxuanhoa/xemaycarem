import type { NotificationGroup, NotificationItem } from "@/types";

/**
 * Pure display helpers for the business bell. Copy is rendered server-side;
 * this module only groups and formats timestamps for the panel. Everything is
 * computed in the store's timezone (Asia/Ho_Chi_Minh), matching the rest of
 * the app's day boundaries.
 */

const TZ = "Asia/Ho_Chi_Minh";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Badge text for an unread count; null hides the badge entirely. */
export const UNREAD_BADGE_CAP = 99;
export function badgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(count);
}

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayKey = (date: Date) => dayKeyFormatter.format(date);

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
});
// vi-VN ICU patterns render dd-MM; the panel convention is slashed dd/MM,
// so build it from the numeric parts instead of trusting the locale output.
const shortDate = (date: Date) => {
  const parts = partsFormatter.formatToParts(date);
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${day}/${month}`;
};

/** Facebook-style section bucket: Vừa xong / Hôm nay / Hôm qua / dd/MM(/yyyy).
 *  "Vừa xong" reads cleaner than the southern-only "Nãy" and mirrors the
 *  row-level `relativeTime()` wording for the freshest items. */
export function groupLabel(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (now.getTime() - then.getTime() < 15 * MINUTE) return "Vừa xong";
  const key = dayKey(then);
  if (key === dayKey(now)) return "Hôm nay";
  if (key === dayKey(new Date(now.getTime() - DAY))) return "Hôm qua";
  const year = key.slice(0, 4);
  return year === dayKey(now).slice(0, 4) ? shortDate(then) : `${shortDate(then)}/${year}`;
}

/** Short timestamp under each row: Vừa xong / X phút trước / X giờ trước / date. */
export function relativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const diff = Math.max(0, now.getTime() - then.getTime());
  if (diff < MINUTE) return "Vừa xong";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} phút trước`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} giờ trước`;
  const key = dayKey(then);
  if (key === dayKey(now)) return "Hôm nay";
  if (key === dayKey(new Date(now.getTime() - DAY))) return "Hôm qua";
  const days = Math.floor(diff / DAY);
  if (days < 7) return `${days} ngày trước`;
  const year = key.slice(0, 4);
  return year === dayKey(now).slice(0, 4) ? shortDate(then) : `${shortDate(then)}/${year}`;
}

/** Buckets an already-sorted (newest first) list into renderable groups. */
export function groupNotifications(
  items: NotificationItem[],
  now = new Date(),
): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  for (const item of items) {
    const label = groupLabel(item.created_at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Labels that count as "today": the freshest bucket plus the day bucket. */
const TODAY_LABELS = new Set(["Vừa xong", "Hôm nay"]);

/**
 * Guarantees the panel always leads with a "Hôm nay" section. When no
 * notification was created today an empty group is prepended, so the UI can
 * show a "chưa có" hint instead of jumping straight to "Hôm qua".
 */
export function withTodayGroup(
  groups: NotificationGroup[],
): NotificationGroup[] {
  if (groups.some((group) => TODAY_LABELS.has(group.label))) return groups;
  return [{ label: "Hôm nay", items: [] }, ...groups];
}

/**
 * Biển số xe máy Việt Nam ở các dạng hiển thị mà hệ thống sinh ra:
 * `92D1-746.75` (dấu mới), `29A1-1234` (serial 4 số), `43A1-99999` (kiểu cũ
 * `BS …`). Yêu cầu 2 số tỉnh + 1–2 chữ + 1 số series rồi tới dãy serial, nên
 * tiền tệ (`25.000.000`) hay mã nội bộ (`XE-0042`) không khớp được.
 */
const PLATE_RE = /\b\d{2}[A-Z]{1,2}\d[-.\s]?\d{3}(?:[-.\s]?\d{1,3})?\b/;

/**
 * Tách biển số khỏi tiêu đề thông báo để UI nổi bật danh tính chiếc xe — chủ
 * quán nhìn là biết ngay xe nào thay vì phải đọc cả câu. Server đã ưu tiên
 * "biển số · số khung"; ở đây chỉ việc bóc phần biển số ra gắn chip. Trả về
 * plate = null khi tiêu đề không chứa biển số nhận dạng được (ví dụ xe chưa có
 * biển/khung, chỉ còn mã nội bộ) — khi đó UI hiển thị nguyên văn.
 */
export function splitVehicleIdentity(title: string): {
  before: string;
  plate: string | null;
  after: string;
} {
  const m = title.match(PLATE_RE);
  if (!m || m.index === undefined) return { before: title, plate: null, after: "" };
  return {
    before: title.slice(0, m.index),
    plate: m[0],
    after: title.slice(m.index + m[0].length),
  };
}
