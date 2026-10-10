import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannedVehicleBrief } from "../../src/lib/smartcam/recognition";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { call } }));

import {
  lookupIdentityDocument,
  normalizeIdentityNumber,
} from "../../src/lib/smartcam/lookup";

const vehicle = (id: string, status = "IN_STOCK"): ScannedVehicleBrief => ({
  id,
  internal_code: "XE-TEST",
  license_plate: "59A1-234.56",
  frame_number: "RLH12345678901234",
  vehicle_type: "Xe tay ga",
  status,
});

beforeEach(() => {
  call.mockReset();
});

describe("camera CCCD lookup", () => {
  it("accepts a whole 12-digit identity with simple OCR separators", () => {
    expect(normalizeIdentityNumber("079123456789")).toBe("079123456789");
    expect(normalizeIdentityNumber(" 079-123.456 789 ")).toBe("079123456789");
  });

  it.each([
    "",
    "07912345678",
    "0791234567890",
    "O79123456789",
    "CCCD: 079123456789",
    "079123/456789",
  ])("never queries a partial or guessed identity: %s", async (input) => {
    expect(normalizeIdentityNumber(input)).toBeNull();
    await expect(lookupIdentityDocument(input)).rejects.toThrow("12 chữ số");
    expect(call).not.toHaveBeenCalled();
  });

  it("makes one read-only exact lookup and resolves a unique in-stock vehicle", async () => {
    call.mockResolvedValue([vehicle("a")]);
    await expect(lookupIdentityDocument("079 123.456.789")).resolves.toEqual({
      state: "unique",
      vehicle: vehicle("a"),
    });
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "lookup_identity_document_vehicles",
      {
        p_id_number: "079123456789",
      },
    );
  });

  it("requires a selection for multiple vehicle matches and deduplicates repeated links", async () => {
    call.mockResolvedValue([
      vehicle("a"),
      vehicle("b", "RESERVED"),
      vehicle("a"),
    ]);
    await expect(lookupIdentityDocument("079123456789")).resolves.toEqual({
      state: "ambiguous",
      candidates: [vehicle("a"), vehicle("b", "RESERVED")],
    });
  });

  it("has no result for absent, sold or cancelled vehicles", async () => {
    call.mockResolvedValue([vehicle("a", "SOLD"), vehicle("b", "CANCELLED")]);
    await expect(lookupIdentityDocument("079123456789")).resolves.toEqual({
      state: "none",
    });
    call.mockResolvedValue([]);
    await expect(lookupIdentityDocument("079123456789")).resolves.toEqual({
      state: "none",
    });
  });

  it("keeps a server access denial as an error rather than claiming no match", async () => {
    call.mockRejectedValue(new Error("ACCESS_DENIED"));
    await expect(lookupIdentityDocument("079123456789")).rejects.toThrow(
      "ACCESS_DENIED",
    );
  });
});
