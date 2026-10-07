import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDatabase, asUser, rpc } from "../../scripts/db-harness.mjs";

// Only the hosted HTTP/Auth boundary is simulated. All business RPCs, RLS and
// financial calculations execute the actual migrations on PostgreSQL.
let db, day, ids, vehicles, failNextInventoryResponse;
test.beforeAll(async () => {
  db = await createDatabase({ engine: "postgres" });
});
test.afterAll(async () => {
  await db?.close();
});
test.beforeEach(async ({ page }) => {
  day = (await db.query("select private.today()::text as day")).rows[0].day;
  ids = { OWNER: randomUUID(), STAFF: randomUUID() };
  vehicles = [];
  failNextInventoryResponse = false;
  for (const [role, id] of Object.entries(ids)) {
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        id,
        `${id}@example.test`,
        JSON.stringify({ full_name: `Kiểm thử ${role}` }),
      ],
    );
    await db.query(
      "update public.profiles set role=$1,active=true where id=$2",
      [role, id],
    );
  }
  const connection = await db.connection();
  try {
    for (let i = 0; i < 3; i++)
      vehicles.push(
        await asUser(connection, ids.OWNER, (c) =>
          rpc(c, "save_vehicle", "$1::jsonb", [
            JSON.stringify({
              request_id: randomUUID(),
              brand: i === 1 ? "Yamaha" : "Honda",
              model: `Test ${ids.OWNER.slice(0, 5)} ${i}`,
              purchase_date: day,
              purchase_price: 80000000 + i * 1000000,
              asking_price: 90000000 + i * 1000000,
              license_plate: `TEST-${ids.OWNER.slice(0, 5)}-${i}`,
              year: 2024,
            }),
          ]),
        ),
      );
  } finally {
    await connection.close();
  }
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
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
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
      const role = body.email?.split("@")[0].toUpperCase();
      const id =
        ids[role] ??
        Object.values(ids).find(
          (value) => body.email === `${value}@example.test`,
        );
      if (!id || body.password !== "Password-Test-2026")
        return reply(
          {
            error: "invalid_grant",
            error_description: "Invalid login credentials",
          },
          400,
        );
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
          "base64url",
        ).toString(),
      ).sub;
    } catch {
      /* anonymous */
    }
    if (url.pathname === "/auth/v1/logout")
      return route.fulfill({ status: 204 });
    if (url.pathname === "/auth/v1/user")
      return userId
        ? reply(authUser(userId))
        : reply({ message: "Unauthorized" }, 401);
    const client = await db.connection();
    try {
      const result = await asUser(
        client,
        userId,
        async (c) => {
          if (url.pathname === "/rest/v1/profiles")
            return (
              (
                await c.query(
                  "select * from public.profiles where id=$1",
                  [userId],
                )
              ).rows[0] ?? null
            );
          if (url.pathname.startsWith("/rest/v1/rpc/")) {
            const name = url.pathname.split("/").at(-1);
            if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid RPC");
            const signature = (
              await c.query(
                "select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",
                [name],
              )
            ).rows[0]?.args;
            if (signature === undefined)
              throw new Error(`RPC missing: ${name}`);
            const types = Object.fromEntries(
              signature
                .split(/,(?![^(]*\))/)
                .map((s) => s.trim())
                .filter(Boolean)
                .map((pair) => {
                  const cleaned = pair.replace(/\s+DEFAULT\s+.*$/i, "").trim();
                  const space = cleaned.indexOf(" ");
                  return [cleaned.slice(0, space), cleaned.slice(space + 1)];
                }),
            );
            const entries = Object.entries(body);
            if (entries.some(([k]) => !types[k]))
              throw new Error("Unknown RPC argument");
            const sql = entries
              .map(([k], i) => `${k}=>$${i + 1}::${types[k]}`)
              .join(",");
            const values = entries.map(([k, v]) =>
              types[k] === "jsonb" ? JSON.stringify(v) : v,
            );
            return rpc(c, name, sql, values);
          }
          throw new Error(`Unhandled test endpoint ${url.pathname}`);
        },
        userId ? "authenticated" : "anon",
      );
      if (url.pathname.endsWith("/rpc/save_vehicle") && !body.p_id && failNextInventoryResponse) {
        // The actual PostgreSQL RPC has committed; only the browser response is lost.
        failNextInventoryResponse = false;
        return route.abort("failed");
      }
      return reply(result);
    } catch (error) {
      return reply({ code: error.code ?? "TEST", message: error.message }, 400);
    } finally {
      await client.close();
    }
  });
});
async function login(page, role = "owner") {
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
  await expect(
    page.getByText(/Tồn kho hiện tại|Xe đang trong kho/),
  ).toBeVisible();
}
async function noOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

test("Inventory creation: lost committed response survives reload and reconciles without duplicate stock", async ({ page }) => {
  await login(page);
  await page.goto("/vehicles/new");
  const model = `Synthetic stock recovery ${ids.OWNER.slice(0, 8)}`;
  const requests = [];
  page.on("request", request => {
    if (request.url().endsWith("/rest/v1/rpc/save_vehicle")) requests.push(request.postDataJSON());
  });
  await page.getByLabel("Hãng xe", { exact: true }).fill("Honda");
  await page.getByLabel("Dòng xe *", { exact: true }).fill(model);
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("18000000");
  await page.getByLabel("Giá niêm yết (₫) *", { exact: false }).fill("20000000");
  failNextInventoryResponse = true;
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(page.getByText(/Giao dịch chưa được xác nhận/)).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].p_data.request_id).toMatch(/^[0-9a-f-]{36}$/i);
  const created = (await db.query("SELECT id FROM public.vehicles WHERE created_by=$1 AND model=$2", [ids.OWNER, model])).rows;
  expect(created).toHaveLength(1);
  await page.reload();
  await page.getByRole("button", { name: "Kiểm tra giao dịch trước", exact: true }).click();
  await expect(page).toHaveURL(`/vehicles/${created[0].id}`);
  expect(requests).toHaveLength(1);
  const proof = (await db.query("SELECT (SELECT count(*) FROM public.vehicles WHERE created_by=$1 AND model=$2) AS stock,(SELECT count(*) FROM public.vehicle_financials WHERE vehicle_id=$3) AS costs,(SELECT count(*) FROM public.acquisitions WHERE vehicle_id=$3) AS acquisitions,(SELECT count(*) FROM public.audit_logs WHERE entity_id=$3 AND action='CREATE_VEHICLE') AS audits", [ids.OWNER, model, created[0].id])).rows[0];
  expect(Object.values(proof).map(Number)).toEqual([1, 1, 0, 1]);
});

test("Owner: login, persistent session, add/edit vehicle, expense, sale, payment, cancellation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await page.reload();
  await expect(
    page.getByText(/Tồn kho hiện tại|Xe đang trong kho/),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.goto("/vehicles/new");
  await page.getByLabel("Hãng xe", { exact: true }).fill("Honda");
  await page.getByLabel("Dòng xe *", { exact: true }).fill("SH Kiểm thử UI");
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("80000000");
  await page.getByLabel("Giá niêm yết (₫) *", { exact: false }).fill("90000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]{36}$/);
  const vehicleId = page.url().split("/").at(-1);
  await page.goto(`/vehicles/${vehicleId}/edit`);
  await page.getByLabel("Màu sắc", { exact: true }).fill("Đen");
  await page.getByRole("button", { name: "Lưu thay đổi", exact: true }).click();
  await expect(page).toHaveURL(`/vehicles/${vehicleId}`);
  await page.goto(`/expenses?kind=vehicle&vehicle=${vehicleId}&new=1`);
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("1200000");
  await page
    .getByLabel("Nội dung chi phí *", { exact: true })
    .fill("Thay phụ tùng kiểm thử");
  await page.getByRole("button", { name: "Lưu chi phí", exact: true }).click();
  await expect(page.getByText("Thay phụ tùng kiểm thử").first()).toBeVisible();
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page
    .getByLabel("Tên khách hàng *", { exact: true })
    .fill("Khách kiểm thử UI");
  await page
    .getByLabel("Thu tiền lần đầu (₫)", { exact: false })
    .fill("20000000");
  await page
    .getByRole("button", { name: "Xác nhận bán xe", exact: true })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);
  const saleId = page.url().split("/").at(-1);
  await expect(page.getByText(/8\.800\.000/)).toBeVisible();
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page
    .getByRole("button", { name: "Lưu thanh toán", exact: true })
    .click();
  // Preparation is asynchronous. Wait for the editor to close and the manager
  // review to appear before filling its account field (both forms share a label).
  await expect(page.getByRole("heading", { name: "Ghi nhận thanh toán", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Khoản thu chờ xác minh", exact: true })).toBeVisible();
  await page.getByLabel("Tài khoản nhận / sổ chứng từ").fill("SYNTHETIC WORKFLOW REGISTER");
  await page.getByLabel("Mã giao dịch / phiếu thu dùng chung").fill(`SYNTHETIC-${randomUUID()}`);
  await page.getByLabel("Bằng chứng đối chiếu / lý do từ chối").fill("Synthetic manager verified receipt and existing ledger");
  await page.getByRole("checkbox", { name: /Đã kiểm tra tiền thực nhận/ }).check();
  await expect(page.getByLabel("Tài khoản nhận / sổ chứng từ")).toHaveValue("SYNTHETIC WORKFLOW REGISTER");
  await expect(page.getByRole("button", { name: "Xác minh và ghi nhận", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Xác minh và ghi nhận", exact: true }).click();
  await expect(page.getByText("Đã thanh toán đủ")).toBeVisible();
  await page
    .getByRole("button", { name: "Hủy giao dịch bán xe", exact: true })
    .click();
  await page
    .getByLabel("Lý do hủy *", { exact: true })
    .fill("Kiểm thử hoàn trả xe");
  await page
    .getByRole("button", { name: "Xác nhận hủy giao dịch", exact: true })
    .click();
  await expect(page.getByText("Đã hủy", { exact: true })).toBeVisible();
  const final = await db.query(
    "select v.status,s.status as sale_status from public.vehicles v join public.sales s on s.vehicle_id=v.id where s.id=$1",
    [saleId],
  );
  expect(final.rows[0]).toEqual({
    status: "IN_STOCK",
    sale_status: "CANCELLED",
  });
  expect(errors).toEqual([]);
});

test("Mobile: inventory cards, global search, quick sale, no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await noOverflow(page);
  await page.goto("/vehicles");
  await expect(page.locator(".mobile-record").first()).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: "test-results/inventory-mobile.png",
    fullPage: true,
  });
  const plate = `TEST-${ids.OWNER.slice(0, 5)}-0`;
  await page.getByRole("button", { name: "Tìm xe toàn hệ thống", exact: true }).click();
  await page.getByRole("searchbox", { name: "Tìm xe toàn hệ thống", exact: true }).fill(plate);
  await expect(page.locator(".palette-result-item").first()).toContainText(plate);
  await page.getByRole("searchbox", { name: "Tìm xe toàn hệ thống", exact: true }).press("Enter");
  await expect(page).toHaveURL(`/vehicles/${vehicles[0]}`);
  await page.goto("/sell");
  await expect(
    page.getByRole("heading", { name: "Tạo giao dịch bán xe" }),
  ).toBeVisible();
  await noOverflow(page);
  await page.goto(`/vehicles/${vehicles[0]}/sell`);
  await expect(
    page.getByRole("heading", { name: "Bán xe", exact: true }),
  ).toBeVisible();
  await noOverflow(page);
});

test("Staff: financial fields absent, forbidden routes blocked, disabled user rejected", async ({
  page,
}) => {
  await login(page, "staff");
  await expect(page.getByText("Doanh thu trong kỳ")).toHaveCount(0);
  await page.goto(`/vehicles/${vehicles[0]}`);
  await expect(page.getByText("Giá mua", { exact: true })).toHaveCount(0);
  await page.goto("/users");
  await expect(
    page.getByText("Bạn chưa được cấp quyền mở trang này"),
  ).toBeVisible();
  await db.query("update public.profiles set active=false where id=$1", [
    ids.STAFF,
  ]);
  await page.reload();
  await expect(
    page.getByText(/Tài khoản đã bị vô hiệu hóa|Tài khoản chưa được cấp quyền hoặc đã bị khóa/),
  ).toBeVisible();
});

test("Owner: audit and settings routes", async ({
  page,
}) => {
  await login(page);
  await page.goto("/audit");
  await expect(page.locator(".audit-record").first()).toBeVisible();
  await page.locator(".audit-record summary").first().click();
  // The record body now leads with a plain-language sentence and keeps the raw
  // before/after JSON behind a collapsed "dữ liệu thô" panel for forensics.
  await expect(
    page.locator(".audit-record-body .audit-lead").first(),
  ).toBeVisible();
  await page.locator(".audit-raw > summary").first().click();
  await expect(
    page.getByText("Trước thay đổi", { exact: true }).first(),
  ).toBeVisible();
  await page.goto("/users");
  await expect(
    page.getByRole("heading", { name: "Nhân sự", exact: true }),
  ).toBeVisible();
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Hồ sơ của bạn" }),
  ).toBeVisible();
  // Store identity now lives in the owner-only "Thông tin cửa hàng" tab.
  await page.getByRole("button", { name: "Thông tin cửa hàng", exact: true }).click();
  await page
    .getByLabel("Tên cửa hàng", { exact: true })
    .fill("Cửa hàng kiểm thử UI");
  await page.getByRole("button", { name: "Lưu cài đặt", exact: true }).click();
  await expect(page.getByText("Đã lưu cài đặt cửa hàng.")).toBeVisible();
  await page.getByRole("button", { name: "Hồ sơ & Đổi mật khẩu", exact: true }).click();
  await page
    .getByLabel("Mật khẩu hiện tại", { exact: true })
    .fill("Password-Test-2026");
  await page
    .getByLabel("Mật khẩu mới", { exact: true })
    .fill("Password-Changed-2026");
  await page
    .getByRole("button", { name: "Cập nhật mật khẩu", exact: true })
    .click();
  await expect(
    page.getByText("Đã cập nhật mật khẩu.", { exact: true }),
  ).toBeVisible();
});

test("Owner: shared working hours live in one Settings tab, not the staff page", async ({
  page,
}) => {
  await login(page);
  // The inline card was collapsed into the owner-only "Giờ làm việc" tab.
  await page.goto("/users");
  await expect(
    page.getByText("Giờ làm việc chung của Quản lý & Nhân viên"),
  ).toHaveCount(0);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Giờ làm việc", exact: true }).click();
  await expect(
    page.getByText("Giờ làm việc chung của Quản lý & Nhân viên"),
  ).toBeVisible();
  await page.getByLabel("Giờ bắt đầu làm việc").fill("06:00");
  await page.getByLabel("Giờ kết thúc làm việc").fill("12:59");
  await page
    .getByRole("button", { name: "Lưu giờ làm việc chung", exact: true })
    .click();
  await expect(
    page.getByText("Đã cập nhật giờ làm việc chung cho Quản lý và Nhân viên."),
  ).toBeVisible();
  // The inputs keep the saved window after the settings refetch (no revert).
  await expect(page.getByLabel("Giờ bắt đầu làm việc")).toHaveValue("06:00");
  await expect(page.getByLabel("Giờ kết thúc làm việc")).toHaveValue("12:59");
  // Restore the all-day window so later logins are never gated.
  await db.query(
    "update public.system_settings set staff_allowed_from='00:00:00', staff_allowed_until='23:59:59'",
  );
});

test("Offline: sale mutation is not submitted and shows a clear message", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto(`/vehicles/${vehicles[0]}/sell`);
  await page
    .getByLabel("Tên khách hàng *", { exact: true })
    .fill("Khách offline");
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Xác nhận bán xe", exact: true })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Xác nhận bán xe", exact: true }).click();
  await expect(
    page.getByText(
      "Đang mất kết nối. Giao dịch chưa được gửi. Hãy kết nối mạng để tiếp tục.",
    ),
  ).toBeVisible();
  expect(
    (
      await db.query("select status from public.vehicles where id=$1", [
        vehicles[0],
      ])
    ).rows[0].status,
  ).toBe("IN_STOCK");
  await context.setOffline(false);
});

test("Regression: custom dates keep drafts local until the range is complete and valid", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rest/v1/rpc/dashboard"))
      requests.push(request.postDataJSON());
  });
  await login(page);
  const chip = (name) => page.getByRole("button", { name, exact: true });
  const presetResponse = page.waitForResponse((response) =>
    response.url().endsWith("/rest/v1/rpc/dashboard"),
  );
  await chip("Tháng trước").click();
  await presetResponse;
  await expect(chip("Tháng trước")).toHaveAttribute("aria-pressed", "true");
  await chip("Tùy chọn ngày").click();
  await expect(page.locator(".date-inputs-pill")).toBeVisible();
  const from = page.getByLabel("Từ ngày (DD/MM/YYYY)");
  const to = page.getByLabel("Đến ngày (DD/MM/YYYY)");
  const shiftDay = (delta) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
  };
  const toDisplay = (iso) =>
    `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const validRange = { p_from: shiftDay(-9), p_to: shiftDay(-2) };
  const requestCount = requests.length;
  await from.fill("");
  await to.fill(toDisplay(validRange.p_to));
  await expect(from).toHaveValue("");
  await expect(chip("Tùy chọn ngày")).toHaveAttribute("aria-pressed", "true");
  // Let React render the incomplete draft before asserting that no RPC escaped.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(requests).toHaveLength(requestCount);
  const validRequest = page.waitForRequest((request) => {
    if (!request.url().endsWith("/rest/v1/rpc/dashboard")) return false;
    const body = request.postDataJSON();
    return body.p_from === validRange.p_from && body.p_to === validRange.p_to;
  });
  await from.fill(toDisplay(validRange.p_from));
  await validRequest;
  await expect(chip("Tùy chọn ngày")).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText(/Tồn kho hiện tại|Xe đang trong kho/),
  ).toBeVisible();
  expect(
    requests.every(({ p_from, p_to }) => p_from && p_to && p_from <= p_to),
  ).toBe(true);
});

test("Regression: global inventory search resets page two to the first matching result", async ({
  page,
}) => {
  const connection = await db.connection();
  try {
    for (let i = 0; i < 21; i++)
      await asUser(connection, ids.OWNER, (client) =>
        rpc(client, "save_vehicle", "$1::jsonb", [
          JSON.stringify({
            request_id: randomUUID(),
            brand: "Honda",
            model: `Pagination ${ids.OWNER.slice(0, 5)} ${i}`,
            purchase_date: day,
            purchase_price: 30000000,
            asking_price: 35000000,
          }),
        ]),
      );
  } finally {
    await connection.close();
  }
  await login(page);
  await page.goto("/vehicles");
  // Default view is cleanly paginated; switch to next page directly.
  await page.getByRole("button", { name: "Trang sau", exact: true }).click();
  await expect(page.locator(".pagination-page.active")).toHaveText("2");
  const plate = `TEST-${ids.OWNER.slice(0, 5)}-0`;
  const searchRequest = page.waitForRequest((request) => {
    if (!request.url().endsWith("/rest/v1/rpc/list_vehicles")) return false;
    const filters = request.postDataJSON().p_filters;
    return filters.search === plate && filters.offset === 0;
  });
  await page.getByLabel("Tìm kiếm xe").fill(plate);
  await searchRequest;
  await expect(page.getByLabel("Tìm kiếm xe")).toHaveValue(plate);
  await expect(page.locator(".desktop-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".desktop-table tbody tr")).toContainText(plate);
  await expect(page.locator(".pagination-page.active")).toHaveText("1");
});

test("Regression: loading a new route keeps the navigation shell visible", async ({
  page,
}) => {
  await login(page);
  let releaseModule;
  let signalModule;
  const moduleHeld = new Promise((resolve) => {
    releaseModule = resolve;
  });
  const moduleRequested = new Promise((resolve) => {
    signalModule = resolve;
  });
  await page.route(
    "**/src/features/expenses/ExpensePages.tsx*",
    async (route) => {
      signalModule();
      await moduleHeld;
      await route.continue();
    },
  );
  try {
    await page
      .locator(".sidebar")
      .getByRole("link", { name: "Chi phí", exact: true })
      .click();
    await moduleRequested;
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.getByLabel("Tìm xe toàn hệ thống")).toBeVisible();
    // React Router keeps the previous route mounted while the lazy module
    // resolves, so the shell and the current page must both stay visible
    // (no blank screen) until the new route is ready.
    await expect(
      page
        .locator("main")
        .getByRole("region", { name: "Bảng tổng quan Cà Rem" }),
    ).toBeVisible();
  } finally {
    releaseModule();
  }
  await expect(
    page.getByRole("heading", { name: "Quản lý chi phí", exact: true }),
  ).toBeVisible();
});

test("Regression: mobile drawer contains focus, closes with Escape and restores scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const opener = page.getByRole("button", { name: "Mở menu", exact: true });
  const sidebar = page.locator(".sidebar");
  const originalOverflow = await page.evaluate(
    () => getComputedStyle(document.body).overflow,
  );
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await opener.focus();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    expect(
      await sidebar.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(false);
  }
  await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => getComputedStyle(document.body).overflow),
  ).toBe("hidden");
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    expect(
      await sidebar.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(
    await sidebar.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(opener).toBeFocused();
  expect(
    await page.evaluate(() => getComputedStyle(document.body).overflow),
  ).toBe(originalOverflow);
  await opener.click();
  await sidebar.getByRole("link", { name: /Tồn kho|Kho xe/ }).click();
  await expect(
    page.getByRole("heading", { name: /Tồn kho|Kho xe/ }),
  ).toBeVisible();
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(
    await page.evaluate(() => getComputedStyle(document.body).overflow),
  ).toBe(originalOverflow);
  await noOverflow(page);
});

test("Regression: changing the expense vehicle search clears the previous vehicle before saving", async ({
  page,
}) => {
  await login(page);
  await page.goto("/expenses?kind=vehicle&new=1");
  const picker = page.getByLabel("Chọn xe *", { exact: true });
  await expect(picker.locator(`option[value="${vehicles[0]}"]`)).toHaveCount(1);
  await picker.selectOption(vehicles[0]);
  const nextPlate = `TEST-${ids.OWNER.slice(0, 5)}-1`;
  await page.getByRole("textbox", { name: "Tìm xe", exact: true }).fill(nextPlate);
  await expect(picker.locator(`option[value="${vehicles[1]}"]`)).toHaveCount(1);
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue("");
  const description = `Chi phí đổi lựa chọn ${ids.OWNER.slice(0, 5)}`;
  await page.getByLabel("Số tiền (₫) *", { exact: false }).fill("150000");
  await page
    .getByLabel("Nội dung chi phí *", { exact: true })
    .fill(description);
  const expenseRequests = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rest/v1/rpc/save_expense"))
      expenseRequests.push(request.postDataJSON());
  });
  await page.getByRole("button", { name: "Lưu chi phí", exact: true }).click();
  await expect(
    page.getByText("Chọn xe cần ghi nhận chi phí.", { exact: true }),
  ).toBeVisible();
  expect(expenseRequests).toHaveLength(0);
  await picker.selectOption(vehicles[1]);
  await page.getByRole("button", { name: "Lưu chi phí", exact: true }).click();
  await expect(
    page.getByText(description, { exact: true }).first(),
  ).toBeVisible();
  expect(
    (
      await db.query(
        "select vehicle_id from public.vehicle_expenses where description=$1",
        [description],
      )
    ).rows,
  ).toEqual([{ vehicle_id: vehicles[1] }]);
});
