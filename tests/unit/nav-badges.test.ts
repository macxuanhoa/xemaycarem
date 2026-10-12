import { beforeEach, describe, expect, it, vi } from "vitest";

const BADGE_STORAGE_KEY = "carem_nav_seen_counts_v1";

describe("Navigation Badge Logic", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });

  function getStoredSeen(): Record<string, number> {
    const raw = localStorage.getItem(BADGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  }

  function setStoredSeen(key: string, val: number) {
    const prev = getStoredSeen();
    localStorage.setItem(BADGE_STORAGE_KEY, JSON.stringify({ ...prev, [key]: val }));
  }

  function calculateUnread(
    key: string,
    currentTotal: number,
    isQueue = false,
  ): number {
    const seen = getStoredSeen()[key];
    if (seen === undefined) {
      if (isQueue) {
        return currentTotal;
      } else {
        setStoredSeen(key, currentTotal);
        return 0;
      }
    }
    if (currentTotal < seen) {
      setStoredSeen(key, currentTotal);
      return 0;
    }
    return Math.max(0, currentTotal - seen);
  }

  it("initializes accumulating tables (vehicles, customers, acquisitions) to current count with 0 unread", () => {
    // First run with 20 vehicles
    expect(calculateUnread("vehicles", 20)).toBe(0);
    expect(getStoredSeen().vehicles).toBe(20);

    // First run with 10 customers
    expect(calculateUnread("customers", 10)).toBe(0);
    expect(getStoredSeen().customers).toBe(10);
  });

  it("jumps to 1, 2, 3 when new vehicles or customers are added", () => {
    // Initialized at 20
    calculateUnread("vehicles", 20);

    // 1 new vehicle added to inventory
    expect(calculateUnread("vehicles", 21)).toBe(1);

    // 2 more vehicles added
    expect(calculateUnread("vehicles", 23)).toBe(3);
  });

  it("clears badge (hết đỏ) when user views the section, and recounts when new items arrive", () => {
    // Initialized at 5 customers
    calculateUnread("customers", 5);

    // 2 new customers arrive
    expect(calculateUnread("customers", 7)).toBe(2);

    // User visits /customers -> markSeen
    setStoredSeen("customers", 7);
    expect(calculateUnread("customers", 7)).toBe(0);

    // Later 1 more customer arrives -> recounts to 1
    expect(calculateUnread("customers", 8)).toBe(1);
  });

  it("handles action queues (approvals, reconciliation) showing pending count until clicked", () => {
    // 2 pending approvals waiting
    expect(calculateUnread("approvals", 2, true)).toBe(2);

    // User clicks /approvals
    setStoredSeen("approvals", 2);
    expect(calculateUnread("approvals", 2, true)).toBe(0);

    // New approval arrives
    expect(calculateUnread("approvals", 3, true)).toBe(1);
  });
});
