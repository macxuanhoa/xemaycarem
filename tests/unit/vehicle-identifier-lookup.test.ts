import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyScannedFields,
  type ScannedVehicleBrief,
} from "@/lib/smartcam/recognition";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { call } }));
import { lookupScan } from "@/lib/smartcam/lookup";

const vehicle = (
  id: string,
  license_plate = "59A1-234.56",
  frame_number = "RLH12345678901234",
): ScannedVehicleBrief => ({
  id,
  internal_code: `XE-${id}`,
  license_plate,
  frame_number,
  vehicle_type: "Xe tay ga",
  status: "IN_STOCK",
});
const fields = (license_plate = "", frame_number = "") => ({
  ...emptyScannedFields(),
  license_plate,
  frame_number,
});
beforeEach(() => {
  call.mockReset();
});

describe("whole-inventory exact camera lookup", () => {
  it("finds both identifiers with one dedicated read and no paginated substring fallback", async () => {
    const row = vehicle("a");
    call.mockResolvedValue({ plate_matches: [row], frame_matches: [row] });
    await expect(
      lookupScan(fields("59 a1 234.56", "rlh-12345678901234")),
    ).resolves.toEqual({ state: "unique", vehicle: row });
    expect(call).toHaveBeenCalledExactlyOnceWith("lookup_vehicle_identifiers", {
      p_license_plate: "59A1-234.56",
      p_frame_number: "RLH12345678901234",
    });
  });

  it("preserves all exact candidates instead of choosing the first 25", async () => {
    const rows = Array.from({ length: 31 }, (_, i) => vehicle(String(i)));
    call.mockResolvedValue({ plate_matches: rows, frame_matches: [] });
    await expect(lookupScan(fields("59A1-234.56"))).resolves.toEqual({
      state: "ambiguous",
      candidates: rows,
    });
  });

  it("keeps plate and chassis pointing to different vehicles as conflict", async () => {
    const plate = vehicle("a");
    const frame = vehicle("b", "30B1-555.55", "RLHOTHERFRAME555");
    call.mockResolvedValue({ plate_matches: [plate], frame_matches: [frame] });
    await expect(
      lookupScan(fields(plate.license_plate, frame.frame_number)),
    ).resolves.toEqual({ state: "conflict", candidates: [plate, frame] });
  });

  it("rejects spurious or duplicated response rows without approximate matching", async () => {
    const row = vehicle("a");
    call.mockResolvedValue({
      plate_matches: [row, row, vehicle("wrong", "59A1-234.57")],
      frame_matches: [],
    });
    await expect(lookupScan(fields("59A1-234.56"))).resolves.toEqual({
      state: "unique",
      vehicle: row,
    });
  });

  it.each([
    ["", ""],
    ["23456", ""],
    ["59A1-234.?6", ""],
    ["59A1-234.56%", ""],
    ["", "01234"],
    ["", "AB123456"],
    ["", "RLH12345?78901234"],
    ["", "GEN-12345678901234"],
    ["", "12345678901234567"],
  ])(
    "leaves incomplete or uncertain codes unresolved: %s / %s",
    async (plate, frame) => {
      await expect(lookupScan(fields(plate, frame))).resolves.toEqual({
        state: "none",
      });
      expect(call).not.toHaveBeenCalled();
    },
  );

  it("looks up a valid plate while keeping a partial chassis out of identity", async () => {
    call.mockResolvedValue({
      plate_matches: [vehicle("a")],
      frame_matches: [],
    });
    await expect(
      lookupScan(fields("59A1-234.56", "01234")),
    ).resolves.toMatchObject({ state: "unique" });
    expect(call).toHaveBeenCalledExactlyOnceWith("lookup_vehicle_identifiers", {
      p_license_plate: "59A1-234.56",
      p_frame_number: null,
    });
  });

  it("propagates denied/failed reads instead of asserting that the vehicle is new", async () => {
    call.mockRejectedValue(new Error("ACCESS_DENIED"));
    await expect(lookupScan(fields("59A1-234.56"))).rejects.toThrow(
      "ACCESS_DENIED",
    );
  });

  it("keeps malformed server responses unresolved instead of declaring a new vehicle", async () => {
    call.mockResolvedValue(null);
    await expect(lookupScan(fields("59A1-234.56"))).rejects.toThrow(
      "đối chiếu xe",
    );
    call.mockResolvedValue({ plate_matches: [] });
    await expect(lookupScan(fields("59A1-234.56"))).rejects.toThrow(
      "đối chiếu xe",
    );
  });
});
