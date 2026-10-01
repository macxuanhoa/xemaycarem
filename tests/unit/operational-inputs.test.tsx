import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { parseCsv, parseVehiclesCsv, validateImportRows } from "@/lib/csv";
import { resolveVehicleQr, vehicleQrUrl, generateQrSvg } from "@/lib/qrcode";
import { CustomerReceipt } from "@/features/sales/CustomerReceipt";
import type { Sale } from "@/types";

vi.mock("@/features/auth/AuthProvider", () => ({
  useAuth: () => ({
    profile: {
      id: "u1",
      full_name: "Admin User",
      role: "OWNER",
      active: true,
      can_view_financials: true,
    },
    signOut: vi.fn(),
  }),
}));

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

describe("DatePicker Vietnamese component rendering", () => {
  it("renders 2026-10-01 as 01/10/2026 and never as 10/01/2026", async () => {
    const { DatePicker } = await import("@/components/ui/DatePicker");
    const html = renderToStaticMarkup(
      <DatePicker
        value="2026-10-01"
        onChange={() => {}}
        required
        aria-label="Ngày thu xe *"
      />,
    );
    expect(html).toContain('value="01/10/2026"');
    expect(html).not.toContain('value="10/01/2026"');
    expect(html).toContain('placeholder="DD/MM/YYYY"');
    expect(html).toContain("required");
  });
});

describe("MoneyInput Vietnamese component rendering", () => {
  it("renders 82000000 as 82.000.000, shows single words helper, and never renders redundant badge or approx text simultaneously", async () => {
    const { MoneyInput } = await import("@/components/ui/MoneyInput");
    const html = renderToStaticMarkup(
      <MoneyInput
        value={82000000}
        onChange={() => {}}
        required
        aria-label="Giá thu (₫) *"
      />,
    );
    // User-facing input formatted with dots
    expect(html).toContain('value="82.000.000"');
    // Numeric input mode for mobile keyboard
    expect(html.toLowerCase()).toContain('inputmode="numeric"');
    // Single useful helper below: Vietnamese words
    expect(html).toContain("Tám mươi hai triệu đồng");
    // Not displaying repeating raw digits or repeating currency badge
    expect(html).not.toContain("82.000.000 đ");
    expect(html).not.toContain("≈ 82 triệu đồng");
  });

  it("renders empty field when value is undefined, never silently turning blank into 0", async () => {
    const { MoneyInput } = await import("@/components/ui/MoneyInput");
    const html = renderToStaticMarkup(
      <MoneyInput
        value={undefined}
        onChange={() => {}}
        aria-label="Giá thu (₫) *"
      />,
    );
    expect(html).toContain('value=""');
    expect(html).not.toContain('value="0"');
    expect(html).not.toContain("Không đồng");
  });
});

describe("DateRange Vietnamese component rendering and order integrity", () => {
  it("renders custom date range 2026-10-01 → 2026-10-02 as 01/10/2026 → 02/10/2026", async () => {
    const { DateRange } = await import("@/components/ui");
    const html = renderToStaticMarkup(
      <DateRange
        value={{ from: "2026-10-01", to: "2026-10-02" }}
        onChange={() => {}}
      />,
    );
    // User-facing inputs strictly formatted as DD/MM/YYYY
    expect(html).toContain('value="01/10/2026"');
    expect(html).toContain('value="02/10/2026"');
    // Never renders ambiguous US MM/DD/YYYY formats
    expect(html).not.toContain('value="10/01/2026"');
    expect(html).not.toContain('value="10/02/2026"');
    // Does not use browser-dependent native type="date"
    expect(html).not.toContain('type="date"');
  });

  it("sanitizes reversed initial range from > to so start <= end is always satisfied", async () => {
    const { DateRange } = await import("@/components/ui");
    const html = renderToStaticMarkup(
      <DateRange
        value={{ from: "2026-10-02", to: "2026-10-01" }}
        onChange={() => {}}
      />,
    );
    // Rendered output has earlier date in from and later date in to (01/10/2026 before 02/10/2026)
    expect(html).toContain('value="01/10/2026"');
    expect(html).toContain('value="02/10/2026"');
    const fromIndex = html.indexOf('value="01/10/2026"');
    const toIndex = html.indexOf('value="02/10/2026"');
    expect(fromIndex).toBeLessThan(toIndex);
  });

  it("does not render redundant custom date picker pill when a standard preset is active", async () => {
    const { DateRange } = await import("@/components/ui");
    const { today } = await import("@/lib/format");
    const current = today();
    const html = renderToStaticMarkup(
      <DateRange
        value={{ from: current, to: current }}
        onChange={() => {}}
      />,
    );
    // Preset buttons are present
    expect(html).toContain("Hôm nay");
    expect(html).toContain("Tuần này");
    expect(html).toContain("Tháng này");
    expect(html).toContain("Tháng trước");
    expect(html).toContain("Tùy chọn ngày");
    // Duplicate select dropdown is removed
    expect(html).not.toContain("<select");
    // Redundant date input pill is hidden when preset is active
    expect(html).not.toContain("date-inputs-pill");
  });
});

describe("AcquisitionsPage layout, table readability and operational UX", () => {
  it("renders page structure with prominent Thu xe mới action and both searches preserved", async () => {
    const { MemoryRouter } = await import("react-router-dom");
    const { AcquisitionsPage } = await import(
      "@/features/acquisitions/AcquisitionsPage"
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/acquisitions"]}>
          <AcquisitionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Header & primary action preserved
    expect(html).toContain("Thu vào");
    expect(html).toContain("Thu xe mới");
    expect(html).toContain("/acquisitions/new");
    // Local page search input preserved
    expect(html).toContain('aria-label="Tìm kiếm xe thu vào"');
    expect(html).toContain(
      'placeholder="Tìm số khung, biển số, hãng, dòng xe, người bán…"',
    );
    // Date filter presets rendered
    expect(html).toContain("Hôm nay");
    expect(html).toContain("Tuần này");
    expect(html).toContain("Tháng này");
  });

  it("does not render workspace footer on /acquisitions or /acquisitions/new in AppLayout", async () => {
    const { MemoryRouter } = await import("react-router-dom");
    const { AppLayout } = await import("@/layouts/AppLayout");
    const queryClient = new QueryClient();

    // Verify /acquisitions
    const listHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/acquisitions"]}>
          <AppLayout />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(listHtml).not.toContain(
      "Cà Rem · Vận hành cửa hàng xe máy chuyên nghiệp.",
    );
    expect(listHtml).not.toContain("Dữ liệu được phân quyền");

    // Verify /acquisitions/new
    const formHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/acquisitions/new"]}>
          <AppLayout />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(formHtml).not.toContain(
      "Cà Rem · Vận hành cửa hàng xe máy chuyên nghiệp.",
    );
    expect(formHtml).not.toContain("Dữ liệu được phân quyền");
  });

  it("renders workspace footer on other pages like /", async () => {
    const { MemoryRouter } = await import("react-router-dom");
    const { AppLayout } = await import("@/layouts/AppLayout");
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <AppLayout />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Cà Rem · Vận hành cửa hàng xe máy chuyên nghiệp.");
    expect(html).toContain("Dữ liệu được phân quyền");
  });

  it("renders table data with clear chassis/plate semantic distinction and right-aligned currency", async () => {
    const { MemoryRouter } = await import("react-router-dom");
    const { AcquisitionsPage } = await import(
      "@/features/acquisitions/AcquisitionsPage"
    );
    const { today } = await import("@/lib/format");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      [
        "acquisitions",
        { from: `${today().slice(0, 7)}-01`, to: today() },
        "",
        1,
      ],
      {
        total: 1,
        items: [
          {
            id: "acq-1",
            vehicle_id: "veh-1",
            brand: "Honda",
            model: "Vision",
            internal_code: "XE-2026-0001",
            frame_number: "RLH123456",
            license_plate: "43A1-99999",
            acquisition_date: "2026-10-01",
            seller_name: "Nguyễn Văn Thanh",
            seller_phone: "0905123456",
            purchase_price: 32000000,
            status: "COMPLETED",
          },
        ],
      },
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/acquisitions"]}>
          <AcquisitionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Table column headers
    expect(html).toContain("Số khung / Biển số");
    expect(html).toContain("Giá thu");
    // Semantic labels for chassis and plate
    expect(html).toContain("Khung:");
    expect(html).toContain("RLH123456");
    expect(html).toContain("BS:");
    expect(html).toContain("43A1-99999");
    // Primary vehicle name & muted internal code
    expect(html).toContain("Honda Vision");
    expect(html).toContain("XE-2026-0001");
    // Vietnamese date DD/MM/YYYY
    expect(html).toContain("01/10/2026");
    // Seller name and phone
    expect(html).toContain("Nguyễn Văn Thanh");
    expect(html).toContain("0905123456");
    // Right-aligned money formatted with ₫
    expect(html).toContain("numeric price");
    expect(html).toMatch(/32\.000\.000(&nbsp;|\s)₫/);
    // Accessible action
    expect(html).toContain('aria-label="Xem chi tiết xe Honda Vision"');
  });
});


