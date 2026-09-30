import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { parseCsv, parseVehiclesCsv, validateImportRows } from "@/lib/csv";
import { resolveVehicleQr, vehicleQrUrl, generateQrSvg } from "@/lib/qrcode";
import { CustomerReceipt } from "@/features/sales/CustomerReceipt";
import type { Sale } from "@/types";

describe("inventory CSV input integrity", () => {
  const row = {
    frame_number: "RLH-TEST",
    brand: "Honda",
    model: "Wave",
    purchase_date: "2026-09-30",
  };
  it("preserves Vietnamese quoted values and BOM", () => {
    expect(
      parseVehiclesCsv(
        '\uFEFFSố khung,Hãng,Dòng xe\r\nTEST,Honda,"Wave, trắng"',
      ).rawRows[0].model,
    ).toBe("Wave, trắng");
  });
  it.each(['"unfinished', 'a"b",c', '"a"x,b'])(
    "rejects malformed CSV %s",
    (value) => expect(() => parseCsv(value)).toThrow(),
  );
  it("rejects missing and duplicate mapped columns and row width", () => {
    for (const csv of [
      "brand,model\nHonda,Wave",
      "frame_number,Số khung,brand,model\nA,B,Honda,Wave",
      "frame_number,brand,model\nA,Honda",
    ])
      expect(() => parseVehiclesCsv(csv)).toThrow();
  });
  it.each(["-100", "1.5", "garbage", "1e8", "9007199254740992"])(
    "rejects money without silently changing it: %s",
    (purchase_price) => {
      expect(
        validateImportRows([{ ...row, purchase_price }], true, "2026-09-30")[0]
          .isValid,
      ).toBe(false);
    },
  );
  it("blank purchase cost remains unknown instead of zero", () => {
    const result = validateImportRows([row], false, "2026-09-30")[0];
    expect(result.isValid).toBe(true);
    expect(result.data).not.toHaveProperty("purchase_price");
  });
  it("rejects restricted financial input", () =>
    expect(
      validateImportRows(
        [{ ...row, purchase_price: "100" }],
        false,
        "2026-09-30",
      )[0].isValid,
    ).toBe(false));
  it.each([
    { purchase_date: "2026-02-30" },
    { purchase_date: "2026-10-01" },
    { year: "2024x" },
    { year: "1949" },
    { odometer: "-20" },
    { odometer: "12.5" },
  ])("validates calendar and exact integer fields %j", (fields) => {
    expect(
      validateImportRows([{ ...row, ...fields }], true, "2026-09-30")[0]
        .isValid,
    ).toBe(false);
  });
  it("detects equivalent formatted identifiers in upload", () => {
    const rows = validateImportRows(
      [
        { ...row, license_plate: "43A1-123.45" },
        { ...row, frame_number: "OTHER", license_plate: "43a1 12345" },
      ],
      true,
      "2026-09-30",
    );
    expect(rows[1].isDuplicate).toBe(true);
  });
});

describe("QR identity", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const origin = "https://store.example.test";
  it("contains only authenticated vehicle route", async () => {
    const url = vehicleQrUrl(id, origin);
    expect(url).toBe(`${origin}/vehicles/${id}`);
    expect(resolveVehicleQr(url, origin)).toBe(id);
    const svg = await generateQrSvg(url);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("token");
  });
  it.each([
    "https://evil.example/vehicles/12345678-1234-1234-1234-123456789abc",
    "/vehicles/12345678-1234-1234-1234-123456789abc?token=secret",
    "javascript:alert(1)",
    "/vehicles/not-an-id",
  ])("rejects unsafe scanned destination %s", (value) =>
    expect(resolveVehicleQr(value, origin)).toBeNull(),
  );
});

it("customer receipts exclude all internal financial data and notes", () => {
  const client = new QueryClient();
  client.setQueryData(["settings"], {
    store_name: "Cửa hàng thử nghiệm",
    phone: "0000000000",
  });
  const sale = {
    id: "sale",
    sale_code: "BAN-TEST",
    customer_name: "Khách thử nghiệm",
    sale_date: "2026-09-30",
    sale_price: 100000000,
    paid_amount: 30000000,
    remaining_amount: 70000000,
    notes: "SECRET-SALE-NOTE",
    purchase_cost_snapshot: 12345678,
    gross_profit: 87654321,
    vehicle: {
      brand: "Honda",
      model: "Wave",
      engine_number: "ENGINE-TEST",
      notes: "SECRET-VEHICLE-NOTE",
      purchase_price: 23456789,
    },
  } as Sale;
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CustomerReceipt sale={sale} onClose={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("PHIẾU BÁN XE");
  expect(html).toContain("100.000.000");
  expect(html).toContain("70.000.000");
  for (const secret of [
    "SECRET-SALE-NOTE",
    "SECRET-VEHICLE-NOTE",
    "12345678",
    "12.345.678",
    "87.654.321",
    "23.456.789",
    "Giá vốn",
    "Lợi nhuận",
  ])
    expect(html).not.toContain(secret);
});
