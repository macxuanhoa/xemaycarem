import { test, expect } from "@playwright/test";

// Business bell contract: every role sees the bell in the topbar on desktop
// and mobile, the panel renders server-prepared Vietnamese rows grouped by
// time, clicking a row marks it read and deep-links, and mark-all clears the
// badge. Realtime is intentionally not asserted (flaky over a mocked socket);
// delivery is verified through the list RPC like a post-action reload.
const userId = "00000000-0000-4000-8000-000000000001";

const notification = (over = {}) => ({
  id: "11111111-1111-4111-8111-000000000001",
  action: "CREATE_SALE",
  entity_type: "sales",
  entity_id: "22222222-2222-4222-8222-000000000001",
  vehicle_id: null,
  title: "Bán xe Honda Vision BS 43A1-99999",
  body: "Nhân viên bán cho khách Trần Bình An.",
  deep_link: "/sales/22222222-2222-4222-8222-000000000001",
  read_at: null,
  created_at: new Date().toISOString(),
  actor_id: "33333333-3333-4333-8333-000000000001",
  actor_name: "Nguyễn Văn Nhân",
  ...over,
});

async function installMock(page, { empty = false } = {}) {
  let unread = empty ? 0 : 2;
  await page.addInitScript(
    (value) =>
      localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    {
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
        email: "staff@example.test",
        created_at: new Date().toISOString(),
        app_metadata: {},
        user_metadata: {},
      },
    },
  );
  // Route table keyed on the request pathname (supabase-js appends query
  // selectors, so exact href matching never hits).
  const routes = [
    [
      "/rest/v1/profiles",
      () => [
        {
          id: userId,
          full_name: "Nguyễn Văn Nhân",
          role: "STAFF",
          active: true,
          can_view_financials: false,
          must_change_password: false,
          disabled_until: null,
          allowed_from: null,
          allowed_until: null,
          working_days: null,
          deleted_at: null,
          username: "nhan",
        },
      ],
    ],
    ["/rest/v1/rpc/check_user_access", { allowed: true }],
    ["/rest/v1/rpc/get_settings", { store_name: "Cửa hàng kiểm thử" }],
    ["/rest/v1/rpc/list_active_announcements", []],
    [
      "/rest/v1/rpc/list_notifications",
      () =>
        empty
          ? { items: [], total: 0, unread_count: 0 }
          : {
              items: [
                notification(),
                notification({
                  id: "11111111-1111-4111-8111-000000000002",
                  action: "CREATE_ACQUISITION",
                  title: "Thu xe Honda Wave Alpha",
                  body: "Nguyễn Văn Nhân thu xe BS 43B1-11111.",
                  deep_link: "/acquisitions",
                }),
              ],
              total: 4,
              unread_count: unread,
            },
    ],
    [
      "/rest/v1/rpc/mark_notifications_read",
      () => {
        unread = Math.max(0, unread - 1);
        return unread + 1;
      },
    ],
    [
      "/rest/v1/rpc/mark_all_notifications_read",
      () => {
        const marked = unread;
        unread = 0;
        return marked;
      },
    ],
  ];
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
    if (url.pathname === "/auth/v1/user")
      return reply({
        id: userId,
        aud: "authenticated",
        role: "authenticated",
        email: "staff@example.test",
        app_metadata: {},
        user_metadata: {},
      });
    for (const [match, value] of routes) {
      const hit = match instanceof RegExp ? match.test(url.pathname) : url.pathname === match;
      if (hit) return reply(typeof value === "function" ? value() : value);
    }
    return reply({});
  });
}

const bell = (page) => page.locator(".header-notification-toggle");
const badge = (page) => page.locator(".notification-badge");

test("Bell shows on desktop and mobile with unread badge and grouped panel", async ({
  page,
}) => {
  await installMock(page);
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(bell(page)).toBeVisible();
    await expect(badge(page)).toHaveText("2");
    await bell(page).click();
    const panel = page.locator(".notification-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Thông báo" })).toBeVisible();
    await expect(page.locator(".notification-row")).toHaveCount(2);
    // Newest unread rows read bold; time buckets render.
    await expect(page.locator(".notification-row.unread")).toHaveCount(2);
    await expect(page.locator(".notification-group-label").first()).toHaveText("Nãy");
    // The panel is portalled to body so the topbar cannot clip it.
    expect(await panel.evaluate((node) => node.parentElement?.tagName)).toBe("BODY");
    const box = await panel.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    // Tapping outside closes the popover.
    await page.mouse.click(viewport.width / 4, viewport.height - 60);
    await expect(panel).toHaveCount(0);
    await expect(bell(page)).toBeVisible();
  }
});

test("Clicking a notification marks it read and deep-links", async ({ page }) => {
  await installMock(page);
  await page.goto("/");
  await bell(page).click();
  await page.locator(".notification-row").first().click();
  await expect(page).toHaveURL(
    /\/sales\/22222222-2222-4222-8222-000000000001$/,
  );
  await expect(page.locator(".notification-panel")).toHaveCount(0);
});

test("Mark all read clears the badge", async ({ page }) => {
  await installMock(page);
  await page.goto("/");
  await expect(badge(page)).toHaveText("2");
  await bell(page).click();
  await page.getByRole("button", { name: "Đánh dấu tất cả đã đọc" }).click();
  await expect(page.locator(".notification-badge")).toHaveCount(0);
});

test("Empty state copies honestly when there is nothing to report", async ({ page }) => {
  await installMock(page, { empty: true });
  await page.goto("/");
  await expect(page.locator(".notification-badge")).toHaveCount(0);
  await bell(page).click();
  await expect(page.locator(".notification-empty")).toHaveText("Chưa có thông báo nào.");
});
