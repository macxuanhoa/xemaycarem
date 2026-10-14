import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { patchNotificationsCache } from "@/lib/notificationsCache";
import type { NotificationItem, NotificationList } from "@/types";

/**
 * Hợp đồng cache thông báo.
 *
 * Chuông và trang "/thong-bao" dùng HAI hình dạng dữ liệu khác nhau nhưng cùng
 * prefix `["notifications", userId]`:
 *  - chuông: `NotificationList` (một trang),
 *  - trang:  `{ pages: NotificationList[] }` (infinite query, phân trang offset).
 *
 * `unread_count` là một scalar server-side mà MỌI trang lặp lại nguyên văn, nên
 * đánh dấu đọc ở trang 3 phải trừ đếm trên tất cả các trang; `total` thì ĐẾM MỌI
 * dòng (đã đọc lẫn chưa) nên không được nhúc nhích.
 */

const USER = "u-1";
const BELL_KEY = ["notifications", USER, 8] as const;
const PAGE_KEY = ["notifications", USER, "page", false] as const;
const OTHER_KEY = ["notifications", "u-2", 8] as const;

function item(id: string, read = false): NotificationItem {
  return {
    id,
    action: "CREATE_SALE",
    entity_type: "sale",
    entity_id: `sale-${id}`,
    vehicle_id: null,
    title: `Tin ${id}`,
    body: null,
    deep_link: null,
    read_at: read ? "2026-10-14T00:00:00.000Z" : null,
    created_at: `2026-10-14T0${id.slice(-1)}:00:00.000Z`,
    actor_id: null,
    actor_name: null,
  };
}

function envelope(items: NotificationItem[], total: number, unread: number): NotificationList {
  return { items, total, unread_count: unread };
}

function pages(...pageItems: NotificationItem[][]): { pages: NotificationList[] } {
  const unread = pageItems.flat().filter((i) => i.read_at === null).length;
  return { pages: pageItems.map((it) => envelope(it, 500, unread)) };
}

describe("patchNotificationsCache — chuông (NotificationList)", () => {
  it("đánh dấu đúng tin được chọn và trừ đếm chưa đọc", () => {
    const client = new QueryClient();
    client.setQueryData(BELL_KEY, envelope([item("a"), item("b")], 500, 2));

    patchNotificationsCache(client, USER, (row) => row.id === "a");

    const out = client.getQueryData<NotificationList>(BELL_KEY)!;
    expect(out.items.map((i) => [i.id, i.read_at !== null])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(out.unread_count).toBe(1);
  });

  it("không được động vào total — tổng dòng luôn bất biến khi đánh dấu đọc", () => {
    const client = new QueryClient();
    client.setQueryData(BELL_KEY, envelope([item("a"), item("b")], 500, 2));

    patchNotificationsCache(client, USER, () => true);

    expect(client.getQueryData<NotificationList>(BELL_KEY)!.total).toBe(500);
    expect(client.getQueryData<NotificationList>(BELL_KEY)!.unread_count).toBe(0);
  });

  it("không đếm trừ hai lần với tin đã đọc từ trước", () => {
    const client = new QueryClient();
    client.setQueryData(BELL_KEY, envelope([item("a", true), item("b")], 9, 1));

    patchNotificationsCache(client, USER, () => true);

    const out = client.getQueryData<NotificationList>(BELL_KEY)!;
    expect(out.unread_count).toBe(0);
    expect(out.items[0].read_at).toBe("2026-10-14T00:00:00.000Z");
  });

  it("giữ nguyên tham chiếu cache khi không có dòng nào khớp", () => {
    const client = new QueryClient();
    const before = envelope([item("a")], 1, 1);
    client.setQueryData(BELL_KEY, before);

    patchNotificationsCache(client, USER, (row) => row.id === "khac");

    expect(client.getQueryData(BELL_KEY)).toBe(before);
  });

  it("không ghi đè lên cache của user khác", () => {
    const client = new QueryClient();
    client.setQueryData(OTHER_KEY, envelope([item("z")], 1, 1));

    patchNotificationsCache(client, USER, () => true);

    expect(client.getQueryData<NotificationList>(OTHER_KEY)!.items[0].read_at).toBeNull();
  });
});

describe("patchNotificationsCache — trang (infinite { pages })", () => {
  it("đọc ở trang 3 vẫn trừ đếm trên MỌI trang", () => {
    const client = new QueryClient();
    client.setQueryData(
      PAGE_KEY,
      pages([item("p1a"), item("p1b")], [item("p2a")], [item("p3a"), item("p3b")]),
    );

    patchNotificationsCache(client, USER, (row) => row.id === "p3a");

    const out = client.getQueryData<{ pages: NotificationList[] }>(PAGE_KEY)!;
    expect(out.pages.map((p) => p.unread_count)).toEqual([4, 4, 4]);
    expect(out.pages[2].items.map((i) => i.read_at !== null)).toEqual([true, false]);
  });

  it("không biến cache `pages` thành envelope — giữ nguyên số trang đã tải", () => {
    const client = new QueryClient();
    const before = pages([item("p1a")], [item("p2a")], [item("p3a")]);
    client.setQueryData(PAGE_KEY, before);

    patchNotificationsCache(client, USER, (row) => row.id === "p2a");

    const out = client.getQueryData<{ pages: NotificationList[] }>(PAGE_KEY)!;
    expect(Array.isArray(out.pages)).toBe(true);
    expect(out.pages).toHaveLength(3);
    expect((out as unknown as NotificationList).items).toBeUndefined();
  });

  it("trừ đúng TỔNG số dòng khớp trên tất cả các trang", () => {
    const client = new QueryClient();
    client.setQueryData(
      PAGE_KEY,
      pages([item("p1a"), item("p1b")], [item("p2a")]),
    );

    patchNotificationsCache(client, USER, () => true);

    const out = client.getQueryData<{ pages: NotificationList[] }>(PAGE_KEY)!;
    expect(out.pages.map((p) => p.unread_count)).toEqual([0, 0]);
    expect(out.pages.every((p) => p.items.every((i) => i.read_at !== null))).toBe(true);
  });

  it("đệm 0 âm: đếm chưa đọc server trả về nhỏ hơn số dòng vừa đánh dấu", () => {
    const client = new QueryClient();
    client.setQueryData(PAGE_KEY, {
      pages: [envelope([item("p1a"), item("p1b")], 2, 1)],
    });

    patchNotificationsCache(client, USER, () => true);

    expect(client.getQueryData<{ pages: NotificationList[] }>(PAGE_KEY)!.pages[0].unread_count).toBe(0);
  });

  it("giữ `total` của từng trang, không nhân/không cộng dồn", () => {
    const client = new QueryClient();
    client.setQueryData(PAGE_KEY, pages([item("p1a")], [item("p2a")]));

    patchNotificationsCache(client, USER, () => true);

    expect(client.getQueryData<{ pages: NotificationList[] }>(PAGE_KEY)!.pages.map((p) => p.total)).toEqual([500, 500]);
  });

  it("không có dòng nào khớp thì không tạo bản sao cache", () => {
    const client = new QueryClient();
    const before = pages([item("p1a")]);
    client.setQueryData(PAGE_KEY, before);

    patchNotificationsCache(client, USER, (row) => row.id === "khong-ton-tai");

    expect(client.getQueryData(PAGE_KEY)).toBe(before);
  });
});

describe("patchNotificationsCache — cùng lúc hai surface", () => {
  it("một lần đánh dấu làm mới cả chuông lẫn trang dưới cùng prefix", () => {
    const client = new QueryClient();
    client.setQueryData(BELL_KEY, envelope([item("a"), item("b")], 500, 2));
    client.setQueryData(PAGE_KEY, pages([item("a"), item("b")], [item("c")]));

    patchNotificationsCache(client, USER, (row) => row.id === "a");

    expect(client.getQueryData<NotificationList>(BELL_KEY)!.unread_count).toBe(1);
    expect(client.getQueryData<{ pages: NotificationList[] }>(PAGE_KEY)!.pages.map((p) => p.unread_count)).toEqual([2, 2]);
  });

  it("bỏ qua entry cache không nhận dạng được thay vì ném lỗi", () => {
    const client = new QueryClient();
    client.setQueryData(["notifications", USER, "kieu-khac"], { foo: "bar" });

    expect(() => patchNotificationsCache(client, USER, () => true)).not.toThrow();
    expect(client.getQueryData(["notifications", USER, "kieu-khac"])).toEqual({ foo: "bar" });
  });

  it("an toàn khi userId null (chưa đăng nhập)", () => {
    const client = new QueryClient();
    expect(() => patchNotificationsCache(client, null, () => true)).not.toThrow();
  });
});
