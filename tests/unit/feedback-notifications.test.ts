import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissAnnouncement,
  isDismissed,
} from "@/lib/announcements";
import type { Announcement } from "@/types";

const make = (over: Partial<Announcement> = {}): Announcement => ({
  id: "a-1",
  title: null,
  message: "Cửa hàng nghỉ Tết",
  type: "INFO",
  display_mode: "STATIC",
  starts_at: null,
  ends_at: null,
  dismissible: true,
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("System announcement dismissal", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    });
  });

  it("ignores dismissal for non-dismissible announcements", () => {
    const pinned = make({ dismissible: false });
    dismissAnnouncement(pinned);
    expect(isDismissed(pinned)).toBe(false);
  });

  it("records a dismissal keyed by announcement id and version", () => {
    const a = make();
    expect(isDismissed(a)).toBe(false);
    dismissAnnouncement(a);
    expect(isDismissed(a)).toBe(true);
  });

  it("re-surfaces when the announcement is edited (new updated_at)", () => {
    const a = make();
    dismissAnnouncement(a);
    const edited = make({ updated_at: "2026-02-02T00:00:00Z" });
    expect(isDismissed(edited)).toBe(false);
  });
});
