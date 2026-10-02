import { test, expect } from "@playwright/test";

// Inventory status badge on the "Kho xe hiện tại" digest card.
// The badge must render the SERVER-provided inventory_indicator verbatim
// through the canonical resolver (tests/unit/inventory-status.test.ts owns
// the mapping); no client-side re-interpretation of thresholds.
const ownerId = "00000000-0000-4000-8000-000000000001";

async function installMock(page, indicator) {
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
  const dashboard = {
    in_stock: 6,
    reserved: 2,
    inventory_cost_pending: 0,
    inventory_cost: 0,
    sales_count: 0,
    sold_today: 0,
    sold_month: 0,
    acquisitions_count: 0,
    acquired_today: 0,
    revenue: 0,
    gross_profit: 0,
    today_revenue: 0,
    month_revenue: 0,
    today_profit: 0,
    month_profit: 0,
    acquisition_cost: 0,
    business_expenses: 0,
    daily_sales: [],
    top_profitable: [],
    recent_sales: [],
    recent_acquisitions: [],
    recent_expenses: [],
    longest_stock: [],
  };
  if (indicator !== null) dashboard.inventory_indicator = indicator;
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
        full_name: "Chủ kiểm thử",
        username: "owner",
        role: "OWNER",
        active: true,
        can_view_financials: true,
        must_change_password: false,
      });
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "dashboard") return reply(dashboard);
    if (name === "daily_reconciliation")
      return reply({ total_collected: 0, sales: [], payments: [], expenses: [] });
    return reply({});
  });
}

const labels = {
  LOW: "Tồn kho thấp",
  NORMAL: "Tồn kho bình thường",
  HIGH: "Tồn kho cao",
};

for (const indicator of ["LOW", "NORMAL", "HIGH"]) {
  test(`Dashboard renders the ${indicator} inventory status badge`, async ({
    page,
  }) => {
    await installMock(page, indicator);
    await page.goto("/");
    const digest = page.locator(".carem-digest-col", {
      hasText: "Kho xe hiện tại",
    });
    await expect(digest.getByText("Tồn kho hiện tại")).toBeVisible();
    const badge = digest.locator(".digest-status");
    await expect(badge).toHaveText(labels[indicator]);
    await expect(badge).toBeVisible();
    await page.screenshot({
      path: `test-results/dashboard-inventory-${indicator.toLowerCase()}.png`,
    });
  });
}

test("No badge appears when the server sends no indicator", async ({
  page,
}) => {
  await installMock(page, null);
  await page.goto("/");
  const digest = page.locator(".carem-digest-col", {
    hasText: "Kho xe hiện tại",
  });
  await expect(digest.getByText("Tồn kho hiện tại")).toBeVisible();
  await expect(digest.locator(".digest-status")).toHaveCount(0);
});

// Mobile: the status chip must stay inside the card without forcing a
// horizontal scroll (project breakpoint set).
for (const width of [320, 390]) {
  test(`Inventory status badge fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installMock(page, "LOW");
    await page.goto("/");
    const badge = page
      .locator(".carem-digest-col", { hasText: "Kho xe hiện tại" })
      .locator(".digest-status");
    await expect(badge).toHaveText("Tồn kho thấp");
    const [badgeBox, cardBox] = await Promise.all([
      badge.boundingBox(),
      page.locator(".carem-digest").boundingBox(),
    ]);
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width + 1,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `test-results/dashboard-inventory-low-${width}.png`,
    });
  });
}
