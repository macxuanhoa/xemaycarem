import { test, expect } from "@playwright/test";

// Selling is the ONLY business that mints a price. asking_price was dropped from
// the vehicle record, so the "Bán xe" form must open with an empty sale price
// even when the vehicle carries a purchase_price (giá nhập): the clerk types the
// real counter price. This spec loads an IN_STOCK vehicle that has a purchase
// cost and asserts neither "Bán với giá" nor "Khách đã trả trước" is prefilled.

const ownerId = "00000000-0000-4000-8000-000000000001";
const vehicleId = "00000000-0000-4000-8000-0000000000f1";

// Real purchase cost on the record; there is deliberately no asking_price field.
const sellableVehicle = {
  id: vehicleId,
  internal_code: "XE-BAN-000001",
  license_plate: "59A1-234.56",
  frame_number: "RLHTEST0000001",
  year: 2023,
  color: "Đen",
  vehicle_type: "Xe tay ga",
  status: "IN_STOCK",
  cost_pending: false,
  purchase_price: 25000000,
  created_at: new Date().toISOString(),
};

async function installMock(page) {
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
      JSON.stringify({ sub: ownerId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")}.mock`,
    refresh_token: "mock-refresh",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: ownerId,
      aud: "authenticated",
      role: "authenticated",
      email: "owner@example.test",
      created_at: new Date().toISOString(),
      app_metadata: {},
      user_metadata: {},
    },
  };
  await page.addInitScript(
    (value) =>
      localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    session,
  );
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
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
    if (url.pathname === "/auth/v1/user") return reply(session.user);
    if (url.pathname === "/rest/v1/profiles")
      return reply({
        id: ownerId,
        full_name: "Chủ kiểm thử",
        role: "OWNER",
        active: true,
        can_view_financials: true,
        must_change_password: false,
      });
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "list_notifications")
      return reply({ items: [], unread_count: 0 });
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "get_vehicle") return reply(sellableVehicle);
    return reply({});
  });
}

test("sell form opens with an empty sale price despite a purchase cost on file", async ({
  page,
}) => {
  await installMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);

  await expect(
    page.getByRole("heading", { name: "Bán xe", exact: true }),
  ).toBeVisible();

  // The vehicle record loaded – `SaleEditor` chỉ mount sau khi `get_vehicle`
  // trả về, và aside tóm tắt tiền nằm trong editor. Danh tính xe (biển · khung)
  // chủ ý không lặp lại cạnh nút “Xác nhận bán xe” – chỉ hiện trong dialog
  // kiểm tra, đã được uiux-responsive.spec.mjs assert riêng.
  await expect(page.locator("aside .summary-total")).toBeVisible();

  // Price fields start blank — no asking_price / purchase_price leakage.
  const price = page.getByRole("textbox", { name: "Bán với giá" });
  await expect(price).toBeVisible();
  await expect(price).toHaveValue("");
  await expect(page.getByRole("button", { name: "Thêm chi tiết thanh toán" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Nhập số tiền hợp lệ.", { exact: true })).toHaveCount(0);

  // Advance payment lives behind the toggle and is likewise blank (never a
  // pre-filled figure and never the literal "NaN") until the clerk types it.
  await page.getByRole("button", { name: "Thêm chi tiết thanh toán" }).click();
  const paid = page.getByRole("textbox", {
    name: "Khách đã trả trước (₫)",
  });
  await expect(paid).toHaveValue("");
});
