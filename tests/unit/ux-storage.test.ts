import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRecentVehicle,
  clearRecentVehicles,
  getLastExpense,
  getRecentValues,
  getRecentVehicles,
  saveLastExpense,
  saveRecentValue,
} from "@/lib/recentVehicles";
import {
  clearFormDraft,
  draftFields,
  readFormDraft,
  saveFormDraft,
} from "@/lib/formDrafts";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import type { Vehicle } from "@/types";

describe("User-scoped convenience storage", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("isolates recent vehicles on shared devices, ignores unscoped legacy storage", () => {
    data.set(
      "xe_crm_recent_vehicles",
      JSON.stringify([{ id: "legacy-secret" }]),
    );
    addRecentVehicle(
      { id: "a", brand: "Honda", model: "Vision", status: "IN_STOCK" },
      "owner",
    );
    addRecentVehicle({ id: "b", brand: "Yamaha", model: "Grande" }, "staff2");
    expect(getRecentVehicles("owner").map((v) => v.id)).toEqual(["a"]);
    expect(getRecentVehicles("staff2").map((v) => v.id)).toEqual(["b"]);
    expect(getRecentVehicles()).toEqual([]);
    clearRecentVehicles("owner");
    expect(getRecentVehicles("owner")).toEqual([]);
    expect(getRecentVehicles("staff2")).toHaveLength(1);
  });

  it("updates actual visits and keeps only the eight newest unique vehicles", () => {
    for (let i = 0; i < 10; i++)
      addRecentVehicle(
        { id: String(i), brand: "Honda", model: "Wave" },
        "staff",
      );
    addRecentVehicle(
      { id: "4", brand: "Honda", model: "Wave", status: "SOLD" },
      "staff",
    );
    const recent = getRecentVehicles("staff");
    expect(recent).toHaveLength(8);
    expect(recent[0]).toMatchObject({ id: "4", status: "SOLD" });
    expect(new Set(recent.map((v) => v.id)).size).toBe(8);
  });

  it("remembers structured values without storing financial defaults or passwords", () => {
    saveRecentValue("brand", " Honda ", "staff");
    saveRecentValue("brand", "honda", "staff");
    saveRecentValue("model:honda", "Vision", "staff");
    saveRecentValue("purchase_price", "82000000", "staff");
    saveRecentValue("sale_price", "90000000", "staff");
    saveRecentValue("password", "secret", "staff");
    expect(getRecentValues("brand", "staff")).toEqual(["honda"]);
    expect(getRecentValues("model:honda", "staff")).toEqual(["Vision"]);
    expect(getRecentValues("brand", "owner")).toEqual([]);
    expect([...data.values()].join(" ")).not.toContain("82000000");
    expect([...data.values()].join(" ")).not.toContain("90000000");
    expect([...data.values()].join(" ")).not.toContain("secret");
  });

  it("repeats only safe expense text, requiring a newly entered amount", () => {
    saveLastExpense(
      { type: "CLEANING", description: "Rửa xe", amount: 200000 } as {
        type: string;
        description: string;
      },
      "owner",
    );
    expect(getLastExpense("owner")).toMatchObject({
      type: "CLEANING",
      description: "Rửa xe",
    });
    expect(getLastExpense("owner")).not.toHaveProperty("amount");
    expect(getLastExpense("staff")).toBeNull();
    expect([...data.values()].join(" ")).not.toContain("200000");
  });
  it("ranks store-derived suggestions by user recency/frequency and selected brand", () => {
    const vehicles = [
      { brand: "Honda", model: "Vision" },
      { brand: "Honda", model: "Vision" },
      { brand: "Honda", model: "SH" },
      { brand: "Yamaha", model: "Grande" },
    ] as Vehicle[];
    expect(vehicleSuggestions(vehicles, "model", "staff", "Honda")).toEqual([
      "Vision",
      "SH",
    ]);
    saveRecentValue("model:honda", "SH", "staff");
    expect(vehicleSuggestions(vehicles, "model", "staff", "Honda")).toEqual([
      "SH",
      "Vision",
    ]);
    expect(vehicleSuggestions(vehicles, "model", "other", "Honda")).toEqual([
      "Vision",
      "SH",
    ]);
    expect(vehicleSuggestions(vehicles, "model", "staff", "Yamaha")).toEqual([
      "Grande",
    ]);
  });

  it("whitelists draft text and excludes money, lifecycle status, permissions and secrets", () => {
    const values = {
      frame_number: "FRAME-1",
      brand: "Honda",
      model: "Vision",
      year: 2024,
      odometer: 500,
      notes: "Giấy tờ đầy đủ",
      purchase_price: 82000000,
      asking_price: 90000000,
      sale_price: 88000000,
      initial_payment: 10000000,
      status: "SOLD",
      role: "OWNER",
      password: "secret",
    };
    expect(draftFields(values)).toEqual({
      frame_number: "FRAME-1",
      brand: "Honda",
      model: "Vision",
      year: 2024,
      odometer: 500,
      notes: "Giấy tờ đầy đủ",
    });
    expect(saveFormDraft("acquisition", "staff", values)).toBe(true);
    expect(readFormDraft("acquisition", "staff")).toEqual(draftFields(values));
    expect(readFormDraft("acquisition", "owner")).toBeNull();
    clearFormDraft("acquisition", "staff");
    expect(readFormDraft("acquisition", "staff")).toBeNull();
  });

  it("expires old drafts and handles unavailable/corrupt local storage without blocking work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    saveFormDraft("acquisition", "staff", { brand: "Honda" });
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
    expect(readFormDraft("acquisition", "staff")).toBeNull();
    data.set("xe_crm_ux_v2:staff:vehicles", "malformed");
    expect(getRecentVehicles("staff")).toEqual([]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(saveFormDraft("acquisition", "staff", { brand: "Honda" })).toBe(
      false,
    );
    expect(() => addRecentVehicle({ id: "safe" }, "staff")).not.toThrow();
    expect(getRecentVehicles("staff")).toEqual([]);
  });
});
