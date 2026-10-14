import { describe, expect, it } from "vitest";
import {
  ACTION_ICON,
  ACTION_TONE,
  FRESH_WINDOW_MS,
  NOTIFICATION_FALLBACK_ICON,
  UNREAD_BADGE_CAP,
  badgeLabel,
  emptyGroupHint,
  groupLabel,
  groupNotifications,
  isFreshGroup,
  relativeTime,
  splitVehicleIdentity,
  withTodayGroup,
} from "@/lib/notifications";
import { Bell } from "lucide-react";
import type { NotificationAction, NotificationItem } from "@/types";

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
  it("groups anything under 15 minutes as Vừa xong", () => {
    expect(groupLabel(iso(0), NOW)).toBe("Vừa xong");
    expect(groupLabel(iso(14), NOW)).toBe("Vừa xong");
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
    expect(relativeTime(iso(20), NOW)).toBe("20 phút trước");
    expect(relativeTime(iso(125), NOW)).toBe("2 giờ trước");
    expect(relativeTime(new Date("2026-10-02T05:00:00Z").toISOString(), NOW)).toBe("2 ngày trước");
  });

  /**
   * Regression (P1): the group heading bucketed at 15 minutes while the row
   * label bucketed at 1, so a 10-minute-old row sat under "Vừa xong" and then
   * contradicted its own header by reading "10 phút trước". One constant now
   * drives both, and this pins that they can never disagree again.
   */
  it("never contradicts the group heading that contains it", () => {
    for (let minutesAgo = 0; minutesAgo < 90; minutesAgo += 1) {
      const group = groupLabel(iso(minutesAgo), NOW);
      const row = relativeTime(iso(minutesAgo), NOW);
      expect(row === "Vừa xong").toBe(group === "Vừa xong");
    }
    expect(FRESH_WINDOW_MS).toBe(15 * 60_000);
    // Boundary: the last fresh minute and the first counted minute.
    expect(relativeTime(iso(14), NOW)).toBe("Vừa xong");
    expect(relativeTime(iso(15), NOW)).toBe("15 phút trước");
  });
});

describe("isFreshGroup", () => {
  it("marks the three leading buckets as fresh", () => {
    expect(isFreshGroup("Vừa xong")).toBe(true);
    expect(isFreshGroup("Hôm nay")).toBe(true);
    expect(isFreshGroup("Hôm qua")).toBe(true);
  });
  it("leaves dated buckets unstyled", () => {
    expect(isFreshGroup("02/10")).toBe(false);
    expect(isFreshGroup("02/10/2025")).toBe(false);
  });
  it("agrees with the labels groupLabel actually produces", () => {
    for (const minutesAgo of [0, 60, 24 * 60, 30 * 24 * 60]) {
      expect(isFreshGroup(groupLabel(iso(minutesAgo), NOW))).toBe(minutesAgo <= 24 * 60);
    }
  });
});

describe("emptyGroupHint", () => {
  /**
   * Regression (P1): the hint was hard-coded to "chưa có thông báo mới", which
   * inside the "Chưa đọc" filter told staff to wait for news when in fact they
   * had simply read everything.
   */
  it("names the filter that is active", () => {
    expect(emptyGroupHint(true)).toContain("chưa đọc");
    expect(emptyGroupHint(false)).toContain("thông báo mới");
    expect(emptyGroupHint(true)).not.toBe(emptyGroupHint(false));
  });
});

describe("shared icon and tone tables", () => {
  /**
   * Regression (P2): the bell fell back to `Bell` while the page fell back to
   * `BellOff`, so one unregistered action type rendered two different icons
   * depending on where it was read. `BellOff` also reads as "notifications off".
   */
  it("uses one fallback icon for both surfaces", () => {
    expect(NOTIFICATION_FALLBACK_ICON).toBe(Bell);
  });

  it("defines an icon and a tone for every action the server can emit", () => {
    for (const action of Object.keys(ACTION_TONE) as NotificationAction[]) {
      expect(ACTION_ICON[action]).toBeDefined();
      expect(ACTION_TONE[action]).toBeDefined();
    }
  });

  it("treats the three bank states as three distinct signals", () => {
    const bank: NotificationAction[] = [
      "BANK_TRANSACTION_MATCHED",
      "BANK_TRANSACTION_REVIEW",
      "BANK_TRANSACTION_UNMATCHED",
    ];
    const icons = new Set(bank.map((action) => ACTION_ICON[action]));
    expect(icons.size).toBe(bank.length);
  });

  /**
   * Regression (P2): UNMATCHED — money landed, no reference recognised, a human
   * must reconcile it — was `neutral`, so it hid among routine "vehicle updated"
   * rows that need nobody.
   */
  it("escalates the states that need a human, not the ones that are settled", () => {
    expect(ACTION_TONE.BANK_TRANSACTION_UNMATCHED).toBe("warning");
    expect(ACTION_TONE.BANK_TRANSACTION_REVIEW).toBe("warning");
    expect(ACTION_TONE.BANK_TRANSACTION_MATCHED).toBe("success");
    expect(ACTION_TONE.UPDATE_VEHICLE).toBe("neutral");
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
    expect(groups.map((g) => g.label)).toEqual(["Vừa xong", "Hôm nay", "Hôm qua"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a"]);
    expect(groups[2].items.map((i) => i.id)).toEqual(["c"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupNotifications([], NOW)).toEqual([]);
  });
});

describe("withTodayGroup", () => {
  it("prepends an empty 'Hôm nay' group when nothing happened today", () => {
    const yesterday = new Date("2026-10-03T05:00:00Z").toISOString();
    const groups = groupNotifications([make({ created_at: yesterday })], NOW);
    expect(groups.map((g) => g.label)).toEqual(["Hôm qua"]);
    const withToday = withTodayGroup(groups);
    expect(withToday.map((g) => g.label)).toEqual(["Hôm nay", "Hôm qua"]);
    expect(withToday[0].items).toEqual([]);
  });

  it("leaves the groups untouched when a 'Hôm nay' bucket already exists", () => {
    const groups = groupNotifications([make({ created_at: iso(30) })], NOW);
    expect(groups.map((g) => g.label)).toEqual(["Hôm nay"]);
    expect(withTodayGroup(groups)).toBe(groups);
  });

  it("counts 'Vừa xong' as today so no empty header is added", () => {
    const groups = groupNotifications([make({ created_at: iso(1) })], NOW);
    expect(groups.map((g) => g.label)).toEqual(["Vừa xong"]);
    expect(withTodayGroup(groups).map((g) => g.label)).toEqual(["Vừa xong"]);
  });
});

describe("splitVehicleIdentity", () => {
  it("pulls the plate out of a plate · frame title", () => {
    expect(splitVehicleIdentity("Thu vào xe 92D1-746.75 · 4K123456")).toEqual({
      before: "Thu vào xe ",
      plate: "92D1-746.75",
      after: " · 4K123456",
    });
  });
  it("recognises legacy 4-digit and ungrouped serials", () => {
    expect(splitVehicleIdentity("Bán xe 29A1-1234 · ABC").plate).toBe("29A1-1234");
    expect(splitVehicleIdentity("BS 43A1-99999").plate).toBe("43A1-99999");
  });
  it("leaves internal codes and money untouched (no false highlight)", () => {
    expect(splitVehicleIdentity("Thu vào xe XE-0042").plate).toBeNull();
    expect(splitVehicleIdentity("Thu tiền đơn bán hàng 25.000.000 đ").plate).toBeNull();
  });
});
