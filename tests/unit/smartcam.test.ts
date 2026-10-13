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
  normalizeScanRisks,
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
  ...over,
});

describe("normalizeScan", () => {
  it("canonicalizes plates, uppercases codes and drops appearance fields entirely", () => {
    const scan = normalizeScan({
      license_plate: "59 a1 234.56",
      frame_number: "rlh160 kd12345",
      // Nhận diện ảnh xe đã bị xoá hẳn: mọi trường ngoại dạng bị bỏ, không lưu.
      color: "Đen",
      year: 2019,
      vehicle_type: "Honda Vision",
      // Key cũ của hợp đồng xe ảnh: cũng không còn trường nào để lưu.
      engine_number: "kf30e-99999",
      brand: "Honda",
      model: "Vision 2022",
      variant: "ABS",
      odometer: 99_999_999,
    });
    expect(scan.license_plate).toBe("59A1-234.56");
    expect(scan.frame_number).toBe("RLH160KD12345");
    for (const purged of ["color", "year", "vehicle_type", "engine_number", "brand", "model", "variant", "odometer"]) {
      expect(scan).not.toHaveProperty(purged);
    }
  });
  it("keeps only the two identifiers the camera is allowed to read", () => {
    const scan = normalizeScan({ color: "123", year: 2019, vehicle_type: "  Honda  Vision \u0000", frame_number: "  RLH160-001 " });
    expect(Object.keys(scan)).toEqual(["license_plate", "frame_number"]);
    expect(scan.frame_number).toBe("RLH160001");
  });
  it("maps uncertain compact positions onto canonical plate characters", () => {
    const scanned = normalizeScan({ license_plate: "59 a1 23456", frame_number: "RLH160KD12345" });
    expect(normalizeScanRisks({ uncertain_characters: { license_plate: [4, 7, -1, 100, "2"], frame_number: [3] } }, scanned))
      .toEqual({ license_plate: [5, 9], frame_number: [3] });
    expect(normalizeScanRisks({ riskCharacters: { license_plate: [5, 4, 5] } }, scanned))
      .toEqual({ license_plate: [5] });
  });
  it("marks malformed plate and distracting short/numeric frame text risky", () => {
    expect(normalizeScanRisks({}, normalizeScan({ license_plate: "59O1-234.5O", frame_number: "0123456789" })))
      .toEqual({ license_plate: [0, 1, 2, 3, 5, 6, 7, 9, 10], frame_number: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  });
});

describe("CRM identity resolution", () => {
  const known = vehicle({ license_plate: "59A1-234.56", frame_number: "RLH160KD12345" });
  const scanned = fields({ license_plate: "59A1-234.56", frame_number: "RLH160KD12345" });

  it("A: one exact plate match resolves to the unique existing vehicle", () => {
    const match = matchIdentity(scanned, filterExactMatches([known], "license_plate", scanned.license_plate), []);
    expect(match).toMatchObject({ state: "unique", vehicle: { id: known.id } });
    const statuses = classifyFields(scanned, match);
    expect(statuses.license_plate).toBe("VERIFIED");
    expect(statuses.frame_number).toBe("VERIFIED");
  });

  it("B: neither identifier found is the only path to 'new vehicle'", () => {
    const unknown = fields({ license_plate: "61B1-777.77", frame_number: "MH1JC1234KE5" });
    const match = matchIdentity(unknown, [], []);
    expect(match.state).toBe("none");
    expect(classifyFields(unknown, match).license_plate).toBe("SUGGESTED");
  });
  it("never verifies risky OCR characters just because a stored vehicle matches", () => {
    const match: VehicleMatch = { state: "unique", vehicle: filterExactMatches([known], "license_plate", scanned.license_plate)[0] };
    const statuses = classifyFields(scanned, match, { license_plate: [5], frame_number: [3] });
    expect(statuses.license_plate).toBe("SUGGESTED");
    expect(statuses.frame_number).toBe("SUGGESTED");
  });

  it("E: plate and frame pointing at different vehicles is a conflict, never auto-identity", () => {
    const byPlate = vehicle({ license_plate: "59A1-234.56", frame_number: "OTHER-FRAME" });
    const byFrame = vehicle({ license_plate: "30B2-888.88", frame_number: "RLH160KD12345" });
    const scannedBoth = fields({ license_plate: "59A1-234.56", frame_number: "RLH160KD12345" });
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
    const similar = vehicle({ license_plate: "59A1-234.57" });
    expect(filterExactMatches([similar], "license_plate", "59A1-234.56")).toEqual([]);
  });

  it("legacy storage without separators still matches the canonical scan", () => {
    const legacy = vehicle({ license_plate: "29A1-1234" });
    const matches = filterExactMatches([legacy], "license_plate", "29A1-1234");
    expect(matches.map((row) => row.id)).toEqual([legacy.id]);
  });

  it("several plate candidates stay ambiguous for manual verification", () => {
    const first = vehicle({ license_plate: "59A1-234.56" });
    const second = vehicle({ license_plate: "59A1-234.56" });
    const match = matchIdentity(scanned, [ { id: first.id, internal_code: "", license_plate: first.license_plate!, vehicle_type: "", frame_number: "", status: "IN_STOCK" }, { id: second.id, internal_code: "", license_plate: second.license_plate!, vehicle_type: "", frame_number: "", status: "SOLD" } ], []);
    expect(match.state).toBe("ambiguous");
    if (match.state === "ambiguous") expect(match.candidates).toHaveLength(2);
  });
});

describe("intake handoff", () => {
  const scanned = normalizeScan({
    license_plate: "59a1234.56",
    frame_number: "RLH160KD12345",
    vehicle_type: "Honda Vision",
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
    expect(entry.fields.license_plate).toBe("59A1-234.56");
    expect(entry.fields.frame_number).toBe("RLH160KD12345");
    // Nhận diện ảnh xe đã xoá hẳn: loại xe/màu/năm không bao giờ đi từ camera vào tốc ký.
    for (const purged of ["vehicle_type", "color", "year", "brand", "model", "variant", "engine_number", "odometer"]) {
      expect(entry.fields).not.toHaveProperty(purged);
    }
    // Never invents financial or customer data the camera cannot see.
    expect(entry.fields.purchase_price).toBeUndefined();
    expect(entry.fields.supplier_name).toBeUndefined();
    // Nguồn gốc camera chỉ gắn cho hai định danh còn lại.
    for (const purged of ["color", "vehicle_type", "brand", "model", "variant", "engine_number", "odometer"])
      expect(entry.provenance as Record<string, unknown>).not.toHaveProperty(purged);
    expect(entry.fieldStatus?.license_plate).toBe("SUGGESTED");
    // Cơ chế Ghi chú đã gỡ khỏi tốc ký — camera không còn nhét lời nhắn notes.
    expect(entry.fields).not.toHaveProperty("notes");
  });

  it("no beep key repeats for the same vehicle across rescans", () => {
    const unique: VehicleMatch = { state: "unique", vehicle: { id: "abc", internal_code: "", license_plate: "", vehicle_type: "", frame_number: "", status: "IN_STOCK" } };
    expect(scanTargetKey(unique, recognition.fields)).toBe("vehicle:abc");
    expect(scanTargetKey(unique, recognition.fields)).toBe(scanTargetKey(unique, recognition.fields));
    expect(scanTargetKey({ state: "none" }, fields({ license_plate: "59A1-234.56" })))
      .not.toBe(scanTargetKey({ state: "none" }, fields({ license_plate: "30B2-888.88" })));
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
    expect(restored?.fields.license_plate).toBe("59A1-234.56");
    // Images deliberately never persist to web storage.
    expect(restored?.photos).toEqual([]);
    expect(readRecognitionDraft("other-user")).toBeNull();
  });
  it("storage cannot upgrade a risky identifier into verified data", () => {
    const restored = parseRecognition({ ...recognition, riskCharacters: { license_plate: [5, 5, -1, 100, "1"] },
      statuses: { ...recognition.statuses, license_plate: "VERIFIED" } });
    expect(restored?.riskCharacters).toEqual({ license_plate: [5] });
    expect(restored?.statuses.license_plate).toBe("SUGGESTED");
  });
});

describe("intakeRows compatibility", () => {
  it("camera entries flow through the existing validation unchanged", async () => {
    const { validateIntakeEntry } = await import("@/lib/shorthand/intakeRows");
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
    // Camera không đọc loại xe -> thẻ bắt buộc nhân viên nhập tên loại xe,
    // đúng luật VEHICLE_TYPE_REQUIRED phía server.
    expect(Object.values(validateIntakeEntry(entry)).join(" ")).toMatch(/dòng xe/);
    // Giá thu là bắt buộc với mọi role khi đưa xe vào kho (2026-10-10).
    const typed = {
      ...entry,
      fields: { ...entry.fields, vehicle_type: "Xe tay ga", purchase_price: "18tr5" },
    };
    expect(validateIntakeEntry(typed)).toEqual({});
    const bad = { ...typed, fields: { ...typed.fields, license_plate: "XYZ" } };
    expect(validateIntakeEntry(bad).license_plate).toBeDefined();
  });
});
