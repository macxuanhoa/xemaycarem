import { test, expect } from "@playwright/test";

// Public showroom policy: an on-display bike is identified by Biển số · Số khung
// and described by Loại xe · Đời xe · Màu sắc — never by a price. There is no
// asking_price any more, so the storefront must not leak any currency figure or
// the removed spec rows (Phiên bản / Đã lăn bánh). This spec loads two IN_STOCK
// bikes and asserts the page stays price-free. (The customer's own "Định giá xe
// cần bán" request form is unaffected: that is a self-declared expected_price,
// not a system price, and only opens behind the sell CTA.)

const bikes = [
  {
    id: "00000000-0000-4000-8000-0000000000b1",
    internal_code: "XE-SR-000001",
    license_plate: "59-A1 234.56",
    frame_number: "RLHTEST0000001",
    year: 2023,
    color: "Đen",
    vehicle_type: "Xe tay ga",
    vehicle_title: "59-A1 234.56 · RLHTEST0000001",
    vehicle_subtitle: "Xe tay ga · 2023 · Đen",
    created_at: new Date().toISOString(),
  },
  {
    id: "00000000-0000-4000-8000-0000000000b2",
    internal_code: "XE-SR-000002",
    license_plate: "51H-999.99",
    frame_number: "MHLETEST000002",
    year: 2022,
    color: "Trắng",
    vehicle_type: "Xe số",
    vehicle_title: "51H-999.99 · MHLETEST000002",
    vehicle_subtitle: "Xe số · 2022 · Trắng",
    created_at: new Date().toISOString(),
  },
];

async function installMock(page) {
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (value) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(value),
        headers: { "access-control-allow-origin": "*" },
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
    const name = url.pathname.split("/").at(-1);
    if (name === "list_showroom_vehicles")
      return reply({
        total: bikes.length,
        items: bikes,
        vehicle_types: [{ name: "Xe tay ga" }, { name: "Xe số" }],
      });
    return reply({});
  });
}

test("public showroom lists real stock by identity and never shows a price", async ({ page }) => {
  await installMock(page);
  await page.goto("/showroom");

  // Both IN_STOCK bikes are on display, keyed by biển · khung.
  for (const bike of bikes) {
    await expect(page.getByText(bike.license_plate).first()).toBeVisible();
    await expect(page.getByText(bike.frame_number).first()).toBeVisible();
  }

  // The purged spec labels appear nowhere on the storefront: they were removed
  // outright, so unlike the retained marketing copy ("Định giá bán xe" CTA and
  // the customer "Định giá xe cần bán" lead form) they have no legitimate use.
  for (const gone of ["Giá bán công khai:", "Phiên bản", "Đã lăn bánh"])
    await expect(page.getByText(gone, { exact: false })).toHaveCount(0);

  // The inventory grid itself is price-free. Scope to the stock cards, NOT the
  // whole page: the header/hero/CTA keep "giá"/"bán" wording on purpose.
  const grid = page.locator(".showroom-bike-grid");
  await expect(grid.getByText(/Giá bán/i)).toHaveCount(0);
  await expect(grid.getByText("₫")).toHaveCount(0);
  // No formatted money (e.g. 18.000.000) that could be a re-introduced price.
  await expect(
    grid.locator("text=/\\d{1,3}\\.\\d{3}\\.\\d{3}/"),
  ).toHaveCount(0);

  // Opening a bike's detail dialog keeps the identity specs only.
  await grid.getByRole("button", { name: "Chi tiết" }).first().click();
  const dialog = page.getByRole("dialog", { name: /59-A1 234\.56/ });
  await expect(dialog).toBeVisible();
  for (const kept of ["Biển số:", "Số khung:", "Màu sơn:", "Loại xe:"])
    await expect(dialog.getByText(kept)).toBeVisible();
  await expect(dialog.getByText(/Giá bán/i)).toHaveCount(0);
  await expect(dialog.getByText("₫")).toHaveCount(0);
});
