import { describe, expect, it } from "vitest";
import {
  UNREAD_BADGE_CAP,
  badgeLabel,
  groupLabel,
  groupNotifications,
  relativeTime,
} from "@/lib/notifications";
import type { NotificationItem } from "@/types";

// Wall-clock instants expressed as UTC ISO. Vietnam is UTC+7 year-round (no
// DST), so these map to predictable local dates in Asia/Ho_Chi_Minh.
const NOW = new Date("2026-10-04T05:00:00Z"); // 12:00 local
const iso = (minutesAgo: number) =>
  new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const make = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: "n-1",
  action: "CREATE_SALE",
  entity_type: "sales",
  entity_id: "e-1",
  vehicle_id: null,
  title: "Bán xe",
  body: null,
  deep_link: "/sales/e-1",
  read_at: null,
  created_at: iso(1),
  actor_id: null,
  actor_name: null,
  ...over,
});

describe("notification badge", () => {
  it("hides the badge at zero or below", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-3)).toBeNull();
  });
  it("shows the raw count up to the cap", () => {
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(UNREAD_BADGE_CAP)).toBe("99");
  });
  it("caps anything above 99 as 99+", () => {
    expect(badgeLabel(100)).toBe("99+");
    expect(badgeLabel(54321)).toBe("99+");
  });
});

describe("notification time buckets", () => {
  it("groups anything under 15 minutes as Nãy", () => {
    expect(groupLabel(iso(0), NOW)).toBe("Nãy");
    expect(groupLabel(iso(14), NOW)).toBe("Nãy");
  });
  it("splits today and yesterday on Vietnam midnight, not UTC", () => {
    // 17:30Z Oct 3 is 00:30 local Oct 4: already "today" in Vietnam although
    // yesterday in UTC.
    expect(groupLabel(new Date("2026-10-03T17:30:00Z").toISOString(), NOW)).toBe("Hôm nay");
    expect(groupLabel(new Date("2026-10-03T05:00:00Z").toISOString(), NOW)).toBe("Hôm qua");
    expect(groupLabel(new Date("2026-10-02T05:00:00Z").toISOString(), NOW)).toBe("02/10");
  });
  it("falls back to dd/MM inside the year and dd/MM/yyyy across years", () => {
    expect(groupLabel(new Date("2026-09-30T05:00:00Z").toISOString(), NOW)).toBe("30/09");
    expect(groupLabel(new Date("2025-10-02T05:00:00Z").toISOString(), NOW)).toBe("02/10/2025");
  });
});

describe("notification relative time", () => {
  it("walks from Vừa xong up to days", () => {
    expect(relativeTime(iso(0), NOW)).toBe("Vừa xong");
    expect(relativeTime(iso(5), NOW)).toBe("5 phút trước");
    expect(relativeTime(iso(125), NOW)).toBe("2 giờ trước");
    expect(relativeTime(new Date("2026-10-02T05:00:00Z").toISOString(), NOW)).toBe("2 ngày trước");
  });
});

describe("groupNotifications", () => {
  it("keeps newest-first buckets contiguous without re-sorting", () => {
    const groups = groupNotifications(
      [
        make({ id: "a", created_at: iso(1) }),
        make({ id: "b", created_at: iso(30) }),
        make({ id: "c", created_at: new Date("2026-10-03T05:00:00Z").toISOString() }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["Nãy", "Hôm nay", "Hôm qua"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a"]);
    expect(groups[2].items.map((i) => i.id)).toEqual(["c"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupNotifications([], NOW)).toEqual([]);
  });
});
