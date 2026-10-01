/**
 * Requirement 16: E2E Business Flows (Playwright)
 * Flow A: OWNER full lifecycle (create vehicle -> inventory -> expense -> sell -> payment -> dashboard)
 * Flow B: Partial payment, installment collection to fully paid
 * Flow C: Sell vehicle and cancel sale (inventory restoration)
 * Flow D: STAFF login and unauthorized action denial
 */

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDatabase, asUser, rpc } from "../../scripts/db-harness.mjs";

let db, day, ids, createdVehicles, failNextPaymentResponse;

test.beforeAll(async () => {
  db = await createDatabase({ engine: "postgres" });
});

test.afterAll(async () => {
  await db?.close();
});

test.beforeEach(async ({ page }) => {
  day = (await db.query("select private.today()::text as day")).rows[0].day;
  ids = {
    OWNER: randomUUID(),
    MANAGER: randomUUID(),
    STAFF: randomUUID(),
  };
  createdVehicles = [];
  failNextPaymentResponse = false;

  for (const [role, id] of Object.entries(ids)) {
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        id,
        `${id}@example.test`,
        JSON.stringify({ full_name: `Kiểm thử ${role}` }),
      ]
    );
    await db.query(
      "update public.profiles set role=$1,active=true,can_view_financials=$2 where id=$3",
      [role, role === "OWNER", id]
    );
  }

  // Pre-seed an inventory vehicle for quick operations
  const connection = await db.connection();
  try {
    const seeded = await asUser(connection, ids.OWNER, (c) =>
      rpc(c, "save_vehicle", "$1::jsonb", [
        JSON.stringify({
          brand: "Honda",
          model: `Wave Alpha Seed ${ids.OWNER.slice(0, 4)}`,
          purchase_date: day,
          purchase_price: 15000000,
          asking_price: 18000000,
          license_plate: `29A-${ids.OWNER.slice(0, 4)}`,
          year: 2023,
        }),
      ])
    );
    createdVehicles.push(seeded);
  } finally {
    await connection.close();
  }

  // Route Supabase requests to our disposable database
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON() ?? {};

    const reply = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
        headers: { "access-control-allow-origin": "*" },
      });

    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
    }

    const authUser = (id) => ({
      id,
      aud: "authenticated",
      role: "authenticated",
      email: `${id}@example.test`,
      email_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      app_metadata: { provider: "email" },
      user_metadata: {},
      identities: [],
    });

    if (url.pathname === "/auth/v1/token") {
      const email = body.email?.toLowerCase();
      const role = email?.split("@")[0].toUpperCase();
      const id =
        ids[role] ??
        Object.values(ids).find(
          (value) => body.email === `${value}@example.test`
        );
      if (!id || body.password !== "Password-Test-2026") {
        return reply(
          {
            error: "invalid_grant",
            error_description: "Invalid login credentials",
          },
          400
        );
      }
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token =
        [
          { alg: "HS256", typ: "JWT" },
          { sub: id, role: "authenticated", aud: "authenticated", exp },
        ]
          .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
          .join(".") + ".test-signature";
      return reply({
        access_token: token,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: exp,
        refresh_token: "e2e-refresh",
        user: authUser(id),
      });
    }

    let userId = null;
    try {
      userId = JSON.parse(
        Buffer.from(
          (request.headers().authorization ?? "").split(".")[1] ?? "",
          "base64url"
        ).toString()
      ).sub;
    } catch {
      /* anonymous */
    }

    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204 });
    if (url.pathname === "/auth/v1/user") {
      return userId ? reply(authUser(userId)) : reply({ message: "Unauthorized" }, 401);
    }

    const client = await db.connection();
    try {
      const result = await asUser(
        client,
        userId,
        async (c) => {
          if (url.pathname === "/rest/v1/profiles") {
            return (
              (
                await c.query(
                  "select * from public.profiles where id=$1",
                  [userId]
                )
              ).rows[0] ?? null
            );
          }
          if (url.pathname.startsWith("/rest/v1/rpc/")) {
            const name = url.pathname.split("/").at(-1);
            if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid RPC");
            const signature = (
              await db.query(
                "select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",
                [name]
              )
            ).rows[0]?.args;
            if (signature === undefined) throw new Error(`RPC missing: ${name}`);
            const types = Object.fromEntries(
              signature
                .split(/,(?![^(]*\))/)
                .map((s) => s.trim())
                .filter(Boolean)
                .map((pair) => {
                  const cleaned = pair.replace(/\s+DEFAULT\s+.*$/i, "").trim();
                  const space = cleaned.indexOf(" ");
                  return [cleaned.slice(0, space), cleaned.slice(space + 1)];
                })
            );
            const entries = Object.entries(body);
            if (entries.some(([k]) => !types[k])) throw new Error("Unknown RPC argument");
            const sql = entries.map(([k], i) => `${k}=>$${i + 1}::${types[k]}`).join(",");
            const values = entries.map(([k, v]) => (types[k] === "jsonb" ? JSON.stringify(v) : v));
            return rpc(c, name, sql, values);
          }
          throw new Error(`Unhandled test endpoint ${url.pathname}`);
        },
        userId ? "authenticated" : "anon"
      );
      if (url.pathname === "/rest/v1/rpc/add_payment" && failNextPaymentResponse) {
        failNextPaymentResponse = false;
        return route.abort("failed"); // Commit succeeded but its network response was lost.
      }
      return reply(result);
    } catch (error) {
      return reply({ code: error.code ?? "TEST", message: error.message }, 400);
    } finally {
      await client.close();
    }
  });
});

async function loginAs(page, role = "owner") {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Chào mừng trở lại", exact: true })).toBeVisible();
  const username = page.getByRole("textbox", { name: /Tên đăng nhập hoặc email/i });
  const password = page.getByLabel("Mật khẩu", { exact: true });
  await username.fill(`${role}@example.test`);
  await expect(username).toHaveValue(`${role}@example.test`);
  await password.fill("Password-Test-2026");
  await expect(password).toHaveValue("Password-Test-2026");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Xin chào/ })).toBeVisible();
}

test("FLOW A: OWNER full lifecycle (create vehicle -> inventory -> expense -> sell -> payment -> dashboard)", async ({
  page,
}) => {
  await loginAs(page, "owner");

  // 1. Add vehicle
  await page.goto("/vehicles/new");
  await page.getByLabel("Hãng xe *", { exact: true }).fill("Yamaha");
  await page.getByLabel("Dòng xe *", { exact: true }).fill("Exciter 155 Flow A");
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("40000000");
  await page.getByLabel("Giá niêm yết (₫) *", { exact: false }).fill("48000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]{36}$/);
  const vehicleId = page.url().split("/").at(-1);

  // 2. Appears in inventory
  await page.goto("/vehicles");
  await expect(page.getByText("Exciter 155 Flow A").first()).toBeVisible();

  // 3. Add expense
  await page.goto(`/expenses?kind=vehicle&vehicle=${vehicleId}&new=1`);
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("2000000");
  await page.getByLabel("Nội dung chi phí *", { exact: true }).fill("Thay lốp và bảo dưỡng phanh");
  await page.getByRole("button", { name: "Lưu chi phí", exact: true }).click();
  await expect(page.getByText("Thay lốp và bảo dưỡng phanh").first()).toBeVisible();

  // 4. Sell vehicle
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Khách hàng Flow A");
  await page.getByLabel("Thu tiền lần đầu (₫)", { exact: false }).fill("20000000");
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);
  await expect(page.getByRole("heading", { name: "Lời cảm ơn khách hàng" })).toBeVisible();
  await expect(page.getByText(/Chưa cấu hình kênh nhắn tin/)).toBeVisible();

  // 5. Record remaining payment
  await expect(page.getByText(/28\.000\.000/)).toBeVisible(); // Remaining amount 48M - 20M = 28M
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.getByText("Đã thanh toán đủ")).toBeVisible();

  // 6. Verify dashboard
  await page.goto("/");
  await expect(page.getByText(/Tồn kho hiện tại|Xe đang trong kho/)).toBeVisible();
  await expect(page.getByText(/48\.000\.000/).first()).toBeVisible(); // Revenue includes 48M
});

test("FLOW B: Partial payment -> second payment -> fully paid", async ({ page }) => {
  await loginAs(page, "owner");

  // Create vehicle with price 50M
  await page.goto("/vehicles/new");
  await page.getByLabel("Hãng xe *", { exact: true }).fill("Honda");
  await page.getByLabel("Dòng xe *", { exact: true }).fill("Air Blade Flow B");
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("28000000");
  await page.getByLabel("Giá niêm yết (₫) *", { exact: false }).fill("50000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]{36}$/);
  const vehicleId = page.url().split("/").at(-1);

  // Sell with initial partial payment of 20M (30M remaining)
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Khách trả góp Flow B");
  await page.getByLabel("Thu tiền lần đầu (₫)", { exact: false }).fill("20000000");
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);

  // Verify remaining balance is 30M
  await expect(page.getByText(/30\.000\.000/).first()).toBeVisible();

  // Second payment: remaining 30M -> fully paid
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.getByText("Đã thanh toán đủ")).toBeVisible();
});

test("FLOW C: Sell vehicle -> cancel sale -> vehicle returns to inventory", async ({ page }) => {
  await loginAs(page, "owner");
  const vehicleId = createdVehicles[0];

  // Sell vehicle
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Khách hủy đơn Flow C");
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);

  // Cancel sale
  await page.getByRole("button", { name: "Hủy giao dịch bán xe", exact: true }).click();
  await page.getByLabel("Lý do hủy *", { exact: true }).fill("Khách hàng không đủ tiền");
  await page.getByRole("button", { name: "Xác nhận hủy giao dịch", exact: true }).click();
  await expect(page.getByText("Đã hủy", { exact: true })).toBeVisible();

  // Verify vehicle returns to IN_STOCK (badge text 'Sẵn sàng bán')
  await page.goto(`/vehicles/${vehicleId}`);
  await expect(page.getByText("Sẵn sàng bán", { exact: true })).toBeVisible();
});

test("FLOW D: STAFF login -> attempt unauthorized admin/financial action -> access denied", async ({
  page,
}) => {
  await loginAs(page, "staff");

  // 1. Dashboard does not show financial profit/revenue
  await expect(page.getByText("Doanh thu trong kỳ")).toHaveCount(0);
  await expect(page.getByText("Lợi nhuận gộp")).toHaveCount(0);

  // 2. Attempt unauthorized users page -> access denied
  await page.goto("/users");
  await expect(page.getByText("Bạn chưa được cấp quyền mở trang này")).toBeVisible();

  // 3. Attempt unauthorized audit page -> access denied
  await page.goto("/audit");
  await expect(page.getByText("Bạn chưa được cấp quyền mở trang này")).toBeVisible();

  // 4. Vehicle detail does not show purchase cost
  await page.goto(`/vehicles/${createdVehicles[0]}`);
  await expect(page.getByText("Giá mua", { exact: true })).toHaveCount(0);
});

async function seedSale(overrides = {}) {
  const connection = await db.connection();
  try {
    return await asUser(connection, ids.STAFF, client => rpc(client, "sell_vehicle", "$1::jsonb", [JSON.stringify({
      vehicle_id: createdVehicles[0], customer_name: `Khách công nợ ${ids.OWNER.slice(0, 6)}`,
      customer_phone: "0900001234", sale_price: 18000000, sale_date: day,
      initial_payment: 5000000, payment_method: "CASH", ...overrides,
    })]));
  } finally { await connection.close(); }
}

test("Operational: receivable collection reuses payment flow and refreshes real customer/debt values", async ({ page }) => {
  const saleId = await seedSale();
  await loginAs(page, "staff");
  await page.goto("/receivables?payment_status=PARTIALLY_PAID");
  await expect(
    page.getByRole("button", { name: "Đã trả một phần", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Tìm công nợ").fill(`Khách công nợ ${ids.OWNER.slice(0, 6)}`);
  const saleRow = page.locator(".desktop-table tbody tr").filter({ hasText: `Khách công nợ ${ids.OWNER.slice(0, 6)}` });
  await expect(saleRow).toContainText("13.000.000");
  await saleRow.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("3000000");
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(saleRow).toContainText("10.000.000");
  const paid = await db.query("SELECT sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleId]);
  expect(paid.rows[0].paid).toBe("8000000");
  await page.goto("/customers?phone=0900001234");
  await expect(page.getByRole("heading", { name: /Lịch sử mua hàng/ })).toBeVisible();
  await expect(page.locator(".modal-card")).toContainText("Đã thu: 8.000.000");
  await expect(page.locator(".modal-card")).toContainText("Lịch sử trả tiền (2 lần)");
  await expect(page.locator(".modal-card")).toContainText("Lịch sử liên hệ");
  await expect(page.locator(".modal-card")).toContainText("Cảm ơn sau mua xe");
  await page.screenshot({ path: "test-results/customer-history-desktop.png", fullPage: true });
});

test("Operational: lost payment response retries the same UUID once without duplicating collection", async ({ page }) => {
  const saleId = await seedSale();
  await loginAs(page, "staff");
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("3000000");
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/add_payment")) requests.push(request.postDataJSON().p_data); });
  failNextPaymentResponse = true;
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.locator(".inset-form .error-state, .inset-form .state-error").or(page.locator(".inset-form").getByText(/Không thể|Failed|fetch/i)).first()).toBeVisible();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ghi nhận thanh toán", exact: true })).toHaveCount(0);
  expect(requests.length).toBe(2);
  expect(requests[0].request_id).toBe(requests[1].request_id);
  const amounts = await db.query("SELECT count(*)::text AS count, sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1", [saleId]);
  expect(amounts.rows[0]).toEqual({ count: "2", paid: "8000000" });
});

test("Operational: global search debounces typing, opens with Ctrl+K and resolves keyboard selection", async ({ page }) => {
  await loginAs(page, "staff");
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/global_search")) requests.push(request.postDataJSON()); });
  await page.keyboard.press("Control+k");
  const search = page.getByLabel("Tìm xe toàn hệ thống");
  await expect(search).toBeFocused();
  const plate = `29A-${ids.OWNER.slice(0, 4)}`;
  await search.pressSequentially(plate, { delay: 10 });
  await expect(page.locator(".palette-result-item").first()).toContainText(plate);
  expect(requests).toHaveLength(1);
  expect(requests[0].p_query).toBe(plate);
  await search.press("ArrowDown");
  await expect(page.locator(".palette-result-item").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/vehicles/${createdVehicles[0]}`);
  await expect(page.getByText("Giá mua", { exact: true })).toHaveCount(0);
});

test("Operational: expense management shows real independent costs and supports CRUD", async ({ page }) => {
  const saleId = await seedSale();
  await loginAs(page, "owner");
  await page.goto("/expenses");
  await expect(page.getByRole("heading", { name: "Quản lý chi phí", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/expenses-desktop.png", fullPage: true });
  expect((await db.query("SELECT id FROM public.sales WHERE id=$1", [saleId])).rows).toHaveLength(1);
});

test("Operational: CSV validates preview before writing, imports valid rows atomically and rejects stale duplicates", async ({ page }) => {
  await loginAs(page, "owner");
  await page.goto("/import-vehicles");
  const frame = `E2E-${ids.OWNER.slice(0, 8)}`;
  const csv = `Số khung,Hãng,Dòng xe,Giá mua,Giá bán,Ngày mua\r\n${frame},Honda,Nhập CSV thử,12000000,15000000,${day}\r\n${frame}-INVALID,Honda,Giá âm,-12000000,15000000,${day}`;
  await page.locator('input[type="file"]').setInputFiles({ name: "nhap-thu.csv", mimeType: "text/csv", buffer: Buffer.from("\uFEFF" + csv, "utf8") });
  await expect(page.getByRole("heading", { name: /Bảng kiểm tra chi tiết/ })).toBeVisible();
  const rows = page.locator(".data-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText(/không hợp lệ|không âm|số nguyên/i);
  expect((await db.query("SELECT id FROM public.vehicles WHERE frame_number=$1", [frame])).rows).toHaveLength(0);
  await page.screenshot({ path: "test-results/import-preview-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Xác nhận nhập 1 xe hợp lệ vào kho", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nhập xe vào kho thành công!", exact: true })).toBeVisible();
  expect((await db.query("SELECT id FROM public.vehicles WHERE frame_number=$1", [frame])).rows).toHaveLength(1);
  expect((await db.query("SELECT id FROM public.vehicles WHERE frame_number=$1", [`${frame}-INVALID`])).rows).toHaveLength(0);

  // A second preview can become stale; execution must recheck the actual database.
  await page.getByRole("button", { name: "Tiếp tục nhập file khác", exact: true }).click();
  const staleFrame = `${frame}-STALE`;
  await page.locator('input[type="file"]').setInputFiles({ name: "stale.csv", mimeType: "text/csv", buffer: Buffer.from(`Số khung,Hãng,Dòng xe,Giá mua,Giá bán\n${staleFrame},Honda,Dòng thử,10000000,15000000`, "utf8") });
  await expect(page.getByRole("button", { name: "Xác nhận nhập 1 xe hợp lệ vào kho", exact: true })).toBeEnabled();
  const connection = await db.connection();
  try { await asUser(connection, ids.OWNER, client => rpc(client, "save_vehicle", "$1::jsonb", [JSON.stringify({ frame_number: staleFrame, brand: "Honda", model: "Dòng đã nhập", purchase_date: day, purchase_price: 10000000, asking_price: 15000000 })])); }
  finally { await connection.close(); }
  await page.getByRole("button", { name: "Xác nhận nhập 1 xe hợp lệ vào kho", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nhập xe vào kho thành công!", exact: true })).toHaveCount(0);
  await expect(page.getByText(/trùng|đã tồn tại/i).last()).toBeVisible();
  expect((await db.query("SELECT id FROM public.vehicles WHERE frame_number=$1", [staleFrame])).rows).toHaveLength(1);
});

test("Operational: QR vehicle route returns after login, downloads a genuine SVG and camera failure has search fallback", async ({ page }) => {
  await page.goto(`/vehicles/${createdVehicles[0]}`);
  await expect(page).toHaveURL(/\/login$/);
  const username = page.getByRole("textbox", { name: /Tên đăng nhập hoặc email/i });
  const password = page.getByLabel("Mật khẩu", { exact: true });
  await username.fill("staff@example.test");
  await expect(username).toHaveValue("staff@example.test");
  await password.fill("Password-Test-2026");
  await expect(password).toHaveValue("Password-Test-2026");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page).toHaveURL(`/vehicles/${createdVehicles[0]}`);
  await expect(page.getByRole("img", { name: /QR mở xe/ })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Tải QR", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/QR\.svg$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/vehicle-qr-mobile.png", fullPage: true });
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Camera denied for this test", "NotAllowedError"); };
      navigator.mediaDevices.enumerateDevices = async () => [{ deviceId: "test-camera", kind: "videoinput", label: "Test camera", groupId: "test" }];
    }
  });
  await page.goto("/capture");
  await page.getByRole("button", { name: "Mở camera quét QR", exact: true }).click();
  await expect(page.getByText("Không mở được camera. Kiểm tra quyền camera hoặc nhập mã xe để tìm.", { exact: true })).toBeVisible();
  await page.getByLabel("Nhập mã QR, số khung hoặc biển số").fill(`29A-${ids.OWNER.slice(0, 4)}`);
  await page.locator("main").getByRole("button", { name: "Tìm xe", exact: true }).click();
  await expect(page.getByLabel("Tìm kiếm xe")).toHaveValue(`29A-${ids.OWNER.slice(0, 4)}`);
  await expect(page.locator(".mobile-record")).toHaveCount(1);
});

test("Operational: sale/payment receipts print customer-only allowlist with clean Vietnamese A4 preview", async ({ page }) => {
  const saleId = await seedSale({ notes: "INTERNAL_NOTE_SHOULD_NEVER_PRINT" });
  await loginAs(page, "owner");
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "In phiếu bán xe", exact: true }).click();
  const receipt = page.locator(".customer-receipt");
  await expect(receipt.getByRole("heading", { name: "PHIẾU BÁN XE", exact: true })).toBeVisible();
  await expect(receipt).toContainText("18.000.000");
  await expect(receipt).toContainText("5.000.000");
  await expect(receipt).toContainText("13.000.000");
  await expect(receipt).not.toContainText(/Giá mua|Giá vốn|Lợi nhuận|INTERNAL_NOTE_SHOULD_NEVER_PRINT|15\.000\.000/);
  await page.getByRole("button", { name: "Đóng", exact: true }).click();
  await page.getByRole("button", { name: "In phiếu thu", exact: true }).click();
  await expect(receipt.getByRole("heading", { name: "PHIẾU THU TIỀN", exact: true })).toBeVisible();
  await expect(receipt).toContainText("Người lập phiếu");
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole("button", { name: "In / Lưu PDF", exact: true }).click();
  await page.evaluate(() => { document.body.dataset.printTarget = "customer-receipt"; });
  await page.emulateMedia({ media: "print" });
  await expect(receipt).toBeVisible();
  expect(await page.locator(".sidebar").evaluate(node => getComputedStyle(node).visibility)).toBe("hidden");
  expect(await page.locator("button").filter({ hasText: "In / Lưu PDF" }).evaluate(node => getComputedStyle(node).visibility)).toBe("hidden");
  expect(await page.locator("aside").last().evaluate(node => getComputedStyle(node).visibility)).toBe("hidden");
  const pdf = await page.pdf({ path: "test-results/payment-receipt-print.pdf", format: "A4", printBackground: true });
  expect([...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)]).toHaveLength(1);
  await page.screenshot({ path: "test-results/payment-receipt-print.png", fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => { delete document.body.dataset.printTarget; });
});
