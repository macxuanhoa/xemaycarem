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
    if (name === "list_showroom_vehicles")
      return reply({
        items: [
          {
            id: vehicleId,
            brand: "Honda",
            model: "Vision",
            variant: "Premium",
            year: 2024,
            color: "Đen",
            license_plate: "43A1-12345",
            odometer: 12500,
            asking_price: 35000000,
            purchase_date: today,
            created_at: today,
          },
        ],
        total: 1,
      });
    if (name === "list_profiles")
      return reply([
        {
          id: ownerId,
          full_name: "Chủ kiểm thử",
          username: "owner",
          role: "OWNER",
          active: true,
          can_view_financials: true,
          must_change_password: false,
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          full_name: "Nguyễn Nhân Viên",
          username: "nhanvien",
          role: "STAFF",
          active: true,
          can_view_financials: false,
          must_change_password: false,
          allowed_from: "07:00:00",
          allowed_until: "20:00:00",
          working_days: [1, 2, 3, 4, 5, 6],
        },
      ]);
    if (name === "dashboard")
      return reply({
        in_stock: 18,
        reserved: 3,
        sold_today: 2,
        sold_month: 24,
        acquired_today: 1,
        acquired_month: 27,
        acquisitions_count: 27,
        acquisition_cost: 540000000,
        inventory_cost: 320000000,
        inventory_cost_pending: 2,
        today_revenue: 96000000,
        month_revenue: 1050000000,
        today_profit: 8000000,
        month_profit: 95000000,
        revenue: 1050000000,
        gross_profit: 95000000,
        sales_count: 24,
        business_expenses: 12000000,
        unpaid_sales_count: 3,
        total_receivables: 84000000,
        overdue_sales_count: 1,
        total_overdue_debt: 12000000,
        old_inventory_count: 4,
        recent_sales: [],
        recent_vehicles: [],
        recent_acquisitions: [],
        recent_expenses: [],
        aging: [
          { bucket: "0-30 ngày", count: 8 },
          { bucket: "31-60 ngày", count: 6 },
        ],
        longest_stock: [],
        top_profitable: [],
        daily_sales: [{ date: "2026-10-01", revenue: 96000000, count: 2 }],
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
  // Actions must live in the normal document flow (no floating bar over the
  // bottom navigation) and required-field errors must not appear on load.
  const actionBar = page.locator(".form-footer-actions");
  const position = await actionBar.evaluate(
    (node) => getComputedStyle(node).position,
  );
  expect(position).not.toBe("fixed");
  expect(position).not.toBe("sticky");
  await expect(page.getByText("Nhập dòng xe.")).toHaveCount(0);
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  const bounds = await action.boundingBox();
  expect(bounds.y).toBeGreaterThan(0);
  const started = Date.now();
  await page.getByLabel("Số khung", { exact: true }).fill("NEW-UX-FRAME");
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
  await page
    .getByRole("button", { name: "Xác nhận thu xe", exact: true })
    .click();

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

for (const width of [320, 375, 390, 430]) {
  test(`Acquisition actions stay in-flow (no floating bar) at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await installMock(page);
    await page.goto("/acquisitions/new");
    const actionBar = page.locator(".form-footer-actions");
    const position = await actionBar.evaluate(
      (node) => getComputedStyle(node).position,
    );
    expect(position).toBe("static");
    // Reachable by natural scrolling and never pinned over the bottom nav.
    const action = page.getByRole("button", {
      name: "Thu xe & tạo phiếu",
      exact: true,
    });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    const doc = await page.evaluate(() => ({
      hasFixedBar: Boolean(document.querySelector(".mobile-sticky-actions")),
    }));
    expect(doc.hasFixedBar).toBe(false);
  });
}

test("Acquisition submit validates on demand and focuses the first error", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await installMock(page);
  await page.goto("/acquisitions/new");
  // No required-field error before interaction. Số khung and Hãng are now
  // optional; only Dòng xe (model) still blocks a bare submit.
  await expect(page.getByText("Nhập dòng xe.")).toHaveCount(0);
  const action = page.getByRole("button", {
    name: "Thu xe & tạo phiếu",
    exact: true,
  });
  await action.scrollIntoViewIfNeeded();
  await action.click();
  // Submission is blocked and the first invalid field reports inline.
  await expect(page.getByText("Nhập dòng xe.")).toBeVisible();
  const focusedIsModel = await page.evaluate(
    () =>
      document.activeElement
        ?.getAttribute("aria-label")
        ?.startsWith("Dòng xe") ??
      document.activeElement
        ?.getAttribute("placeholder")
        ?.includes("SH 160i") ??
      false,
  );
  expect(focusedIsModel).toBe(true);
});

test("Frame duplicates are reported while typing before the form is submitted", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.goto("/acquisitions/new");
  await page
    .getByLabel("Số khung", { exact: true })
    .fill(seedVehicle.frame_number);
  await expect(
    page.getByText(/Số khung đã tồn tại trong hệ thống/),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Thao tác trên xe" }).click();
  await page.getByRole("button", { name: "Thêm chi phí", exact: true }).click();
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
  await page.getByRole("button", { name: "Thao tác trên xe" }).click();
  await page.getByRole("button", { name: "Thêm chi phí", exact: true }).click();
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

test("Inventory rows use clear vehicle metadata, status, age and preset wording", async ({
  page,
}) => {
  page.on("pageerror", (error) => console.log("PAGEERROR", error.stack));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLEERROR", message.text());
  });
  await installMock(page);
  await page.goto("/vehicles");
  const firstRow = page.locator(".desktop-table tbody tr").first();
  const vehicleCell = firstRow.locator("td").nth(0);
  const plateCell = firstRow.locator("td").nth(2);
  await expect(vehicleCell.getByText("XE-UX-1", { exact: true })).toBeVisible();
  await expect(plateCell).not.toContainText("XE-UX-1");
  await expect(firstRow.getByText("Hôm nay", { exact: true })).toBeVisible();
  await expect(
    firstRow.getByText("Sẵn sàng bán", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Chưa bổ sung phiên bản")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Xe mới nhập" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Đang giữ chỗ" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Tồn kho lâu > 60 ngày" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Chờ giá nhập" }),
  ).toBeVisible();
  await expect(page.getByText("Dữ liệu được phân quyền")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/inventory-audit-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".mobile-record").first()).toBeVisible();
  const mobileCard = page.locator(".mobile-record").first();
  await expect(
    mobileCard.getByText("Mã xe: XE-UX-1", { exact: true }),
  ).toBeVisible();
  await expect(mobileCard.getByText("Hôm nay", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/inventory-audit-mobile.png",
    fullPage: true,
  });
});

test("Staff settings and create modals stay usable on desktop and mobile", async ({
  page,
}) => {
  await installMock(page);
  await page.goto("/users");
  await expect(
    page.getByRole("heading", { name: "Nhân sự", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/users-audit-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Thêm tài khoản", exact: true })
    .click();
  const createTrigger = page.getByRole("button", {
    name: "Thêm tài khoản",
    exact: true,
  });
  const createDialog = page.getByRole("dialog", {
    name: "Tạo tài khoản nhân viên mới",
  });
  await expect(createDialog).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "test-results/users-create-audit-desktop.png",
    fullPage: true,
  });
  const createClose = createDialog.getByRole("button", {
    name: "Đóng",
    exact: true,
  });
  await expect(createClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    createDialog.getByRole("button", { name: "Tạo tài khoản", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(createClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toHaveCount(0);
  await expect(createTrigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Nhân sự", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Thêm tài khoản", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Tạo tài khoản nhân viên mới" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "test-results/users-create-audit-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Tạo tài khoản nhân viên mới" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Thêm tài khoản", exact: true }),
  ).toBeFocused();

  // Regression: opening any staff member's detail modal on mobile must stay
  // inside the viewport as a bottom sheet with no horizontal overflow.
  const staffOpener = page
    .getByRole("button", { name: "Thiết lập nhân sự" })
    .first();
  await staffOpener.click();
  const staffDialog = page.getByRole("dialog", { name: "Nguyễn Nhân Viên" });
  await expect(staffDialog).toBeVisible();
  await expect(staffDialog.getByLabel("Đóng", { exact: true })).toBeFocused();
  const roleTab = staffDialog.getByRole("tab", { name: "Quyền & Vai trò" });
  await expect(roleTab).toBeVisible();
  await expect(
    staffDialog.getByRole("tab", { name: "Mật khẩu" }),
  ).toBeVisible();
  await expect(
    staffDialog.getByRole("tab", { name: "Cấm sử dụng" }),
  ).toBeVisible();
  await expect(
    staffDialog.getByRole("tab", { name: "Xóa tài khoản" }),
  ).toBeVisible();
  const box = await staffDialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  expect(box.y).toBeGreaterThanOrEqual(0);
  // Chromium's fractional dvh rounding on an 844px viewport can push the
  // bottom sheet ~1px past the pixel boundary even though the CSS clamps to
  // 94dvh — the intent of this check is "no visible overflow", not sub-pixel
  // equality, so a 1.5px tolerance is applied here.
  expect(box.y + box.height).toBeLessThanOrEqual(845.5);
  await page.screenshot({
    path: "test-results/users-staff-settings-mobile.png",
  });
  await staffDialog.getByRole("tab", { name: "Mật khẩu" }).click();
  await expect(
    staffDialog.getByText("Đặt lại mật khẩu tạm thời"),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/users-staff-security-mobile.png",
  });
  await staffDialog.getByRole("tab", { name: "Cấm sử dụng" }).click();
  await expect(staffDialog.getByText("Cấm sử dụng tạm thời")).toBeVisible();
  await expect(staffDialog.getByText("Hết hôm nay")).toBeVisible();
  await staffDialog.getByRole("tab", { name: "Xóa tài khoản" }).click();
  await expect(staffDialog.getByText("Lý do xóa (tùy chọn)")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(staffDialog).toHaveCount(0);
  await expect(staffOpener).toBeFocused();
});

test("Showroom dialogs have accessible names and contain keyboard focus", async ({
  page,
}) => {
  await installMock(page);
  await page.goto("/showroom");

  const bikeOpener = page.getByRole("button", {
    name: "Chi tiết",
    exact: true,
  });
  await bikeOpener.click();
  const bikeDialog = page.getByRole("dialog", { name: "Honda Vision Premium" });
  await expect(bikeDialog).toBeVisible();
  const bikeClose = bikeDialog.getByRole("button", {
    name: "Đóng chi tiết xe",
  });
  await expect(bikeClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    bikeDialog.getByRole("link", { name: /Gọi 0914/ }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bikeClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(bikeDialog).toHaveCount(0);
  await expect(bikeOpener).toBeFocused();

  const sellOpener = page.getByRole("button", {
    name: "Định giá bán xe",
    exact: true,
  });
  await sellOpener.click();
  const sellDialog = page.getByRole("dialog", {
    name: "Gửi Thông Tin Xe Cần Bán",
  });
  await expect(sellDialog).toBeVisible();
  await expect(
    sellDialog.getByRole("button", { name: "Đóng biểu mẫu định giá" }),
  ).toBeFocused();
  for (const label of [
    "Họ tên của bạn *",
    "Tên dòng xe cần bán *",
    "Đời xe / Năm đăng ký",
    "Số điện thoại / Zalo của bạn *",
    "Giá bạn mong muốn (VNĐ)",
    "Tình trạng xe / Ghi chú thêm",
  ]) {
    await expect(sellDialog.getByLabel(label, { exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(sellDialog).toHaveCount(0);
  await expect(sellOpener).toBeFocused();
});

test("Create-account footer stays pinned inside short mobile viewports", async ({
  page,
}) => {
  // Regression: the footer used to live inside the scrolling body with a
  // negative bottom margin, so on narrow/short phones "Hủy"/"Tạo tài khoản"
  // were clipped past the sheet edge and could not be reached at all.
  await installMock(page);
  for (const viewport of [
    { width: 360, height: 600 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/users");
    await page
      .getByRole("button", { name: "Thêm tài khoản", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Tạo tài khoản nhân viên mới",
    });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    const submit = dialog.getByRole("button", {
      name: "Tạo tài khoản",
      exact: true,
    });
    await expect(submit).toBeInViewport();
    await expect(
      dialog.getByRole("button", { name: "Hủy", exact: true }),
    ).toBeInViewport();
    // Scrolling the body must not move the footer out of view.
    await dialog
      .locator(".user-settings-body")
      .evaluate((node) => node.scrollTo(0, node.scrollHeight));
    await expect(submit).toBeInViewport();
  }
});

test("Temporary visual audit for dashboard icon and spacing", async ({
  page,
}) => {
  await installMock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Xin chào/ })).toBeVisible();
  await expect(
    page.getByText("Tồn kho hiện tại", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-audit-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByText("Tồn kho hiện tại", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-audit-mobile.png",
    fullPage: true,
  });
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

test("Mobile search dialog keeps a 16px input font and restores its opener", async ({
  page,
}) => {
  // Regression: a later @media rule had dropped the search input to 13px,
  // which makes iOS Safari punch the viewport in when the box is focused.
  await installMock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const opener = page.getByRole("button", {
    name: "Tìm xe toàn hệ thống",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Tìm kiếm", exact: true });
  const input = dialog.getByRole("searchbox", {
    name: "Tìm xe toàn hệ thống",
    exact: true,
  });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute("placeholder", /Ctrl|⌘/);
  const size = await input.evaluate((node) =>
    parseFloat(getComputedStyle(node).fontSize),
  );
  expect(size).toBeGreaterThanOrEqual(16);
  await dialog.getByRole("button", { name: "Đóng tìm kiếm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("Mobile search contains focus, preserves scroll and fits a reduced visible viewport", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.setViewportSize({ width: 360, height: 844 });
  await page.goto(`/vehicles/${vehicleId}`);
  await expect(
    page.getByRole("heading", { name: "Honda Vision", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 260));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await expect.poll(async () => Math.abs((await page.locator(".topbar").boundingBox()).y)).toBeLessThan(1);
  const opener = page.getByRole("button", {
    name: "Tìm xe toàn hệ thống",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Tìm kiếm", exact: true });
  const input = dialog.getByRole("searchbox");
  await expect(input).toBeFocused();
  expect(
    await page.evaluate(() => getComputedStyle(document.body).position),
  ).toBe("fixed");
  expect(await page.evaluate(() => Math.abs(parseFloat(document.body.style.top) || 0))).toBe(scrollBefore);
  expect(await page.locator(".app-shell").evaluate(node => Boolean(node.closest("[inert]")))).toBe(true);
  await input.press("Shift+Tab");
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  // This is a browser viewport regression, not physical iOS keyboard certification.
  await page.setViewportSize({ width: 360, height: 420 });
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(421);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  expect(
    calls.some((call) =>
      ["acquire_vehicle", "sell_vehicle", "import_vehicles"].includes(
        call.name,
      ),
    ),
  ).toBe(false);
});

test("Matching vehicle results render without quick commands and never write", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.goto("/");
  const input = page.getByRole("searchbox", {
    name: "Tìm xe toàn hệ thống",
    exact: true,
  });
  await input.fill("xe");
  const results = page.getByRole("region", {
    name: "Kết quả tìm kiếm",
    exact: true,
  });
  await expect(results.locator(".palette-result-item")).toHaveCount(1);
  await expect(results.locator("button").first()).toContainText("Honda Vision");
  // Quick-command tiles were removed from the shared search palette.
  await expect(results.locator(".palette-cmd-btn")).toHaveCount(0);
  expect(calls.filter((call) => call.name === "global_search")).toHaveLength(1);
  expect(
    calls.some((call) =>
      ["acquire_vehicle", "sell_vehicle", "import_vehicles"].includes(
        call.name,
      ),
    ),
  ).toBe(false);
});

test("Acquisition validates the existing plate rule on first blur", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.goto("/acquisitions/new");
  const plate = page.getByLabel("Biển số (nếu có)", { exact: true });
  await plate.fill("not-a-plate");
  await page.getByLabel("Số máy", { exact: true }).focus();
  const field = page.locator(".field").filter({ has: plate });
  await expect(field.locator(".field-error")).toBeVisible();
  await plate.fill("43A1-99999");
  await page.getByLabel("Số máy", { exact: true }).focus();
  await expect(field.locator(".field-error")).toHaveCount(0);
  expect(calls.some((call) => call.name === "acquire_vehicle")).toBe(false);
});

test("A failed chassis lookup never claims the identifier is available", async ({
  page,
}) => {
  const calls = await installMock(page);
  await page.route(
    "https://xe-test.supabase.co/rest/v1/rpc/list_vehicles",
    async (route) => {
      const body = route.request().postDataJSON();
      if (body?.p_filters?.search !== "LOOKUP-FAIL") return route.fallback();
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Fixture lookup unavailable" }),
      });
    },
  );
  await page.goto("/acquisitions/new");
  await page.getByLabel("Số khung", { exact: true }).fill("LOOKUP-FAIL");
  await expect(
    page.getByText("Chưa kiểm tra được số khung.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Số khung chưa có trong hệ thống", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Thử lại", exact: true }),
  ).toBeVisible();
  expect(calls.some((call) => call.name === "acquire_vehicle")).toBe(false);
});
