import { test, expect } from "@playwright/test";

// Xóa cứng xe kho (hard delete) — OWNER/MANAGER only, and only for vehicles that
// never had a sale. This spec proves the UI gate and the reason-confirm RPC flow
// end-to-end against a mocked Supabase, at desktop and mobile widths.
const ownerId = "00000000-0000-4000-8000-000000000001";
const vehicleId = "00000000-0000-4000-8000-000000000002";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const baseVehicle = {
  id: vehicleId,
  internal_code: "XE-DEL-0001",
  vehicle_type_id: "vt-ga",
  vehicle_type: "Xe tay ga",
  year: 2023,
  color: "Trắng",
  frame_number: "MH3BY31YXPJ000123",
  license_plate: "59X1-123.45",
  supplier_name: "Lê Văn Bán",
  supplier_phone: "0900000000",
  notes: "",
  status: "IN_STOCK",
  purchase_date: today,
  purchase_price: 30000000,
  expense_total: 0,
  total_cost: 30000000,
  cost_pending: false,
  expenses: [],
  images: [],
  activity: [],
  sales: [],
};

async function installMock(page, { role = "OWNER", vehicle = baseVehicle } = {}) {
  const calls = { deleteVehicle: [], requestDelete: [], resolve: [] };
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
      email: `${role.toLowerCase()}@example.test`,
      created_at: new Date().toISOString(),
      app_metadata: {},
      user_metadata: {},
    },
  };
  await page.addInitScript(
    (value) => localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    session,
  );
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
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
        full_name: "Người kiểm thử",
        role,
        active: true,
        can_view_financials: true,
        must_change_password: false,
      });
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true, role });
    if (name === "list_active_announcements") return reply([]);
    if (name === "get_settings") return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "get_vehicle") return reply(vehicle);
    if (name === "get_acquisition_for_vehicle") return reply(null);
    if (name === "list_vehicles") return reply({ items: [vehicle], total: 1 });
    if (name === "delete_vehicle") {
      calls.deleteVehicle.push(JSON.parse(request.postData() || "{}"));
      return reply(null);
    }
    if (name === "request_delete_vehicle") {
      calls.requestDelete.push(JSON.parse(request.postData() || "{}"));
      return reply(null);
    }
    if (name === "resolve_vehicle_deletion") {
      calls.resolve.push(JSON.parse(request.postData() || "{}"));
      return reply(null);
    }
    if (name === "list_pending_approvals")
      return reply({
        items: [
          {
            id: "00000000-0000-4000-8000-000000000099",
            kind: "VEHICLE_DELETION",
            subject_id: vehicleId,
            reason: "Nhập nhầm xe, trùng phiếu",
            requested_by: ownerId,
            requester_name: "Nhân viên A",
            created_at: new Date().toISOString(),
            vehicle_code: vehicle.internal_code,
            vehicle_title: "59X1-123.45 · MH3BY31YXPJ000123",
            vehicle_subtitle: "Xe tay ga · 2023 · Trắng",
            license_plate: vehicle.license_plate,
            vehicle_status: vehicle.status,
          },
        ],
        total: 1,
      });
    return reply({});
  });
  return calls;
}

for (const width of [1440, 390]) {
  test(`OWNER sees and completes the hard-delete flow at ${width}px`, async ({
    page,
  }) => {
    const calls = await installMock(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/vehicles/${vehicleId}`);

    await page.getByRole("button", { name: "Thao tác trên xe" }).click();
    const deleteButton = page.getByRole("button", { name: "Xóa xe khỏi kho" });
    await expect(deleteButton).toBeVisible();

    await deleteButton.click();
    const dialog = page.getByRole("heading", { name: "Xóa xe khỏi kho" });
    await expect(dialog).toBeVisible();
    // Submit stays disabled until a >=3-char reason is provided.
    const confirm = page.getByRole("button", { name: "Xác nhận xóa xe" });
    await expect(confirm).toBeDisabled();
    await page
      .getByRole("textbox")
      .fill("Nhập nhầm xe, khách không bán nữa");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect.poll(() => calls.deleteVehicle.length).toBe(1);
    expect(calls.deleteVehicle[0]).toMatchObject({
      p_id: vehicleId,
      p_reason: "Nhập nhầm xe, khách không bán nữa",
    });
    await page.waitForURL("**/vehicles");
  });
}

test("delete button is hidden once the vehicle has sale history", async ({
  page,
}) => {
  await installMock(page, {
    vehicle: {
      ...baseVehicle,
      status: "SOLD",
      sales: [
        {
          id: "00000000-0000-4000-8000-000000000051",
          status: "COMPLETED",
          sale_code: "BH-0001",
          customer_name: "Khách A",
          sale_date: today,
          sale_price: 34000000,
          paid_amount: 34000000,
          remaining_amount: 0,
          gross_profit: 4000000,
        },
      ],
    },
  });
  await page.goto(`/vehicles/${vehicleId}`);
  await expect(page.locator(".identity-chip-plate strong")).toHaveText(baseVehicle.license_plate);
  const trigger = page.getByRole("button", { name: "Thao tác trên xe" });
  if (await trigger.count()) await trigger.click();
  await expect(
    page.getByRole("button", { name: "Xóa xe khỏi kho" }),
  ).toHaveCount(0);
});

test("STAFF never sees the hard-delete control", async ({ page }) => {
  await installMock(page, { role: "STAFF" });
  await page.goto(`/vehicles/${vehicleId}`);
  const trigger = page.getByRole("button", { name: "Thao tác trên xe" });
  if (await trigger.count()) await trigger.click();
  await expect(
    page.getByRole("button", { name: "Xóa xe khỏi kho" }),
  ).toHaveCount(0);
});

test("STAFF files a delete request instead of purging directly", async ({
  page,
}) => {
  const calls = await installMock(page, { role: "STAFF" });
  await page.goto(`/vehicles/${vehicleId}`);
  await page.getByRole("button", { name: "Thao tác trên xe" }).click();
  const requestButton = page.getByRole("button", { name: "Gửi yêu cầu xóa" });
  await expect(requestButton).toBeVisible();
  // STAFF must never be offered the direct purge.
  await expect(page.getByRole("button", { name: "Xóa xe khỏi kho" })).toHaveCount(0);

  await requestButton.click();
  const dialog = page.getByRole("dialog", { name: "Gửi yêu cầu xóa xe" });
  await expect(dialog).toBeVisible();
  const submit = dialog.getByRole("button", { name: "Gửi yêu cầu xóa" });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("textbox").fill("Nhập nhầm xe, khách không bán nữa");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => calls.requestDelete.length).toBe(1);
  expect(calls.requestDelete[0]).toMatchObject({
    p_id: vehicleId,
    p_reason: "Nhập nhầm xe, khách không bán nữa",
  });
});

test("OWNER reviews the approval queue and resolves a deletion", async ({
  page,
}) => {
  const calls = await installMock(page, { role: "OWNER" });
  await page.goto("/approvals");
  await expect(
    page.getByRole("heading", { name: "Chờ duyệt" }),
  ).toBeVisible();
  await expect(page.getByText("59X1-123.45 · MH3BY31YXPJ000123")).toBeVisible();

  await page.getByRole("button", { name: "Duyệt xóa" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(
    confirm.getByRole("heading", { name: "Duyệt xóa xe?" }),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Duyệt xóa" }).click();
  await expect.poll(() => calls.resolve.length).toBe(1);
  expect(calls.resolve[0]).toMatchObject({
    p_request_id: "00000000-0000-4000-8000-000000000099",
    p_action: "APPROVE",
  });
});
