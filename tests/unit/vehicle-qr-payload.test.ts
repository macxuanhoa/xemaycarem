import { describe, expect, it } from "vitest";
import {
  generateQrSvg,
  resolveVehicleQr,
  vehicleQrPayload,
  vehicleQrUrl,
} from "@/lib/qrcode";

const id = "12345678-1234-1234-1234-123456789abc";
describe("stable vehicle QR identity", () => {
  it("encodes only version and vehicle UUID, independent of deployment domain", async () => {
    const payload = vehicleQrPayload(id.toUpperCase());
    expect(payload).toBe(`carem:vehicle:v1:${id}`);
    expect(resolveVehicleQr(payload, "https://old-store.test")).toBe(id);
    expect(resolveVehicleQr(payload, "https://new-store.test")).toBe(id);
    expect(await generateQrSvg(payload)).toContain("<svg");
  });

  it("keeps old raw UUID and authenticated same-origin route labels readable", () => {
    expect(
      resolveVehicleQr(`  ${id.toUpperCase()}  `, "https://store.test"),
    ).toBe(id);
    expect(
      resolveVehicleQr(
        vehicleQrUrl(id, "https://store.test"),
        "https://store.test",
      ),
    ).toBe(id);
    expect(resolveVehicleQr(`/vehicles/${id}`, "https://store.test")).toBe(id);
  });

  it.each([
    `carem:vehicle:v2:${id}`,
    `carem:vehicle:v1:${id}?token=secret`,
    `carem:vehicle:v1:${id}/`,
    "carem:vehicle:v1:XE-2026-000001",
    `https://outside.test/vehicles/${id}`,
    `javascript:carem:vehicle:v1:${id}`,
    `//outside.test/vehicles/${id}`,
    `/vehicles/${id}#secret`,
  ])("rejects unsupported or foreign payloads: %s", (payload) => {
    expect(resolveVehicleQr(payload, "https://store.test")).toBeNull();
  });

  it("refuses to print a partial or non-UUID vehicle identity", () => {
    expect(() => vehicleQrPayload("XE-2026-000001")).toThrow(
      "Mã xe không hợp lệ",
    );
  });
});
