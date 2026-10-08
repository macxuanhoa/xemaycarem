/**
 * Smart Camera recognition logic — acceptance cases A–F of the smart scan
 * spec at the pure-logic layer (device I/O lives in capture.ts and is kept
 * out of these assertions on purpose).
 */
import { describe, expect, it } from "vitest";
import {
  classifyFields,
  filterExactMatches,
  matchIdentity,
  normalizeScan,
  parseRecognition,
  readRecognitionDraft,
  recognitionToIntakeEntry,
  saveRecognitionDraft,
  scanTargetKey,
  type Recognition,
  type ScannedFields,
  type VehicleMatch,
} from "../../src/lib/smartcam/recognition";
import type { Vehicle } from "../../src/types";

const vehicle = (over: Partial<Vehicle>): Vehicle =>
  ({
    id: crypto.randomUUID(),
    internal_code: "XE-TEST-000001",
    license_plate: "",
    frame_number: "",
    vehicle_type: "Xe tay ga",
    status: "IN_STOCK",
    ...over,
  }) as Vehicle;

const fields = (over: Partial<ScannedFields> = {}): ScannedFields => ({
  license_plate: "",
  frame_number: "",
  color: "",
  year: "",
  ...over,
});

describe("normalizeScan", () => {
  it("canonicalizes plates, uppercases codes and drops implausible numbers", () => {
    const scan = normalizeScan({
      license_plate: "59 a1 234.56",
      frame_number: "rlh160 kd12345",
      color: "Đen",
      year: 1850,
      // Key cũ của hợp đồng xe ảnh: không còn trường nào để lưu, bị bỏ hẳn.
      engine_number: "kf30e-99999",
      brand: "Honda",
      model: "Vision 2022",
      variant: "ABS",
      odometer: 99_999_999,
    });
    expect(scan.license_plate).toBe("59-A1 234.56");
    expect(scan.frame_number).toBe("RLH160KD12345");
    expect(scan.color).toBe("Đen");
    // Năm ngoài khoảng 1900..2100 coi như đọc không được, không đoán.
    expect(scan.year).toBe("");
    for (const purged of ["engine_number", "brand", "model", "variant", "odometer"]) {
      expect(scan).not.toHaveProperty(purged);
    }
  });
  it("treats a digit-only colour as an artifact and keeps a plausible year", () => {
    const scan = normalizeScan({ color: "123", year: 2019, frame_number: "  RLH160-001 " });
    expect(scan.color).toBe("");
    expect(scan.year).toBe("2019");
    expect(scan.frame_number).toBe("RLH160001");
  });
});

describe("CRM identity resolution", () => {
  const known = vehicle({ license_plate: "59-A1 234.56", frame_number: "RLH160KD12345" });
  const scanned = fields({ license_plate: "59-A1 234.56", frame_number: "RLH160KD12345" });

  it("A: one exact plate match resolves to the unique existing vehicle", () => {
    const match = matchIdentity(scanned, filterExactMatches([known], "license_plate", scanned.license_plate), []);
    expect(match).toMatchObject({ state: "unique", vehicle: { id: known.id } });
    const statuses = classifyFields(scanned, match);
    expect(statuses.license_plate).toBe("VERIFIED");
    expect(statuses.frame_number).toBe("VERIFIED");
    // Ảnh chỉ đọc danh tính; màu và năm không đọc được thì UNREADABLE.
    expect(statuses.color).toBe("UNREADABLE");
    expect(statuses.year).toBe("UNREADABLE");
  });

  it("B: neither identifier found is the only path to 'new vehicle'", () => {
    const unknown = fields({ license_plate: "61-B1 777.77", frame_number: "MH1JC1234KE5" });
    const match = matchIdentity(unknown, [], []);
    expect(match.state).toBe("none");
    expect(classifyFields(unknown, match).license_plate).toBe("SUGGESTED");
  });

  it("E: plate and frame pointing at different vehicles is a conflict, never auto-identity", () => {
    const byPlate = vehicle({ license_plate: "59-A1 234.56", frame_number: "OTHER-FRAME" });
    const byFrame = vehicle({ license_plate: "30-B2 888.88", frame_number: "RLH160KD12345" });
    const scannedBoth = fields({ license_plate: "59-A1 234.56", frame_number: "RLH160KD12345" });
    const match = matchIdentity(
      scannedBoth,
      filterExactMatches([byPlate], "license_plate", scannedBoth.license_plate),
      filterExactMatches([byFrame], "frame_number", scannedBoth.frame_number),
    );
    expect(match.state).toBe("conflict");
    const statuses = classifyFields(scannedBoth, match);
    expect(statuses.license_plate).toBe("CONFLICT");
    expect(statuses.frame_number).toBe("CONFLICT");
  });

  it("substring rows that are not exact matches do not count as identity", () => {
    const similar = vehicle({ license_plate: "59-A1 234.57" });
    expect(filterExactMatches([similar], "license_plate", "59-A1 234.56")).toEqual([]);
  });

  it("legacy storage without separators still matches the canonical scan", () => {
    const legacy = vehicle({ license_plate: "29A1-1234" });
    const matches = filterExactMatches([legacy], "license_plate", "29-A1 1234");
    expect(matches.map((row) => row.id)).toEqual([legacy.id]);
  });

  it("several plate candidates stay ambiguous for manual verification", () => {
    const first = vehicle({ license_plate: "59-A1 234.56" });
    const second = vehicle({ license_plate: "59-A1 234.56" });
    const match = matchIdentity(scanned, [ { id: first.id, internal_code: "", license_plate: first.license_plate!, vehicle_type: "", frame_number: "", status: "IN_STOCK" }, { id: second.id, internal_code: "", license_plate: second.license_plate!, vehicle_type: "", frame_number: "", status: "SOLD" } ], []);
    expect(match.state).toBe("ambiguous");
    if (match.state === "ambiguous") expect(match.candidates).toHaveLength(2);
  });
});

describe("intake handoff", () => {
  const scanned = normalizeScan({
    license_plate: "59a1234.56",
    frame_number: "RLH160KD12345",
    color: "Đen",
    year: 2022,
    brand: "Honda",
    model: "Vision",
    odometer: 12500,
  });
  const noneMatch: VehicleMatch = { state: "none" };
  const recognition: Recognition = {
    version: 1,
    scannedAt: new Date().toISOString(),
    fields: scanned,
    statuses: classifyFields(scanned, noneMatch),
    match: noneMatch,
    photos: ["data:image/jpeg;base64,AAAA"],
  };
  recognition.statuses = classifyFields(recognition.fields, recognition.match);

  it("maps one normalized result onto the existing IntakeEntry shape", () => {
    const entry = recognitionToIntakeEntry(recognition, "entry-1", "2026-10-06");
    expect(entry.sourceLine).toBe("Camera thông minh");
    expect(entry.fields.purchase_date).toBe("2026-10-06");
    expect(entry.fields.license_plate).toBe("59-A1 234.56");
    expect(entry.fields.frame_number).toBe("RLH160KD12345");
    expect(entry.fields.color).toBe("Đen");
    expect(entry.fields.year).toBe("2022");
    // Trường đã bị xoá vĩnh viễn: camera không đọc và cũng không có chỗ lưu.
    for (const purged of ["brand", "model", "variant", "engine_number", "odometer"]) {
      expect(entry.fields).not.toHaveProperty(purged);
    }
    // Phân loại xe vẫn là bước của người thật: ảnh không cho ra vehicle_type.
    expect(entry.fields.vehicle_type).toBeUndefined();
    // Never invents financial or customer data the camera cannot see.
    expect(entry.fields.purchase_price).toBeUndefined();
    expect(entry.fields.supplier_name).toBeUndefined();
    expect(entry.provenance.color).toBe("camera");
    // Nguồn gốc đọc được chỉ gắn cho bốn trường còn lại.
    for (const purged of ["brand", "model", "variant", "engine_number", "odometer"])
      expect(entry.provenance as Record<string, unknown>).not.toHaveProperty(purged);
    expect(entry.fieldStatus?.license_plate).toBe("SUGGESTED");
    expect(entry.fields.notes).toContain("Chưa tìm thấy trong kho");
  });

  it("no beep key repeats for the same vehicle across rescans", () => {
    const unique: VehicleMatch = { state: "unique", vehicle: { id: "abc", internal_code: "", license_plate: "", vehicle_type: "", frame_number: "", status: "IN_STOCK" } };
    expect(scanTargetKey(unique, recognition.fields)).toBe("vehicle:abc");
    expect(scanTargetKey(unique, recognition.fields)).toBe(scanTargetKey(unique, recognition.fields));
    expect(scanTargetKey({ state: "none" }, fields({ license_plate: "59-A1 234.56" })))
      .not.toBe(scanTargetKey({ state: "none" }, fields({ license_plate: "30-B2 888.88" })));
  });

  it("router/storage payloads are strictly re-parsed; junk and price fields are dropped", () => {
    expect(parseRecognition(null)).toBeNull();
    expect(parseRecognition({ version: 2, fields: {} })).toBeNull();
    expect(parseRecognition({ version: 1, scannedAt: "x", fields: "junk", match: { state: "none" } })).toBeNull();
    const ok = parseRecognition({
      version: 1,
      scannedAt: recognition.scannedAt,
      fields: { ...recognition.fields, purchase_price: "18000000" },
      match: { state: "none" },
      photos: ["https://evil.example/x.jpg", "data:image/jpeg;base64,BBBB"],
    });
    expect(ok).not.toBeNull();
    // purchase_price is not a scannable field: normalizeScan never carries it.
    expect(ok!.fields).not.toHaveProperty("purchase_price");
    // Only inline camera images survive as approved photos.
    expect(ok!.photos).toEqual(["data:image/jpeg;base64,BBBB"]);
  });

  it("session draft keeps the result across camera↔intake switches, without photos", () => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).sessionStorage = {
      setItem: (key: string, value: string) => void store.set(key, value),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => void store.delete(key),
    };
    expect(saveRecognitionDraft("user-1", recognition)).toBe(true);
    const restored = readRecognitionDraft("user-1");
    expect(restored?.fields.license_plate).toBe("59-A1 234.56");
    // Images deliberately never persist to web storage.
    expect(restored?.photos).toEqual([]);
    expect(readRecognitionDraft("other-user")).toBeNull();
  });
});

describe("intakeRows compatibility", () => {
  it("camera entries flow through the existing validation unchanged", async () => {
    const { validateIntakeEntry } = await import("@/lib/shorthand/intakeRows");
    const TYPES = [{ id: "t-ga", name: "Xe tay ga" }];
    const scanned = normalizeScan({
      license_plate: "59-a1 234.56",
      color: "Đen",
      brand: "Honda",
      model: "Vision",
    });
    const noneMatch: VehicleMatch = { state: "none" };
    const recognition: Recognition = {
      version: 1,
      scannedAt: new Date().toISOString(),
      fields: scanned,
      statuses: classifyFields(scanned, noneMatch),
      match: noneMatch,
      photos: [],
    };
    recognition.statuses = classifyFields(recognition.fields, recognition.match);
    const entry = recognitionToIntakeEntry(recognition, "entry-2", "2026-10-06");
    // Ảnh không đọc được loại xe -> thẻ bắt buộc nhân viên chọn từ danh mục,
    // đúng luật VEHICLE_TYPE_REQUIRED phía server.
    expect(validateIntakeEntry(entry, false, TYPES).join(" ")).toMatch(/loại xe/);
    const typed = { ...entry, fields: { ...entry.fields, vehicle_type: "Xe tay ga" } };
    expect(validateIntakeEntry(typed, false, TYPES)).toEqual([]);
    const bad = { ...typed, fields: { ...typed.fields, license_plate: "XYZ" } };
    expect(validateIntakeEntry(bad, false, TYPES).length).toBeGreaterThan(0);
  });
});
