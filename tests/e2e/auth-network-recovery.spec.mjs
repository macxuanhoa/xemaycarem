import { test, expect } from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000041";
const draftKey = `xe_crm_draft_v2:${userId}:acquisition`;

async function installNetworkFixture(page) {
  const state = {
    transportLost: false,
    profileLost: false,
    accessLost: false,
    role: "STAFF",
    canViewFinancials: false,
    allowed: true,
    profileCalls: 0,
    accessCalls: 0,
    authRefreshCalls: 0,
    writes: 0,
  };
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.mock`,
    refresh_token: "network-fixture-refresh",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "network@example.test",
      created_at: "2026-01-01T00:00:00Z",
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
    const path = new URL(request.url()).pathname;
    const name = path.split("/").at(-1);
    const reply = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
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
    if (path === "/rest/v1/profiles") state.profileCalls += 1;
    if (name === "check_user_access") state.accessCalls += 1;
    if (path === "/auth/v1/token") state.authRefreshCalls += 1;
    if (
      [
        "acquire_vehicle",
        "create_vehicle",
        "sell_vehicle",
        "prepare_payment_receipt",
      ].includes(name)
    )
      state.writes += 1;
    if (
      state.transportLost ||
      (state.profileLost && path === "/rest/v1/profiles") ||
      (state.accessLost && name === "check_user_access")
    )
      return route.abort("internetdisconnected");
    if (request.method() === "HEAD") return route.fulfill({ status: 200 });
    if (path === "/rest/v1/profiles")
      return reply({
        id: userId,
        full_name: "Nhân viên kiểm thử mạng",
        username: "network_test",
        role: state.role,
        active: true,
        can_view_financials: state.canViewFinancials,
        must_change_password: false,
        deleted_at: null,
        disabled_until: null,
      });
    if (name === "check_user_access")
      return reply({
        allowed: state.allowed,
        message: state.allowed ? "" : "Quyền truy cập đã bị thu hồi.",
      });
    if (path === "/auth/v1/user") return reply(session.user);
    if (name === "list_notifications")
      return reply({ items: [], unread_count: 0 });
    if (
      [
        "list_active_announcements",
        "list_vehicle_types",
        "search_customers",
      ].includes(name)
    )
      return reply([]);
    if (["list_vehicles", "list_acquisitions"].includes(name))
      return reply({ items: [], total: 0 });
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "check_vehicle_duplicate")
      return reply({ level: "NONE", candidates: [] });
    return reply(null);
  });
  return state;
}

async function openAcquisition(page) {
  await page.goto("/acquisitions/new");
  await expect(
    page.getByRole("heading", { name: "Thu xe mới", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Ghi chú", { exact: true })
    .fill("Đang soạn phiếu, chưa gửi máy chủ");
}

test("A transport outage during focus keeps the verified form and reconnect only revalidates reads", async ({
  page,
}) => {
  const state = await installNetworkFixture(page);
  await openAcquisition(page);
  const beforeFailure = state.profileCalls;
  state.transportLost = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.profileCalls).toBeGreaterThan(beforeFailure);
  await expect(page.locator(".network-banner--offline")).toBeVisible();
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveValue(
    "Đang soạn phiếu, chưa gửi máy chủ",
  );
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key))?.fields.notes,
        draftKey,
      ),
    )
    .toBe("Đang soạn phiếu, chưa gửi máy chủ");
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử mạng/ }),
  ).toBeVisible();
  const beforeRecovery = state.profileCalls;
  state.transportLost = false;
  await page.getByRole("button", { name: "Thử kết nối lại" }).click();
  await expect.poll(() => state.profileCalls).toBeGreaterThan(beforeRecovery);
  await expect(page.locator(".network-banner--offline")).toHaveCount(0);
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveValue(
    "Đang soạn phiếu, chưa gửi máy chủ",
  );
  expect(state.writes).toBe(0);
});

test("An interval outage keeps input, then authoritative denial on reconnect closes access", async ({
  page,
}) => {
  await page.clock.install();
  const state = await installNetworkFixture(page);
  await openAcquisition(page);
  const beforeFailure = state.profileCalls;
  state.transportLost = true;
  await page.clock.fastForward(60_100);
  // The monitor may notice first; neither timer may discard the verified form.
  await expect(page.locator(".network-banner--offline")).toBeVisible();
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveValue(
    "Đang soạn phiếu, chưa gửi máy chủ",
  );
  state.transportLost = false;
  state.allowed = false;
  await page.getByRole("button", { name: "Thử kết nối lại" }).click();
  await expect.poll(() => state.profileCalls).toBeGreaterThan(beforeFailure);
  await expect(
    page.getByText("Quyền truy cập đã bị thu hồi.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử mạng/ }),
  ).toHaveCount(0);
  expect(state.writes).toBe(0);
});

test("A concurrent profile transport failure cannot mask an authoritative access denial", async ({
  page,
}) => {
  const state = await installNetworkFixture(page);
  await openAcquisition(page);
  state.profileLost = true;
  state.allowed = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("Quyền truy cập đã bị thu hồi.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveCount(0);
  expect(state.writes).toBe(0);
});

test("Cold start with unavailable transport stays closed until access can be verified", async ({
  page,
}) => {
  const state = await installNetworkFixture(page);
  state.transportLost = true;
  await page.goto("/acquisitions/new");
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử mạng/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByText(
        /Kết quả thao tác chưa được xác nhận|Không thể kết nối|Không thể kiểm tra quyền truy cập/,
      )
      .first(),
  ).toBeVisible();
  expect(state.writes).toBe(0);
});

test("Page hiding flushes the latest allowed fields before the autosave delay", async ({
  page,
}) => {
  await page.clock.install();
  await installNetworkFixture(page);
  await openAcquisition(page);
  await page.clock.pauseAt(new Date());
  await page
    .getByLabel("Ghi chú", { exact: true })
    .fill("Ghi chú vừa nhập trước khi đóng trang");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key))?.fields.notes,
      draftKey,
    ),
  ).toBe("Ghi chú vừa nhập trước khi đóng trang");
});

test("Token expiry during a known outage keeps the already verified unsent form", async ({
  page,
  context,
}) => {
  await installNetworkFixture(page);
  await openAcquisition(page);
  await context.setOffline(true);
  await expect(page.locator(".network-banner--offline")).toBeVisible();
  await page.evaluate(() => {
    const key = "sb-xe-test-auth-token";
    const session = JSON.parse(localStorage.getItem(key));
    session.expires_at = Math.floor(Date.now() / 1000) - 300;
    localStorage.setItem(key, JSON.stringify(session));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveValue(
    "Đang soạn phiếu, chưa gửi máy chủ",
  );
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử mạng/ }),
  ).toBeVisible();
});

test("An expired token refresh losing transport preserves the verified form after getSession returns an error", async ({
  page,
}) => {
  await page.clock.install();
  const state = await installNetworkFixture(page);
  await openAcquisition(page);
  await page.evaluate(async () => {
    const { supabase } = await import("/src/lib/supabase.ts");
    const getSession = supabase.auth.getSession.bind(supabase.auth);
    supabase.auth.getSession = async () => {
      const result = await getSession();
      window.__networkSessionResult = result.error?.name ?? "resolved";
      return result;
    };
    const key = "sb-xe-test-auth-token";
    const session = JSON.parse(localStorage.getItem(key));
    session.expires_at = Math.floor(Date.now() / 1000) - 300;
    localStorage.setItem(key, JSON.stringify(session));
  });
  state.transportLost = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.authRefreshCalls).toBeGreaterThan(0);
  await expect(page.locator(".network-banner--offline")).toBeVisible();
  await page.clock.fastForward(35_000);
  await expect
    .poll(() => page.evaluate(() => window.__networkSessionResult))
    .toBe("AuthRetryableFetchError");
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveValue(
    "Đang soạn phiếu, chưa gửi máy chủ",
  );
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử mạng/ }),
  ).toBeVisible();
  expect(state.writes).toBe(0);
});

test("A received role change closes the old permissions when the concurrent access check loses transport", async ({
  page,
}) => {
  const state = await installNetworkFixture(page);
  state.role = "OWNER";
  state.canViewFinancials = true;
  await openAcquisition(page);
  state.role = "STAFF";
  state.canViewFinancials = false;
  state.accessLost = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".auth-simple .error-state")).toBeVisible();
  await expect(page.getByLabel("Ghi chú", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Nhân viên kiểm thử mạng/ }),
  ).toHaveCount(0);
  expect(state.writes).toBe(0);
});
