import type { QueryClient } from "@tanstack/react-query";
import type { NotificationItem, NotificationList } from "@/types";

/**
 * Single place that keeps every cached notification envelope consistent when a
 * row is read.
 *
 * The bell caches one page (`NotificationList`) while the full page uses an
 * infinite query (`{ pages: NotificationList[] }`). Both live under the same
 * `["notifications", userId]` prefix so a read in one surface must show up in
 * the other immediately — which is only safe if the writer understands both
 * shapes. Naively writing a `NotificationList` over an infinite cache used to
 * corrupt the page's `pages` array.
 */

function isEnvelope(value: unknown): value is NotificationList {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as NotificationList).items) &&
    "unread_count" in (value as NotificationList)
  );
}

function isPages(value: unknown): value is { pages: NotificationList[] } {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { pages?: unknown }).pages)
  );
}

/**
 * Mark matching rows read and move the badge counter by exactly that many.
 *
 * Counter and list phải đi cùng nhau ngay tại chỗ viết: nếu chỉ sửa `items` rồi
 * để `unread_count` nguyên thì chuông báo một số, danh sách lại hiển thị số tin
 * đã đọc. Trang `/thong-bao` đánh dấu từng dòng mà không invalidate lại chuỗi
 * query, nên khi realtime chưa kết nối con số lệch đó sống trọn vòng poll dự
 * phòng (60s) — người dùng bấm đọc mà huy hiệu không nhúc nhích.
 */
function markEnvelope(
  envelope: NotificationList,
  isRead: (item: NotificationItem) => boolean,
): { envelope: NotificationList; marked: number } {
  let marked = 0;
  const items = envelope.items.map((item) => {
    if (item.read_at === null && isRead(item)) {
      marked += 1;
      return { ...item, read_at: new Date().toISOString() };
    }
    return item;
  });
  if (marked === 0) return { envelope, marked };
  return {
    envelope: {
      ...envelope,
      items,
      unread_count: Math.max(0, envelope.unread_count - marked),
    },
    marked,
  };
}

/**
 * Rewrite one cached notification query optimistically.
 *
 * `total` is never touched: it counts every row ever written for the recipient,
 * read or not, so marking rows read must not move it.
 *
 * `unread_count` is a single server-side scalar that every page of an infinite
 * query repeats verbatim. A row read on page 3 therefore has to lower the badge
 * on every page, otherwise page 1 keeps reporting the old count and the header
 * contradicts the list it sits above.
 */
export function patchNotificationsCache(
  client: QueryClient,
  userId: string | null,
  isRead: (item: NotificationItem) => boolean,
): void {
  client.setQueriesData<NotificationList | { pages: NotificationList[] }>(
    { queryKey: ["notifications", userId] },
    (old) => {
      if (!old) return old;
      if (isPages(old)) {
        const marked = old.pages.reduce(
          (sum, page) => sum + page.items.filter((item) => item.read_at === null && isRead(item)).length,
          0,
        );
        if (marked === 0) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...markEnvelope(page, isRead).envelope,
            unread_count: Math.max(0, page.unread_count - marked),
          })),
        };
      }
      if (isEnvelope(old)) return markEnvelope(old, isRead).envelope;
      return old;
    },
  );
}
