import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDatabase, asUser, rpc } from "../../scripts/db-harness.mjs";

// Only the hosted HTTP/Auth boundary is simulated. All business RPCs, RLS and
// financial calculations execute the actual migrations on PostgreSQL.
let db, day, ids, vehicles;
test.beforeAll(async () => {
  db = await createDatabase({ engine: "postgres" });
});
test.afterAll(async () => {
  await db?.close();
});
test.beforeEach(async ({ page }) => {
  day = (await db.query("select private.today()::text as day")).rows[0].day;
  ids = { OWNER: randomUUID(), STAFF: randomUUID(), VIEWER: randomUUID() };
  vehicles = [];
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
                  "select id,full_name,role,active,can_view_financials from public.profiles where id=$1",
                  [userId],
                )
              ).rows[0] ?? null
            );
          if (url.pathname.startsWith("/rest/v1/rpc/")) {
            const name = url.pathname.split("/").at(-1);
            if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid RPC");
            const signature = (
              await db.query(
                "select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",
                [name],
              )
            ).rows[0]?.args;
            if (signature === undefined)
              throw new Error(`RPC missing: ${name}`);
            const types = Object.fromEntries(
              signature
                .split(", ")
                .filter(Boolean)
                .map((pair) => {
                  const space = pair.indexOf(" ");
                  return [pair.slice(0, space), pair.slice(space + 1)];
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
  await page.getByLabel("Email", { exact: true }).fill(`${role}@example.test`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill("Password-Test-2026");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Xin chào/ })).toBeVisible();
  await expect(
    page.getByText("Xe đang trong kho", { exact: true }),
  ).toBeVisible();
}
async function noOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

test("Owner: login, persistent session, add/edit vehicle, expense, sale, payment, cancellation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await page.reload();
  await expect(
    page.getByText("Xe đang trong kho", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.goto("/vehicles/new");
  await page.getByLabel("Hãng xe *", { exact: true }).fill("Honda");
  await page.getByLabel("Dòng xe *", { exact: true }).fill("SH Kiểm thử UI");
  await page.getByLabel("Giá mua (₫) *", { exact: true }).fill("80000000");
  await page.getByLabel("Giá niêm yết (₫) *", { exact: true }).fill("90000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]{36}$/);
  const vehicleId = page.url().split("/").at(-1);
  await page.goto(`/vehicles/${vehicleId}/edit`);
  await page.getByLabel("Màu sắc", { exact: true }).fill("Đen");
  await page.getByRole("button", { name: "Lưu thay đổi", exact: true }).click();
  await expect(page).toHaveURL(`/vehicles/${vehicleId}`);
  await page.goto(`/expenses?kind=vehicle&vehicle=${vehicleId}&new=1`);
  await page.getByLabel("Số tiền (₫) *", { exact: true }).fill("1200000");
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
    .getByLabel("Thu tiền lần đầu (₫)", { exact: true })
    .fill("20000000");
  await page
    .getByRole("button", { name: "Xác nhận bán xe", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sales\/[a-f0-9-]{36}$/);
  const saleId = page.url().split("/").at(-1);
  await expect(page.getByText(/8\.800\.000/)).toBeVisible();
  await page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  await page
    .getByRole("button", { name: "Lưu thanh toán", exact: true })
    .click();
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
  await page.getByLabel("Tìm xe toàn hệ thống").fill(plate);
  await page.getByLabel("Tìm xe toàn hệ thống").press("Enter");
  await expect(page.getByLabel("Tìm kiếm xe")).toHaveValue(plate);
  await expect(page.locator(".mobile-record")).toHaveCount(1);
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
    page.getByText(/Tài khoản chưa được cấp quyền hoặc đã bị khóa/),
  ).toBeVisible();
});

test("Owner: report export, date ranges, audit and settings routes", async ({
  page,
}) => {
  await login(page);
  await page.goto("/reports");
  await page.getByRole("button", { name: "Tồn kho", exact: true }).click();
  await expect(page.locator(".data-table tbody tr").first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Xuất CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/inventory.*\.csv$/);
  await page.getByLabel("Khoảng thời gian").selectOption("last-month");
  await expect(page.getByLabel("Khoảng thời gian")).toHaveValue("last-month");
  await page.goto("/audit");
  await expect(page.locator(".audit-record").first()).toBeVisible();
  await page.locator(".audit-record summary").first().click();
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
  await page
    .getByLabel("Tên cửa hàng", { exact: true })
    .fill("Cửa hàng kiểm thử UI");
  await page.getByRole("button", { name: "Lưu cài đặt", exact: true }).click();
  await expect(page.getByText("Đã lưu cài đặt cửa hàng.")).toBeVisible();
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
