import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmPayment, pendingPayment, retainPayment } from "@/lib/paymentRecovery";

describe("payment request recovery", () => {
  const records = new Map<string, string>();
  beforeEach(() => {
    records.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("retains only an opaque UUID across remounts and scopes it to actor/sale", () => {
    const first = retainPayment("actor", "sale");
    expect(pendingPayment("actor", "sale")).toBe(first);
    expect(retainPayment("actor", "sale")).toBe(first);
    expect(pendingPayment("other", "sale")).toBeNull();
    expect(pendingPayment("actor", "other-sale")).toBeNull();
    expect([...records.values()]).toEqual([first]);
    confirmPayment("actor", "sale", first);
    expect(pendingPayment("actor", "sale")).toBeNull();
    expect(retainPayment("actor", "sale")).not.toBe(first);
  });
  it("does not remove a different pending transaction during confirmation", () => {
    const first = retainPayment("actor", "sale");
    confirmPayment("actor", "sale", crypto.randomUUID());
    expect(pendingPayment("actor", "sale")).toBe(first);
  });
  it("blocks submission if durable request storage is full or inaccessible", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    });
    expect(() => retainPayment("actor", "sale")).toThrow(/chưa được gửi/);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(() => pendingPayment("actor", "sale")).toThrow(/mã đối soát/);
  });
  it("does not replace a corrupted pending key with a new financial request", () => {
    vi.stubGlobal("localStorage", { getItem: () => "corrupted" });
    expect(() => retainPayment("actor", "sale")).toThrow(/mã đối soát/);
  });
});
