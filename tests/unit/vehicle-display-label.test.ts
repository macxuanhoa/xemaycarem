import { describe, expect, it } from "vitest";
import { displayFrame, isPlaceholderFrame } from "@/lib/frameNumber";
import { NO_FRAME_LABEL, vehicleTitle } from "@/lib/vehicleDisplay";

/**
 * Xe chưa có số khung được server lưu bằng mã placeholder `GEN-<uuid>`.
 * Mã này là chi tiết kỹ thuật — mọi màn hình phải hiện "chưa có khung",
 * khớp private.vehicle_label_text (migration 20261011000200).
 */

describe("placeholder frame helpers", () => {
  it("recognizes only the GEN- prefix as a placeholder", () => {
    expect(isPlaceholderFrame("GEN-57410906-db6")).toBe(true);
    expect(isPlaceholderFrame(" gen-a1b2c3d4e5f6")).toBe(true);
    expect(isPlaceholderFrame("RLH123456789012345")).toBe(false);
    expect(isPlaceholderFrame("GENUINE-XYZ-12345")).toBe(false);
    expect(isPlaceholderFrame("")).toBe(false);
    expect(isPlaceholderFrame(null)).toBe(false);
  });

  it("displayFrame empties placeholders but keeps real frames verbatim", () => {
    expect(displayFrame("GEN-57410906-db6")).toBe("");
    expect(displayFrame("  rlce32-p1234567 ")).toBe("rlce32-p1234567");
    expect(displayFrame(null)).toBe("");
  });
});

describe("vehicleTitle with placeholder frames", () => {
  it("shows 'chưa có khung' instead of the GEN code", () => {
    expect(
      vehicleTitle({ license_plate: "59A1-234.56", frame_number: "GEN-57410906-db6" }),
    ).toBe(`59A1-234.56 · ${NO_FRAME_LABEL}`);
  });

  it("falls back to internal code when the only data is a GEN placeholder", () => {
    const title = vehicleTitle({ frame_number: "GEN-a1b2c3d4-e5f6", internal_code: "XE-2026-000123" });
    expect(title).toBe("XE-2026-000123");
    expect(title).not.toMatch(/GEN-/i);
  });

  it("keeps a real frame untouched", () => {
    expect(
      vehicleTitle({ license_plate: "29B1-123.45", frame_number: "MH1JC1234567890" }),
    ).toBe("29B1-123.45 · MH1JC1234567890");
  });

  it("prefers the server-provided title verbatim", () => {
    expect(
      vehicleTitle({
        vehicle_title: "59A1-234.56 · chưa có khung",
        frame_number: "GEN-57410906-db6",
      }),
    ).toBe("59A1-234.56 · chưa có khung");
  });
});
