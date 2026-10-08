import { test, expect } from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000021";
const user = {
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email: "staff@example.test",
  app_metadata: { provider: "email" },
  user_metadata: {},
  identities: [],
  created_at: "2026-01-01T00:00:00Z",
};

async function mockAuth(
  page,
  {
    logoutGate,
    accessState = { active: true, unavailable: false },
    rejectRefresh = false,
  } = {},
) {
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "access-control-allow-origin": "*" },
      });
    if (path === "/auth/v1/token") {
      if (
        rejectRefresh &&
        new URL(route.request().url()).searchParams.get("grant_type") ===
          "refresh_token"
      )
        return reply(
          {
            code: "refresh_token_not_found",
            message: "Synthetic refresh token expired",
          },
          401,
        );
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token =
        [
          { alg: "HS256", typ: "JWT" },
          { sub: userId, exp, role: "authenticated" },
        ]
          .map((value) =>
            Buffer.from(JSON.stringify(value)).toString("base64url"),
          )
          .join(".") + ".synthetic";
      return reply({
        access_token: token,
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
        expires_at: exp,
        token_type: "bearer",
        user,
      });
    }
    if (path === "/auth/v1/logout") {
      if (logoutGate) await logoutGate;
      return route.fulfill({ status: 204 });
    }
    if (path === "/rest/v1/profiles")
      return reply({
        id: userId,
        full_name: "Nhân viên kiểm thử",
        username: "staff_test",
        role: "STAFF",
        active: accessState.active,
        can_view_financials: false,
        must_change_password: false,
        deleted_at: null,
        disabled_until: null,
      });
    if (path.endsWith("/check_user_access"))
      return accessState.unavailable
        ? reply({ message: "Synthetic backend outage" }, 503)
        : reply({ allowed: accessState.active });
    if (path.endsWith("/list_notifications"))
      return reply({ items: [], unread_count: 0 });
    if (path.endsWith("/list_active_announcements")) return reply([]);
    if (path.endsWith("/get_settings"))
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (path.endsWith("/list_vehicles")) return reply({ items: [], total: 0 });
    if (path.endsWith("/list_vehicle_types"))
      return reply([
        {
          id: "00000000-0000-4000-8000-0000000000a1",
          name: "Xe số",
          vehicle_count: 0,
        },
        {
          id: "00000000-0000-4000-8000-0000000000a2",
          name: "Xe tay ga",
          vehicle_count: 0,
        },
      ]);
    if (path === "/auth/v1/user") return reply(user);
    return reply(null);
  });
}

async function enterLogin(page) {
  await page.getByLabel("Tên đăng nhập hoặc email").fill("staff@example.test");
  await page.getByLabel("Mật khẩu", { exact: true }).fill("Synthetic-Password");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
}

test("Blocked storage getters leave login usable and display a controlled storage error", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockAuth(page);
  await page.addInitScript(() => {
    for (const name of ["localStorage", "sessionStorage"])
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          throw new DOMException("Storage denied", "SecurityError");
        },
      });
  });
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Chào mừng trở lại" }),
  ).toBeVisible();
  await enterLogin(page);
  await expect(page.getByRole("alert")).toContainText("lưu phiên đăng nhập");
  await expect(page).toHaveURL(/\/login$/);
  expect(errors).toEqual([]);
});

test("Quota failure before login is shown without sending an Auth mutation", async ({
  page,
}) => {
  let authRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/auth/v1/token")) authRequests += 1;
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockAuth(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage full", "QuotaExceededError");
    };
  });
  await page.goto("/login");
  await enterLogin(page);
  await expect(page.getByRole("alert")).toContainText("lưu phiên đăng nhập");
  expect(authRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("Logout immediately removes private UI while the server response is delayed", async ({
  page,
}) => {
  let releaseLogout;
  const logoutGate = new Promise((resolve) => {
    releaseLogout = resolve;
  });
  await mockAuth(page, { logoutGate });
  await page.goto("/login");
  await enterLogin(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Đăng xuất/ })
    .first()
    .click();
  try {
    await expect(page).toHaveURL(/\/login$/, { timeout: 2000 });
    await expect(
      page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
    ).toHaveCount(0);
  } finally {
    releaseLogout();
  }
});

test("Account revocation on focus closes an already opened private screen", async ({
  page,
}) => {
  const accessState = { active: true, unavailable: false };
  await mockAuth(page, { accessState });
  await page.goto("/login");
  await enterLogin(page);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  accessState.active = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ chủ cửa hàng.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toHaveCount(0);
});

test("Access-check 503 closes private content and a later verified refresh recovers", async ({
  page,
}) => {
  const accessState = { active: true, unavailable: false };
  await mockAuth(page, { accessState });
  await page.goto("/login");
  await enterLogin(page);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  accessState.unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "Không thể kiểm tra quyền truy cập. Vui lòng thử lại khi có kết nối.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toHaveCount(0);
  accessState.unavailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
});

test("Expired session with rejected refresh returns to login without retaining private UI", async ({
  page,
}) => {
  await mockAuth(page, { rejectRefresh: true });
  await page.goto("/login");
  await enterLogin(page);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) =>
      /^sb-.*-auth-token$/.test(item),
    );
    const value = JSON.parse(localStorage.getItem(key));
    value.expires_at = Math.floor(Date.now() / 1000) - 300;
    localStorage.setItem(key, JSON.stringify(value));
  });
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Chào mừng trở lại" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toHaveCount(0);
});

test("A mutation rejected with expired JWT retains input and never shows saved success", async ({
  page,
}) => {
  await mockAuth(page);
  let attempts = 0;
  await page.route(
    "https://xe-test.supabase.co/rest/v1/rpc/save_vehicle",
    async (route) => {
      attempts += 1;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "PGRST301", message: "JWT expired" }),
      });
    },
  );
  await page.goto("/login");
  await enterLogin(page);
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/vehicles/new");
  await page.getByLabel("Loại xe *", { exact: true }).selectOption({ index: 1 });
  await page
    .getByLabel("Biển số", { exact: true })
    .fill("59-A1 234.56");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();
  await expect(
    page.getByText("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/vehicles\/new$/);
  await expect(
    page.getByLabel("Biển số", { exact: true }),
  ).toHaveValue("59-A1 234.56");
  expect(attempts).toBe(1);
});

test("Logout reaches another tab using the same remembered session", async ({
  page,
  context,
}) => {
  await mockAuth(page);
  await page.goto("/login");
  await enterLogin(page);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  const other = await context.newPage();
  await mockAuth(other);
  await other.goto("/");
  await expect(
    other.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Đăng xuất/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(other).toHaveURL(/\/login$/);
  await expect(
    other.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toHaveCount(0);
});

test("Remember opt-out keeps the token out of persistent storage and out of a fresh tab", async ({
  page,
  context,
}) => {
  await mockAuth(page);
  await page.goto("/login");
  await page.getByRole("checkbox", { name: "Duy trì đăng nhập" }).uncheck();
  await enterLogin(page);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  const stored = await page.evaluate(() => ({
    localTokenCount: Object.keys(localStorage).filter((key) =>
      /^sb-.*-auth-token$/.test(key),
    ).length,
    tabTokenCount: Object.keys(sessionStorage).filter((key) =>
      /^sb-.*-auth-token$/.test(key),
    ).length,
  }));
  expect(stored).toEqual({ localTokenCount: 0, tabTokenCount: 1 });
  const other = await context.newPage();
  await mockAuth(other);
  await other.goto("/");
  await expect(other).toHaveURL(/\/login$/);
});

test("A storage permission change while signed in does not crash shorthand intake", async ({
  page,
}) => {
  await mockAuth(page);
  await page.goto("/login");
  await enterLogin(page);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage denied", "SecurityError");
      },
    });
    history.pushState({}, "", "/intake");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByRole("heading", { name: "Thu xe tốc ký", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ứng dụng cần tải lại", exact: true }),
  ).toHaveCount(0);
});
