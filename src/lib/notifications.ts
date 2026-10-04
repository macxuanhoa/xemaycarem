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

/** Facebook-style section bucket: Nãy / Hôm nay / Hôm qua / dd/MM(/yyyy). */
export function groupLabel(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (now.getTime() - then.getTime() < 15 * MINUTE) return "Nãy";
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
