import { test, expect } from "@playwright/test";

const ownerId = "00000000-0000-4000-8000-000000000001";
const vehicleId = "00000000-0000-4000-8000-000000000002";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const seedVehicle = {
  id: vehicleId,
  internal_code: "XE-UX-001",
  frame_number: "DUPLICATE-FRAME",
  brand: "Honda",
  model: "Vision",
  license_plate: "43A1-12345",
  status: "IN_STOCK",
  purchase_date: today,
  purchase_price: 30000000,
  asking_price: 35000000,
  total_cost: 30000000,
  cost_pending: false,
  expenses: [],
  images: [],
  activity: [],
  sales: [],
};

async function installMock(page) {
  const calls = [];
  let acquired = null;
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: ownerId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.mock`,
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
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postDataJSON() ?? {};
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
    calls.push({ name, body });
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "list_profiles") return reply([
      { id: ownerId, full_name: "Chủ kiểm thử", username: "owner", role: "OWNER", active: true, can_view_financials: true, must_change_password: false },
      { id: "00000000-0000-4000-8000-000000000003", full_name: "Nguyễn Nhân Viên", username: "nhanvien", role: "STAFF", active: true, can_view_financials: false, must_change_password: false, allowed_from: "07:00:00", allowed_until: "20:00:00", working_days: [1, 2, 3, 4, 5, 6] },
    ]);
    if (name === "dashboard") return reply({
      in_stock: 18, reserved: 3, sold_today: 2, sold_month: 24, acquired_today: 1, acquired_month: 27,
      acquisitions_count: 27, acquisition_cost: 540000000, inventory_cost: 320000000, inventory_cost_pending: 2,
      today_revenue: 96000000, month_revenue: 1050000000, today_profit: 8000000, month_profit: 95000000,
      revenue: 1050000000, gross_profit: 95000000, sales_count: 24, business_expenses: 12000000,
      unpaid_sales_count: 3, total_receivables: 84000000, overdue_sales_count: 1, total_overdue_debt: 12000000,
      old_inventory_count: 4, recent_sales: [], recent_vehicles: [], recent_acquisitions: [], recent_expenses: [],
      aging: [{ bucket: "0-30 ngày", count: 8 }, { bucket: "31-60 ngày", count: 6 }], longest_stock: [],
      top_profitable: [], daily_sales: [{ date: "2026-10-01", revenue: 96000000, count: 2 }],
    });
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "list_vehicles") {
      const filters = body.p_filters ?? {},
        search = (filters.search ?? "").toLowerCase();
      const items = Array.from({ length: 40 }, (_, index) => ({
        ...seedVehicle,
        id:
          index === 0
            ? vehicleId
            : `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        internal_code: `XE-UX-${index + 1}`,
        frame_number:
          index === 0 ? seedVehicle.frame_number : `FRAME-${index + 1}`,
      }));
      const filtered = items.filter(
        (v) =>
          !search ||
          [v.frame_number, v.brand, v.model, v.license_plate]
            .join(" ")
            .toLowerCase()
            .includes(search),
      );
      return reply({
        items: filtered.slice(
          filters.offset ?? 0,
          (filters.offset ?? 0) + (filters.limit ?? 20),
        ),
        total: filtered.length,
      });
    }
    if (name === "get_vehicle")
      return reply(acquired ?? { ...seedVehicle, id: body.p_id });
    if (name === "acquire_vehicle") {
      acquired = {
        ...seedVehicle,
        ...body.p_data,
        purchase_date: body.p_data.acquisition_date,
        frame_number: body.p_data.frame_number,
      };
      return reply(vehicleId);
    }
    if (name === "save_expense")
      return reply("00000000-0000-4000-8000-000000000003");
    if (name === "global_search")
      return reply({ vehicles: [seedVehicle], customers: [], sales: [] });
    return reply({});
  });
  return calls;
}

test("Mobile acquisition uses visible save, normalized money and keeps advanced fields available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await installMock(page);
  await page.goto("/acquisitions/new");
  await expect(
    page.getByRole("heading", { name: "Thu xe mới", exact: true }),
  ).toBeVisible();
  const action = page.getByRole("button", {
    name: "Thu xe & tạo phiếu",
    exact: true,
  });
  const bounds = await action.boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  expect(bounds.y).toBeGreaterThan(0);
  const started = Date.now();
  await page.getByLabel("Số khung *", { exact: true }).fill("NEW-UX-FRAME");
  await page.getByLabel("Biển số (nếu có)", { exact: true }).fill("43A1-99999");
  await page.getByRole("button", { name: "Honda", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Dòng xe *", exact: true })
    .fill("Vision");
  await page.getByLabel("Giá thu (₫) *", { exact: true }).fill("82tr");
  await action.click();

  // Confirmation modal dialog verification
  await expect(
    page.getByRole("dialog", { name: "Xác nhận thu xe" }),
  ).toBeVisible();
  await expect(page.getByText("NEW-UX-FRAME")).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận thu xe", exact: true }).click();

  await expect(
    page.getByText("Đã thu xe thành công.", { exact: false }),
  ).toBeVisible();
  expect(Date.now() - started).toBeLessThan(30000);
  const request = calls.find((call) => call.name === "acquire_vehicle");
  expect(request.body.p_data.purchase_price).toBe(82000000);
  await expect(page.getByRole("link", { name: "+ Thu xe tiếp" })).toBeVisible();
  await page.screenshot({
    path: "test-results/ux-acquisition-mobile.png",
    fullPage: true,
  });
});

test("Frame duplicates are reported while typing before the form is submitted", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.goto("/acquisitions/new");
  await page
    .getByLabel("Số khung *", { exact: true })
    .fill(seedVehicle.frame_number);
  await expect(page.getByText(/Số khung đã tồn tại trong hệ thống/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Thu xe & tạo phiếu", exact: true }),
  ).toBeDisabled();
  expect(calls.some((call) => call.name === "acquire_vehicle")).toBe(false);
  await expect(
    page.getByRole("link", { name: "Xem chi tiết xe đã có" }),
  ).toHaveAttribute("href", `/vehicles/${vehicleId}`);
});

test("Quick expense keeps vehicle context, maps category to the existing enum and starts repeats without amounts", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.goto(`/vehicles/${vehicleId}`);
  const started = Date.now();
  await page.getByRole("button", { name: "+ Chi phí", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "+ Thêm chi phí xe",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Lốp xe", exact: true }).click();
  await dialog.getByLabel("Số tiền chi (₫) *", { exact: true }).fill("150k");
  await dialog
    .getByRole("button", { name: "Lưu chi phí", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(Date.now() - started).toBeLessThan(10000);
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`));
  const request = calls.find((call) => call.name === "save_expense").body;
  expect(request.p_data).toMatchObject({
    vehicle_id: vehicleId,
    expense_type: "PARTS",
    amount: 150000,
    description: "Thay lốp xe",
    expense_date: today,
  });
  await page.getByRole("button", { name: "+ Chi phí", exact: true }).click();
  await dialog.getByRole("button", { name: /Dùng lại/ }).click();
  await expect(
    dialog.getByLabel("Số tiền chi (₫) *", { exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "Lưu chi phí", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("Inventory filters, sort, page and scroll survive opening a vehicle and returning", async ({
  page,
}) => {
  await installMock(page);
  const inventoryUrl =
    "/vehicles?q=Honda&status=IN_STOCK&sort=oldest&page=2&brand=Honda";
  await page.goto(inventoryUrl);
  await expect(page.locator(".desktop-table tbody tr")).toHaveCount(6);
  await page
    .locator(".desktop-table tbody tr")
    .last()
    .getByRole("link")
    .last()
    .scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await page
    .locator(".desktop-table tbody tr")
    .last()
    .getByRole("link")
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Honda Vision", exact: true }),
  ).toBeVisible();
  await page.locator(".back-link").click();
  await expect(page).toHaveURL(
    new RegExp(
      `/vehicles\\?q=Honda&status=IN_STOCK&sort=oldest&page=2&brand=Honda$`,
    ),
  );
  await expect(page.getByLabel("Sắp xếp xe")).toHaveValue("oldest");
  await expect(page.locator(".pagination-page.active")).toHaveText("2");
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(Math.max(0, before - 150));
});

test("Inventory rows use clear vehicle metadata, status, age and preset wording", async ({ page }) => {
  page.on("pageerror", (error) => console.log("PAGEERROR", error.stack));
  page.on("console", (message) => { if (message.type() === "error") console.log("CONSOLEERROR", message.text()); });
  await installMock(page);
  await page.goto("/vehicles");
  const firstRow = page.locator(".desktop-table tbody tr").first();
  const vehicleCell = firstRow.locator("td").nth(0);
  const plateCell = firstRow.locator("td").nth(2);
  await expect(vehicleCell.getByText("XE-UX-1", { exact: true })).toBeVisible();
  await expect(plateCell).not.toContainText("XE-UX-1");
  await expect(firstRow.getByText("Hôm nay", { exact: true })).toBeVisible();
  await expect(firstRow.getByText("Sẵn sàng bán", { exact: true })).toBeVisible();
  await expect(page.getByText("Chưa bổ sung phiên bản")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Xe mới nhập" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đang giữ chỗ" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tồn kho lâu > 60 ngày" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chờ giá nhập" })).toBeVisible();
  await expect(page.getByText("Dữ liệu được phân quyền")).toHaveCount(0);
  await page.screenshot({ path: "test-results/inventory-audit-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".mobile-record").first()).toBeVisible();
  const mobileCard = page.locator(".mobile-record").first();
  await expect(mobileCard.getByText("Mã xe: XE-UX-1", { exact: true })).toBeVisible();
  await expect(mobileCard.getByText("Hôm nay", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/inventory-audit-mobile.png", fullPage: true });
});

test("Temporary visual audit for staff settings and create modal", async ({ page }) => {
  await installMock(page);
  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Nhân sự", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/users-audit-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Thêm tài khoản", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Tạo tài khoản nhân viên mới" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/users-create-audit-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Nhân sự", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Thêm tài khoản", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Tạo tài khoản nhân viên mới" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/users-create-audit-mobile.png", fullPage: true });
});

test("Temporary visual audit for dashboard icon and spacing", async ({ page }) => {
  await installMock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Xin chào/ })).toBeVisible();
  await expect(page.getByText("Tồn kho hiện tại", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-audit-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText("Tồn kho hiện tại", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-audit-mobile.png", fullPage: true });
});

test("Desktop search responds while typing with one debounced request and keyboard-accessible recent vehicles", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.goto(`/vehicles/${vehicleId}`);
  await expect(
    page.getByRole("heading", { name: "Honda Vision", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  const input = page.getByLabel("Tìm xe toàn hệ thống", { exact: true });
  await expect(input).toBeFocused();
  await expect(
    page.getByText("XE VỪA THAO TÁC", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".search-palette-popover .palette-result-item"),
  ).toHaveCount(1);
  const started = Date.now();
  await input.pressSequentially("43A112345", { delay: 15 });
  await expect(
    page.locator(".search-palette-popover .palette-result-item"),
  ).toHaveCount(1);
  await expect
    .poll(() => calls.filter((call) => call.name === "global_search").length)
    .toBe(1);
  expect(calls.find((call) => call.name === "global_search").body.p_query).toBe(
    "43A112345",
  );
  expect(Date.now() - started).toBeLessThan(3000);
  await input.press("ArrowDown");
  await expect(
    page.locator(".search-palette-popover .palette-result-item").first(),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`));
  await expect(page.locator(".search-palette-popover")).toHaveCount(0);
});
