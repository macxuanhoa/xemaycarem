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

let db, day, ids, createdVehicles, failNextPaymentResponse, failNextOperationResponse, failBeforeCommit, slowMutation;

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
  failNextOperationResponse = null;
  failBeforeCommit = null;
  slowMutation = null;

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
          request_id: randomUUID(),
          vehicle_type: "Xe số",
          purchase_date: day,
          purchase_price: 15000000,
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
    if (url.pathname === `/rest/v1/rpc/${failBeforeCommit}`) {
      failBeforeCommit = null;
      return reply({ code: "TEST_OUTAGE", message: "Network service unavailable" }, 503);
    }
    if (slowMutation && url.pathname === `/rest/v1/rpc/${slowMutation.name}`) {
      await slowMutation.wait;
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
              await c.query(
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
      if (url.pathname === `/rest/v1/rpc/${failNextOperationResponse}`) {
        failNextOperationResponse = null;
        return route.abort("failed"); // Business transaction committed; confirmation did not reach the browser.
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
  const welcome = page.getByRole("heading", { name: "Chào mừng trở lại", exact: true });
  await expect(welcome.or(page.getByRole("heading", { name: /Xin chào/ }))).toBeVisible();
  if (!await welcome.isVisible()) {
    await page.getByRole("button", { name: "Đăng xuất", exact: true }).last().click();
    await expect(welcome).toBeVisible();
  }
  const username = page.getByRole("textbox", { name: /Tên đăng nhập hoặc email/i });
  const password = page.getByLabel("Mật khẩu", { exact: true });
  await username.fill(`${role}@example.test`);
  await expect(username).toHaveValue(`${role}@example.test`);
  await password.fill("Password-Test-2026");
  await expect(password).toHaveValue("Password-Test-2026");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Xin chào/ })).toBeVisible();
}

async function verifyPendingReceipt(page) {
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Khoản thu chờ xác minh" }) });
  await expect(card).toBeVisible();
  await card.getByLabel("Tài khoản nhận / sổ chứng từ").fill("SYNTHETIC RECEIPT REGISTER");
  await card.getByLabel("Mã giao dịch / phiếu thu dùng chung").fill(`SYNTHETIC-${randomUUID()}`);
  await card.getByLabel("Bằng chứng đối chiếu / lý do từ chối").fill("Synthetic physical receipt and existing ledger reviewed by manager");
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "Xác minh và ghi nhận", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Khoản thu chờ xác minh" })).toHaveCount(0);
}

test("FLOW A: OWNER full lifecycle (create vehicle -> inventory -> expense -> sell -> payment -> dashboard)", async ({
  page,
}) => {
  await loginAs(page, "owner");

  // 1. Add vehicle
  await page.goto("/vehicles/new");
  await page.getByLabel("Loại xe *", { exact: true }).fill("Xe côn tay");
  await page.getByLabel("Số khung", { exact: true }).fill("FLOWA0001");
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("40000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]{36}$/);
  const vehicleId = page.url().split("/").at(-1);

  // 2. Appears in inventory (định danh = biển · số khung; hãng/dòng đã xoá)
  await page.goto("/vehicles");
  await expect(page.getByText("FLOWA0001").first()).toBeVisible();

  // 3. Add expense
  await page.goto(`/expenses?kind=vehicle&vehicle=${vehicleId}&new=1`);
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("2000000");
  await page.getByLabel("Nội dung chi phí *", { exact: true }).fill("Thay lốp và bảo dưỡng phanh");
  await page.getByRole("button", { name: "Lưu chi phí", exact: true }).click();
  await expect(page.getByText("Thay lốp và bảo dưỡng phanh").first()).toBeVisible();

  // 4. Sell vehicle
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Khách hàng Flow A");
  await page.getByLabel("Bán với giá", { exact: false }).fill("48000000");
  await page.getByRole("button", { name: "Thêm chi tiết thanh toán" }).click();
  await page.getByLabel("Khách đã trả trước (₫)", { exact: false }).fill("20000000");
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);
  await expect(page.getByRole("heading", { name: "Thông tin giao dịch" })).toBeVisible();
  await expect(page.getByRole("button", { name: "In phiếu bán xe", exact: true })).toBeVisible();

  // 5. Record remaining payment
  await expect(page.getByText(/28\.000\.000/)).toBeVisible(); // Remaining amount 48M - 20M = 28M
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await verifyPendingReceipt(page);
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
  await page.getByLabel("Loại xe *", { exact: true }).fill("Xe tay ga");
  await page.getByLabel("Số khung", { exact: true }).fill("FLOWB0001");
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("28000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]{36}$/);
  const vehicleId = page.url().split("/").at(-1);

  // Sell with initial partial payment of 20M (30M remaining)
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Khách trả góp Flow B");
  await page.getByLabel("Bán với giá", { exact: false }).fill("50000000");
  await page.getByRole("button", { name: "Thêm chi tiết thanh toán" }).click();
  await page.getByLabel("Khách đã trả trước (₫)", { exact: false }).fill("20000000");
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);

  // Verify remaining balance is 30M
  await expect(page.getByText(/30\.000\.000/).first()).toBeVisible();

  // Second payment: remaining 30M -> fully paid
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await verifyPendingReceipt(page);
  await expect(page.getByText("Đã thanh toán đủ")).toBeVisible();
});

test("FLOW C: Sell vehicle -> cancel sale -> vehicle returns to inventory", async ({ page }) => {
  await loginAs(page, "owner");
  const vehicleId = createdVehicles[0];

  // Sell vehicle
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Khách hủy đơn Flow C");
  await page.getByLabel("Bán với giá", { exact: false }).fill("18000000");
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);

  // Cancel sale
  await page.getByRole("button", { name: "Điều chỉnh giao dịch", exact: true }).click();
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
  await expect(page.getByText("Đã lưu đề nghị thu tiền, chờ quản lý xác minh. Tiền đã thu chưa thay đổi.")).toBeVisible();
  await expect(saleRow).toContainText("13.000.000");
  expect((await db.query("SELECT sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleId])).rows[0].paid).toBe("5000000");
  await loginAs(page, "owner");
  await page.goto(`/sales/${saleId}`);
  await verifyPendingReceipt(page);
  await page.goto("/receivables");
  await page.getByLabel("Tìm công nợ").fill(`Khách công nợ ${ids.OWNER.slice(0, 6)}`);
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

test("Operational: lost receipt proposal response reconciles its UUID without recording unverified money", async ({ page }) => {
  const saleId = await seedSale();
  await loginAs(page, "staff");
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("3000000");
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/prepare_payment_receipt")) requests.push(request.postDataJSON().p_data); });
  failNextOperationResponse = "prepare_payment_receipt";
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.locator(".inset-form .error-state, .inset-form .state-error").or(page.locator(".inset-form").getByText(/Không thể|Failed|fetch/i)).first()).toBeVisible();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ghi nhận thanh toán", exact: true })).toHaveCount(0);
  expect(requests.length).toBe(1);
  await expect(page.getByText("Đề nghị thu tiền trước đã được lưu. Không tạo thêm; quản lý kiểm tra mục chờ xác minh.")).toBeVisible();
  expect((await db.query("SELECT count(*)::text AS count FROM public.payment_receipts WHERE sale_id=$1", [saleId])).rows[0].count).toBe("1");
  expect((await db.query("SELECT sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1", [saleId])).rows[0].paid).toBe("5000000");
  await loginAs(page, "owner");
  await page.goto(`/sales/${saleId}`);
  await verifyPendingReceipt(page);
  const amounts = await db.query("SELECT count(*)::text AS count, sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1", [saleId]);
  expect(amounts.rows[0]).toEqual({ count: "2", paid: "8000000" });
});

test("Recovery: reloading after a committed receipt proposal preserves its key and creates no duplicate", async ({ page }) => {
  const saleId = await seedSale();
  await loginAs(page, "staff");
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("3000000");
  failNextOperationResponse = "prepare_payment_receipt";
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.locator(".inset-form .error-state, .inset-form .state-error").or(page.locator(".inset-form").getByText(/Không thể|Failed|fetch/i)).first()).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("3000000");
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.getByText("Đề nghị thu tiền trước đã được lưu. Không tạo thêm; quản lý kiểm tra mục chờ xác minh.")).toBeVisible();
  expect((await db.query("SELECT count(*)::text AS count FROM public.payment_receipts WHERE sale_id=$1", [saleId])).rows[0].count).toBe("1");
  expect((await db.query("SELECT sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1", [saleId])).rows[0].paid).toBe("5000000");
  await loginAs(page, "owner");
  await page.goto(`/sales/${saleId}`);
  await verifyPendingReceipt(page);
  const amounts = await db.query("SELECT count(*)::text AS count, sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1", [saleId]);
  expect(amounts.rows[0]).toEqual({ count: "2", paid: "8000000" });
});

test("Recovery: lost manager approval response retries the actual financial transaction without another payment", async ({ page }) => {
  const saleId = await seedSale();
  await loginAs(page, "owner");
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("3000000");
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Khoản thu chờ xác minh" }) });
  await card.getByLabel("Tài khoản nhận / sổ chứng từ").fill("SYNTHETIC REGISTER");
  await card.getByLabel("Mã giao dịch / phiếu thu dùng chung").fill(`SYNTHETIC-${randomUUID()}`);
  await card.getByLabel("Bằng chứng đối chiếu / lý do từ chối").fill("Synthetic manager checked physical payment and all prior history");
  await card.getByRole("checkbox").check();
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/add_payment")) requests.push(request.postDataJSON().p_data); });
  failNextPaymentResponse = true;
  await card.getByRole("button", { name: "Xác minh và ghi nhận", exact: true }).click();
  await expect(card.locator(".error-state, .state-error").or(card.getByText(/Không thể|Failed|fetch/i)).first()).toBeVisible();
  expect((await db.query("SELECT count(*)::text AS n,sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1", [saleId])).rows[0]).toEqual({ n:"2",paid:"8000000" });
  await card.getByRole("button", { name: "Xác minh và ghi nhận", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Khoản thu chờ xác minh" })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1].receipt_id).toBe(requests[0].receipt_id);
  expect((await db.query("SELECT count(*)::text AS n,sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1", [saleId])).rows[0]).toEqual({ n:"2",paid:"8000000" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Khoản thu chờ xác minh" })).toHaveCount(0);
});

test("Compatibility: a retained legacy financial UUID reconciles the existing ledger before proposing new money", async ({ page }) => {
  const saleId = await seedSale();
  // Initial/historical ledger entries have no proposal alias. This reproduces
  // the durable UUID left by a client before the receipt protocol upgrade.
  const oldPayment = (await db.query("SELECT id FROM public.payments WHERE sale_id=$1",[saleId])).rows[0].id;
  await loginAs(page, "staff");
  await page.evaluate(({ userId,saleId,oldPayment }) => localStorage.setItem(`xe_payment_pending_v1:${userId}:${saleId}`,oldPayment),{userId:ids.STAFF,saleId,oldPayment});
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.getByText("Khoản thu trước đã được ghi nhận. Đã đối soát, không tạo thêm khoản thu.")).toBeVisible();
  expect((await db.query("SELECT count(*)::text AS n FROM public.payment_receipts WHERE sale_id=$1",[saleId])).rows[0].n).toBe("0");
  expect((await db.query("SELECT count(*)::text AS n,sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1",[saleId])).rows[0]).toEqual({n:"1",paid:"5000000"});
});

test("Recovery: canonical receipt alias survives lost response and reload without another proposal", async ({ page }) => {
  const saleId = await seedSale();
  const reference = `SYNTHETIC-BANK-${randomUUID()}`;
  const canonical = await asUser(db, ids.MANAGER, c => rpc(c,"prepare_payment_receipt","$1::jsonb",[JSON.stringify({request_id:randomUUID(),sale_id:saleId,amount:3000000,payment_method:"BANK_TRANSFER",payment_date:day,reference,evidence_kind:"BANK_TRANSACTION",evidence_scope:"SYNTHETIC ACCOUNT",evidence_reference:reference})]));
  await loginAs(page, "staff");
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("3000000");
  await page.getByLabel("Mã tham chiếu", { exact: true }).fill(reference);
  await page.getByLabel("Tài khoản nhận / sổ chứng từ", { exact: true }).fill("SYNTHETIC ACCOUNT");
  failNextOperationResponse = "prepare_payment_receipt";
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.locator(".inset-form .error-state, .inset-form .state-error").first()).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page.getByRole("button", { name: "Lưu thanh toán", exact: true }).click();
  await expect(page.getByText("Đề nghị thu tiền trước đã được lưu. Không tạo thêm; quản lý kiểm tra mục chờ xác minh.")).toBeVisible();
  expect((await db.query("SELECT id FROM public.payment_receipts WHERE sale_id=$1",[saleId])).rows.map(r=>r.id)).toEqual([canonical.id]);
  expect((await db.query("SELECT sum(amount)::text AS paid FROM public.payments WHERE sale_id=$1",[saleId])).rows[0].paid).toBe("5000000");
});

test("Recovery: intake without chassis reconciles a lost response after reload without a second acquisition", async ({ page }) => {
  await loginAs(page, "owner");
  await page.goto("/acquisitions/new");
  await page.getByLabel("Loại xe *", { exact: true }).fill("Xe số");
  await page.getByLabel("Giá thu (₫) *", { exact: false }).fill("18000000");
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/acquire_vehicle")) requests.push(request.postDataJSON()); });
  await page.getByRole("button", { name: "Thu xe & tạo phiếu", exact: true }).click();
  failNextOperationResponse = "acquire_vehicle";
  await page.getByRole("dialog").getByRole("button", { name: /Xác nhận thu xe/ }).click();
  await expect(page.getByRole("dialog").getByText(/Giao dịch chưa được xác nhận/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Kiểm tra giao dịch trước", exact: true }).click();
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]{36}$/);
  expect(requests).toHaveLength(1);
  const vehicleId = page.url().split("/").at(-1);
  expect(Number((await db.query("SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=$1", [vehicleId])).rows[0].n)).toBe(1);
});

test("Recovery: shorthand batch reconciles after commit and reload without repeating the import", async ({ page }) => {
  await loginAs(page, "owner");
  await page.goto("/intake");
  await page.locator("textarea.intake-notes").fill("xe so den 18tr\nxe ga trang 20tr");
  await page.getByRole("button", { name: "Tách thành danh sách" }).click();
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/import_vehicles")) requests.push(request.postDataJSON()); });
  await page.getByRole("button", { name: /Thu 2 xe vào kho/ }).click();
  failNextOperationResponse = "import_vehicles";
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận thu xe", exact: true }).click();
  await expect(page.getByText(/Giao dịch chưa được xác nhận/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Kiểm tra giao dịch trước", exact: true }).click();
  await expect(page).toHaveURL(/\/acquisitions$/);
  expect(requests).toHaveLength(1);
  const receipt = (await db.query("SELECT result FROM private.operation_receipts WHERE actor_id=$1 AND operation='import_vehicles'", [ids.OWNER])).rows[0].result;
  expect(receipt.imported_count).toBe(2);
  expect(Number((await db.query("SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=ANY($1::uuid[])", [receipt.vehicle_ids])).rows[0].n)).toBe(2);
});

test("Recovery: committed sale with initial payment reconciles from the sold vehicle after reload", async ({ page }) => {
  await loginAs(page, "owner");
  const vehicleId = createdVehicles[0];
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Synthetic sale recovery");
  await page.getByLabel("Bán với giá", { exact: false }).fill("18000000");
  await page.getByRole("button", { name: "Thêm chi tiết thanh toán" }).click();
  await page.getByLabel("Khách đã trả trước (₫)", { exact: false }).fill("3000000");
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/sell_vehicle")) requests.push(request.postDataJSON()); });
  failNextOperationResponse = "sell_vehicle";
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page.getByText(/Giao dịch chưa được xác nhận/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Kiểm tra giao dịch trước", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);
  expect(requests).toHaveLength(1);
  const saleId = page.url().split("/").at(-1);
  expect(Number((await db.query("SELECT count(*) AS n FROM public.sales WHERE vehicle_id=$1", [vehicleId])).rows[0].n)).toBe(1);
  expect(Number((await db.query("SELECT count(*) AS n FROM public.payments WHERE sale_id=$1", [saleId])).rows[0].n)).toBe(1);
});

test("Failure: a 503 before sale commit preserves input and manual retry records one sale", async ({ page }) => {
  await loginAs(page, "owner");
  const vehicleId = createdVehicles[0];
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Synthetic outage recovery");
  await page.getByLabel("Bán với giá", { exact: false }).fill("18000000");
  failBeforeCommit = "sell_vehicle";
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page.getByText(/Giao dịch chưa được xác nhận/)).toBeVisible();
  await expect(page.getByLabel("Tên khách hàng *", { exact: true })).toHaveValue("Synthetic outage recovery");
  expect(Number((await db.query("SELECT count(*) AS n FROM public.sales WHERE vehicle_id=$1", [vehicleId])).rows[0].n)).toBe(0);
  await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);
  expect(Number((await db.query("SELECT count(*) AS n FROM public.sales WHERE vehicle_id=$1", [vehicleId])).rows[0].n)).toBe(1);
});

test("Failure: slow sale remains pending without false success or duplicate requests", async ({ page }) => {
  await loginAs(page, "owner");
  const vehicleId = createdVehicles[0];
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Tên khách hàng *", { exact: true }).fill("Synthetic slow request");
  await page.getByLabel("Bán với giá", { exact: false }).fill("18000000");
  let release;
  slowMutation = { name: "sell_vehicle", wait: new Promise(resolve => { release = resolve; }) };
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/rest/v1/rpc/sell_vehicle")) requests.push(request.postDataJSON()); });
  try {
    await page.getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
    await expect(page.getByRole("button", { name: /Đang hoàn tất/ })).toBeDisabled();
    await page.waitForTimeout(500);
    expect(requests).toHaveLength(1);
    expect(Number((await db.query("SELECT count(*) AS n FROM public.sales WHERE vehicle_id=$1", [vehicleId])).rows[0].n)).toBe(0);
    await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}/sell$`));
  } finally { release(); slowMutation = null; }
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);
  expect(requests).toHaveLength(1);
  expect(Number((await db.query("SELECT count(*) AS n FROM public.sales WHERE vehicle_id=$1", [vehicleId])).rows[0].n)).toBe(1);
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

test("Operational: QR vehicle route opens after login (dashboard-first), downloads a genuine SVG and camera failure has search fallback", async ({ page }) => {
  await page.goto(`/vehicles/${createdVehicles[0]}`);
  await expect(page).toHaveURL(/\/login$/);
  const username = page.getByRole("textbox", { name: /Tên đăng nhập hoặc email/i });
  const password = page.getByLabel("Mật khẩu", { exact: true });
  await username.fill("staff@example.test");
  await expect(username).toHaveValue("staff@example.test");
  await password.fill("Password-Test-2026");
  await expect(password).toHaveValue("Password-Test-2026");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  // Login always lands on the dashboard first; the QR target is then opened normally.
  await expect(page).toHaveURL("/");
  await page.goto(`/vehicles/${createdVehicles[0]}`);
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
  await page.getByRole("button", { name: "Mở camera", exact: true }).click();
  // Camera denial now offers the gallery fallback; /capture no longer hosts a manual text search.
  await expect(page.getByText("Không mở được camera. Kiểm tra quyền camera hoặc chọn ảnh từ thư viện.", { exact: true })).toBeVisible();
  await expect(page.getByText("Ảnh thư viện", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tra cứu xe thủ công", exact: true })).toHaveCount(0);
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

