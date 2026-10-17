import { test, expect } from "@playwright/test";

// Bán xe dưới giá thu mua — luồng UI nối vào hàng đợi "Chờ duyệt" có sẵn.
// Server là nơi chốt quyết định (tests/db/below-cost-sale-approval.test.mjs);
// spec này khoá phần frontend không được tự ý "mềm" hơn:
//   * STAFF/MANAGER bán dưới giá thu → bấm nút thành "Gửi yêu cầu duyệt", và
//     chỉ RPC request_sale_below_cost được gọi, không bao giờ sell_vehicle;
//   * giá bán >= giá thu → bán thẳng, không gửi đơn;
//   * OWNER bán dưới giá thu → tự quyết, sell_vehicle trực tiếp;
//   * xe đang có đơn chờ → form bị khóa bán, chỉ có đường "Rút yêu cầu";
//   * hàng đợi Chờ duyệt hiển thị đủ biển số/số khung/giá thu/giá bán/chênh
//     lệch và gửi resolve_sale_approval khi chủ Phê duyệt hoặc Từ chối.

const staffId = "00000000-0000-4000-8000-00000000000a";
const ownerId = "00000000-0000-4000-8000-000000000001";
const vehicleId = "00000000-0000-4000-8000-0000000000f2";
const approvalId = "00000000-0000-4000-8000-0000000000ad";
const saleId = "00000000-0000-4000-8000-00000000005e";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

// Giá thu 25tr: bán 18tr là dưới giá thu (thiếu 7tr), bán 26tr là bình thường.
const baseVehicle = {
  id: vehicleId,
  internal_code: "XE-BCOST-0001",
  vehicle_type: "Xe tay ga",
  year: 2023,
  color: "Trắng",
  frame_number: "RLHBCOST000001",
  license_plate: "59B1-777.88",
  supplier_name: "Người bán A",
  supplier_phone: "0900000001",
  notes: "",
  status: "IN_STOCK",
  purchase_date: today,
  purchase_price: 25000000,
  expense_total: 0,
  total_cost: 25000000,
  cost_pending: false,
  pending_sale_approval: false,
  sale_approval_id: null,
  expenses: [],
  images: [],
  activity: [],
  sales: [],
};

// Bản đề xuất do server sinh lúc nhân viên gửi đơn (payload đóng dấu at-filing).
const saleApprovalRow = {
  id: approvalId,
  kind: "SALE_BELOW_COST",
  subject_id: vehicleId,
  status: "PENDING",
  reason:
    "Bán dưới giá thu xe 59B1-777.88: giá thu 25.000.000 ₫ → giá bán 18.000.000 ₫ (thiếu 7.000.000 ₫).",
  requested_by: staffId,
  requester_name: "Nhân viên Kiểm Thử",
  created_at: new Date().toISOString(),
  vehicle_code: baseVehicle.internal_code,
  vehicle_title: "59B1-777.88 · RLHBCOST000001",
  vehicle_subtitle: "Xe tay ga · 2023 · Trắng",
  license_plate: baseVehicle.license_plate,
  frame_number: baseVehicle.frame_number,
  vehicle_status: baseVehicle.status,
  payload: {
    vehicle_id: vehicleId,
    customer_name: "KháchUnderCost",
    customer_phone: "0900111222",
    sale_price: 18000000,
    sale_date: today,
    payment_method: "CASH",
    initial_payment: 18000000,
    sold_by: staffId,
    snapshot_purchase_price: 25000000,
    snapshot_expense_total: 0,
    shortfall: 7000000,
  },
};

async function installMock(
  page,
  {
    role = "STAFF",
    canViewFinancials = false,
    vehicle = baseVehicle,
    approvals = [saleApprovalRow],
    sale = {},
  } = {},
) {
  const userId = role === "OWNER" ? ownerId : staffId;
  const calls = { sell: [], request: [], cancel: [], resolve: [], approvals: [], receipts: [] };
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
      JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")}.mock`,
    refresh_token: "mock-refresh",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${role.toLowerCase()}@example.test`,
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
    const body = () => JSON.parse(request.postData() || "{}");
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
        id: userId,
        full_name: role === "OWNER" ? "Chủ kiểm thử" : "Nhân viên kiểm thử",
        role,
        active: true,
        can_view_financials: canViewFinancials,
        must_change_password: false,
      });
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true, role });
    if (name === "list_active_announcements") return reply([]);
    if (name === "list_notifications")
      return reply({ items: [], unread_count: 0 });
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "get_vehicle") return reply(vehicle);
    if (name === "list_vehicles") return reply({ items: [vehicle], total: 1 });
    if (name === "list_pending_approvals") {
      const filters = body().p_filters ?? {};
      calls.approvals.push(filters);
      // Legacy response: intentionally ignores exclude_kind so the pager must
      // still allow reaching later finance requests during a rolling upgrade.
      const offset = filters.offset ?? 0;
      return reply({ items: approvals.slice(offset, offset + (filters.limit ?? 50)), total: approvals.length });
    }
    if (name === "list_payment_receipts") {
      calls.receipts.push(body());
      return reply([]);
    }
    if (name === "sell_vehicle") {
      calls.sell.push(body());
      return reply(saleId);
    }
    if (name === "request_sale_below_cost") {
      calls.request.push(body());
      return reply(approvalId);
    }
    if (name === "cancel_sale_approval") {
      calls.cancel.push(body());
      return reply(null);
    }
    if (name === "resolve_sale_approval") {
      calls.resolve.push(body());
      return reply({ approval_id: approvalId, action: "APPROVE", sale_id: saleId });
    }
    if (name === "get_sale")
      return reply({
        id: saleId,
        vehicle_id: vehicleId,
        sale_code: "BH-BCOST-1",
        customer_name: "KháchUnderCost",
        sale_date: today,
        sale_price: 18000000,
        paid_amount: 18000000,
        remaining_amount: 0,
        gross_profit: -7000000,
        status: "COMPLETED",
        payments: [],
        ...sale,
      });
    return reply({});
  });
  return calls;
}

/** Điền form bán: tên khách + giá bán. "đã thu" tự theo giá nên không cần mở toggle. */
async function fillSale(page, price) {
  await page
    .getByLabel("Tên khách hàng", { exact: true })
    .fill("KháchUnderCost");
  await page.getByLabel("Bán với giá", { exact: true }).fill(price);
}

const submitButton = (page) => page.locator("form button[type=submit]");

test("Chờ duyệt vẫn tới được yêu cầu tiền sau một trang chỉ gồm xác minh nghi trùng", async ({ page }) => {
  const duplicates = Array.from({ length: 50 }, (_, index) => ({
    ...saleApprovalRow, id: `duplicate-${index}`, kind: "VEHICLE_DUPLICATE_REVIEW",
  }));
  const calls = await installMock(page, {
    role: "OWNER", approvals: [...duplicates, saleApprovalRow],
  });
  await page.goto("/approvals");
  await expect(page.getByText("Không có gì chờ duyệt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Trang sau", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Trang sau", exact: true }).click();
  await expect(page.getByRole("button", { name: "Phê duyệt", exact: true })).toBeVisible();
  expect(calls.approvals).toContainEqual({
    limit: 50, offset: 50, exclude_kind: "VEHICLE_DUPLICATE_REVIEW",
  });
});

test("giao dịch riêng tư không trưng số tiền, phiếu in hoặc trạng thái thanh toán giả", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const calls = await installMock(page, {
    role: "STAFF", sale: { sale_price_hidden: true },
  });
  await page.goto(`/sales/${saleId}`);
  await expect(page.getByRole("heading", { name: "Thông tin giao dịch" })).toBeVisible();
  await expect(page.getByText("Thông tin thanh toán do chủ cửa hàng quản lý.", { exact: true })).toBeVisible();
  await expect(page.getByText("Đã ẩn", { exact: true })).toHaveCount(3);
  await expect(page.getByText(/18\.000\.000/)).toHaveCount(0);
  await expect(page.getByText("Đã thanh toán đủ", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "In phiếu bán xe", exact: true })).toHaveCount(0);
  expect(calls.receipts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("STAFF bán dưới giá thu: cảnh báo chênh lệch + gửi yêu cầu, không sell_vehicle", async ({
  page,
}) => {
  const calls = await installMock(page, { role: "STAFF" });
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await expect(
    page.getByRole("heading", { name: "Bán xe", exact: true }),
  ).toBeVisible();

  // Nhân viên không có quyền tài chính vẫn phải thấy giá thu để biết mình đang
  // bán lỗ hay không; chỉ "giá vốn" (gồm chi phí) là số riêng của quyền đó.
  const aside = page.locator("aside .summary-list");
  await expect(aside.getByText("Giá thu vào")).toBeVisible();
  await expect(aside.getByText(/25\.000\.000/).first()).toBeVisible();
  await expect(aside.getByText("Giá vốn hiện tại")).toHaveCount(0);

  await fillSale(page, "18tr");
  await expect(
    page.getByText(/Bán dưới giá thu/),
  ).toBeVisible();
  await expect(page.getByText(/7\.000\.000/).first()).toBeVisible();
  await expect(submitButton(page)).toHaveText(/Gửi yêu cầu duyệt/);

  await submitButton(page).click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("heading", { name: "Gửi yêu cầu bán dưới giá thu" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Gửi yêu cầu duyệt", exact: true }).click();

  await expect.poll(() => calls.request.length).toBe(1);
  expect(calls.request[0]).toMatchObject({
    p_data: {
      vehicle_id: vehicleId,
      customer_name: "KháchUnderCost",
      sale_price: 18000000,
    },
  });
  expect(uuid.test(calls.request[0].p_data.request_id)).toBe(true);
  // Xe chưa được bán và chưa ghi nhận doanh thu.
  expect(calls.sell).toHaveLength(0);
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`));
});

test("STAFF bán bằng giá thu: bán bình thường, không gửi yêu cầu duyệt", async ({
  page,
}) => {
  const calls = await installMock(page, { role: "STAFF" });
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await fillSale(page, "25tr");
  await expect(
    page.getByText(/Bán dưới giá thu/),
  ).toHaveCount(0);
  await expect(submitButton(page)).toHaveText(/Xác nhận bán xe/);
  await submitButton(page).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Xác nhận bán xe", exact: true })
    .click();
  await expect.poll(() => calls.sell.length).toBe(1);
  expect(calls.sell[0].p_data).toMatchObject({
    vehicle_id: vehicleId,
    sale_price: 25000000,
  });
  expect(calls.request).toHaveLength(0);
});

test("STAFF bán cao hơn giá thu: không cần bước duyệt", async ({ page }) => {
  const calls = await installMock(page, { role: "STAFF" });
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await fillSale(page, "26tr");
  await expect(submitButton(page)).toHaveText(/Xác nhận bán xe/);
  await submitButton(page).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Xác nhận bán xe", exact: true })
    .click();
  await expect.poll(() => calls.sell.length).toBe(1);
  expect(calls.request).toHaveLength(0);
});

test("OWNER bán dưới giá thu: tự quyết, ghi giao dịch ngay", async ({ page }) => {
  const calls = await installMock(page, { role: "OWNER", canViewFinancials: true });
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await fillSale(page, "18tr");
  await expect(
    page.getByText(/Bán dưới giá thu/),
  ).toBeVisible();
  await expect(page.getByText(/7\.000\.000/).first()).toBeVisible();
  await expect(submitButton(page)).toHaveText(/Xác nhận bán xe/);
  await submitButton(page).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Xác nhận bán xe", exact: true })
    .click();
  await expect.poll(() => calls.sell.length).toBe(1);
  expect(calls.request).toHaveLength(0);
});

test("Xe đang chờ duyệt: không bán được, chỉ rút được yêu cầu", async ({
  page,
}) => {
  const calls = await installMock(page, {
    role: "STAFF",
    vehicle: { ...baseVehicle, pending_sale_approval: true, sale_approval_id: approvalId },
  });
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await expect(
    page.getByText(/Xe đang chờ chủ duyệt yêu cầu bán dưới giá thu/),
  ).toBeVisible();
  await fillSale(page, "18tr");
  await expect(submitButton(page)).toBeDisabled();

  await page.getByRole("button", { name: "Rút yêu cầu", exact: true }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("heading", { name: "Rút yêu cầu duyệt bán?" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Rút yêu cầu", exact: true }).click();
  await expect.poll(() => calls.cancel.length).toBe(1);
  expect(calls.cancel[0]).toMatchObject({ p_approval_id: approvalId });
});

test("OWNER thấy đủ số liệu trong Chờ duyệt và phê duyệt giao dịch", async ({
  page,
}) => {
  const calls = await installMock(page, { role: "OWNER", canViewFinancials: true });
  await page.goto("/approvals");
  await expect(
    page.getByRole("heading", { name: "Chờ duyệt" }),
  ).toBeVisible();
  const group = page.getByRole("heading", { name: "Bán xe dưới giá thu" });
  await expect(group).toBeVisible();

  const row = page.locator(".approvals-row").first();
  // Biển số/số khung xuất hiện hai lần (dòng tiêu đề xe + dòng đối chiếu), nên
  // assert bản đúng của dòng đối chiếu bằng exact.
  await expect(
    row.getByText("59B1-777.88", { exact: true }),
  ).toBeVisible();
  await expect(row.getByText("RLHBCOST000001", { exact: true })).toBeVisible();
  await expect(row.getByText("Giá thu vào")).toBeVisible();
  await expect(row.getByText("Giá bán đề xuất")).toBeVisible();
  await expect(row.getByText("Chênh lệch")).toBeVisible();
  await expect(row.getByText(/7\.000\.000/).first()).toBeVisible();
  await expect(row.getByText("Nhân viên Kiểm Thử")).toBeVisible();

  await row.getByRole("button", { name: "Phê duyệt", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("heading", { name: "Phê duyệt bán dưới giá thu?" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Phê duyệt", exact: true }).click();

  await expect.poll(() => calls.resolve.length).toBe(1);
  expect(calls.resolve[0]).toMatchObject({
    p_approval_id: approvalId,
    p_action: "APPROVE",
  });
  expect(uuid.test(calls.resolve[0].p_request_id)).toBe(true);
  // Chủ được đưa về trang giao dịch sau khi hàng đợi đã nạp lại; lúc máy bận,
  // bốn lần refetch nối tiếp có thể lâu hơn mặc định 10s.
  await expect(page).toHaveURL(new RegExp(`/sales/${saleId}$`), {
    timeout: 30_000,
  });
});

test("OWNER từ chối yêu cầu: xe không bị bán", async ({ page }) => {
  const calls = await installMock(page, { role: "OWNER", canViewFinancials: true });
  await page.goto("/approvals");
  const row = page.locator(".approvals-row").first();
  await row.getByRole("button", { name: "Từ chối", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("heading", { name: "Từ chối yêu cầu bán dưới giá thu?" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect.poll(() => calls.resolve.length).toBe(1);
  expect(calls.resolve[0]).toMatchObject({
    p_approval_id: approvalId,
    p_action: "REJECT",
  });
});
