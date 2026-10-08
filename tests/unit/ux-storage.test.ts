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
      { id: "a", vehicle_type: "Xe tay ga", license_plate: "59-B1 123.45", status: "IN_STOCK" },
      "owner",
    );
    addRecentVehicle({ id: "b", vehicle_type: "Xe số", license_plate: "29-C2 555.55" }, "staff2");
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
        { id: String(i), vehicle_type: "Xe số", frame_number: `FRAME-${i}` },
        "staff",
      );
    addRecentVehicle(
      { id: "4", vehicle_type: "Xe số", frame_number: "FRAME-4", status: "SOLD" },
      "staff",
    );
    const recent = getRecentVehicles("staff");
    expect(recent).toHaveLength(8);
    expect(recent[0]).toMatchObject({ id: "4", status: "SOLD" });
    expect(new Set(recent.map((v) => v.id)).size).toBe(8);
  });

  it("remembers structured values without storing financial defaults or passwords", () => {
    saveRecentValue("vehicle_type", " Xe tay ga ", "staff");
    saveRecentValue("vehicle_type", "xe tay ga", "staff"); // trùng không phân biệt hoa/thường, cách viết mới thắng
    saveRecentValue("color", "Đen", "staff");
    saveRecentValue("purchase_price", "82000000", "staff");
    saveRecentValue("sale_price", "90000000", "staff");
    saveRecentValue("password", "secret", "staff");
    expect(getRecentValues("vehicle_type", "staff")).toEqual(["xe tay ga"]);
    expect(getRecentValues("color", "staff")).toEqual(["Đen"]);
    expect(getRecentValues("vehicle_type", "owner")).toEqual([]);
    // Hãng / Dòng xe không còn là ô nào của hồ sơ xe nên cũng không được nhớ.
    saveRecentValue("brand", " Honda ", "staff");
    saveRecentValue("model:honda", "Vision", "staff");
    expect(getRecentValues("brand", "staff")).toEqual([]);
    expect(getRecentValues("model:honda", "staff")).toEqual([]);
    expect([...data.values()].join(" ")).not.toContain("Vision");
    expect([...data.values()].join(" ")).not.toContain("Honda");
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
  it("ranks colour suggestions by user recency then store frequency", () => {
    const vehicles = [
      { color: "Đen" },
      { color: "Đen" },
      { color: "Trắng" },
      { color: "Xanh" },
    ] as Vehicle[];
    expect(vehicleSuggestions(vehicles, "color")).toEqual(["Đen", "Trắng", "Xanh"]);
    saveRecentValue("color", "Xanh", "staff");
    expect(vehicleSuggestions(vehicles, "color", "staff")).toEqual(["Xanh", "Đen", "Trắng"]);
    // Gợi ý đã học theo người dùng, không rò sang tài khoản khác.
    expect(vehicleSuggestions(vehicles, "color", "owner")).toEqual(["Đen", "Trắng", "Xanh"]);
    // Loại xe lấy từ danh mục `vehicle_types` (bộ chọn riêng), không suy ra
    // từ dữ liệu cũ nên kho xe không thể sinh ra tên hãng/dòng nào.
    expect(vehicleSuggestions(vehicles, "color", "staff")).not.toContain("Honda");
  });

  it("restores full business drafts while excluding status, identity numbers and secrets", () => {
    const values = {
      frame_number: "FRAME-1",
      license_plate: "59-B1 123.45",
      vehicle_type_id: "type-ga",
      color: "Đen",
      year: 2024,
      notes: "Giấy tờ đầy đủ",
      customer_name: "Test personal name",
      customer_phone: "0900000001",
      seller_name: "Test seller",
      seller_phone: "0900000002",
      supplier_name: "Test supplier",
      supplier_phone: "0900000003",
      identity_number: "123456789012",
      purchase_price: 82000000,
      sale_price: 88000000,
      initial_payment: 10000000,
      status: "SOLD",
      role: "OWNER",
      password: "secret",
      // Sáu trường đã bị xoá vĩnh viễn (08/10/2026): dù có lọt vào values
      // cũng không được lưu, không được nạp lại vào form.
      brand: "Honda",
      model: "Vision",
      variant: "ABS",
      engine_number: "KF30E-7412345",
      odometer: 500,
      asking_price: 91234567,
    };
    expect(draftFields(values)).toEqual({
      frame_number: "FRAME-1",
      license_plate: "59-B1 123.45",
      vehicle_type_id: "type-ga",
      color: "Đen",
      year: 2024,
      notes: "Giấy tờ đầy đủ",
      customer_name: "Test personal name",
      customer_phone: "0900000001",
      seller_name: "Test seller",
      seller_phone: "0900000002",
      supplier_name: "Test supplier",
      supplier_phone: "0900000003",
      purchase_price: 82000000,
      sale_price: 88000000,
      initial_payment: 10000000,
    });
    expect(saveFormDraft("acquisition", "staff", values)).toBe(true);
    const stored = [...data.values()].join(" ");
    for (const secret of ["123456789012", "secret", "SOLD", "OWNER"])
      expect(stored).not.toContain(secret);
    for (const purged of ["Honda", "Vision", "ABS", "KF30E-7412345", "91234567"])
      expect(stored).not.toContain(purged);
    expect(readFormDraft("acquisition", "staff")).toEqual(draftFields(values));
    expect(readFormDraft("acquisition", "owner")).toBeNull();
    clearFormDraft("acquisition", "staff");
    expect(readFormDraft("acquisition", "staff")).toBeNull();
  });

  it("expires old drafts and handles unavailable/corrupt local storage without blocking work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    saveFormDraft("acquisition", "staff", { vehicle_type_id: "type-ga" });
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
    expect(readFormDraft("acquisition", "staff")).toBeNull();
    data.set("xe_crm_ux_v3:staff:vehicles", "malformed");
    expect(getRecentVehicles("staff")).toEqual([]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(saveFormDraft("acquisition", "staff", { vehicle_type_id: "type-ga" })).toBe(
      false,
    );
    expect(() => addRecentVehicle({ id: "safe" }, "staff")).not.toThrow();
    expect(getRecentVehicles("staff")).toEqual([]);
  });
  it("ignores pre-purge storage keys instead of reviving dropped fields", () => {
    // Khoá cũ (ux_v2/draft_v1) chứa Hãng/Dòng/Số máy/Số km/Giá dự kiến. Sau
    // 08/10/2026 các ô đó không còn, nên bản nháp cũ phải bị bỏ hẳn.
    data.set(
      "xe_crm_draft_v1:staff:acquisition",
      JSON.stringify({
        savedAt: Date.now(),
        fields: { brand: "Honda", model: "Vision", odometer: 500, asking_price: 90000000 },
      }),
    );
    data.set(
      "xe_crm_ux_v2:staff:values:brand",
      JSON.stringify(["Honda"]),
    );
    expect(readFormDraft("acquisition", "staff")).toBeNull();
    expect(getRecentValues("brand", "staff")).toEqual([]);
  });
  it("scrubs non-draft fields from legacy drafts on access without extending expiry", () => {
    const savedAt = Date.now() - 1000;
    data.set("xe_crm_draft_v2:staff:sale", JSON.stringify({ savedAt, fields: {
      sale_date: "2026-10-05", customer_name: "Test buyer", brand: "Honda", identity_number: "123456789012", status: "SOLD", password: "secret",
    } }));
    expect(readFormDraft("sale", "staff")).toEqual({ sale_date: "2026-10-05", customer_name: "Test buyer" });
    expect(JSON.parse(data.get("xe_crm_draft_v2:staff:sale")!)).toEqual({ savedAt, fields: { sale_date: "2026-10-05", customer_name: "Test buyer" } });
  });
});
