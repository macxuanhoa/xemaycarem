import { test, expect } from "@playwright/test";

// Mobile hard requirement: the primary CTA must live on the SAME horizontal
// row as the page title at 375 / 390 / 430, stay on that row at 320 through
// compact styling, and only drop below the title when the width is physically
// impossible (< 320). The description always owns the full width below the row.

const ownerId = "00000000-0000-4000-8000-000000000001";

const pages = [
  { path: "/vehicles", title: "Tồn kho" },
  { path: "/sales", title: "Bán hàng & Thu nợ" },
];

async function installMock(page) {
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
        role: "OWNER",
        active: true,
        can_view_financials: true,
        must_change_password: false,
      });
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "get_settings") return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "list_vehicles") return reply({ items: [], total: 0 });
    if (name === "list_sales") return reply({ items: [], total: 0 });
    if (name === "list_receivables")
      return reply({
        items: [],
        total: 0,
        total_receivable: 0,
        total_overdue: 0,
        overdue_count: 0,
        unpaid_count: 0,
      });
    return reply({});
  });
}

async function headerGeometry(page) {
  const row = await page.locator(".page-heading .heading-row").boundingBox();
  const title = await page.locator(".page-heading h1").boundingBox();
  const cta = await page
    .locator(".heading-actions .button")
    .first()
    .boundingBox();
  const description = await page.locator(".page-heading p").boundingBox();
  return { row, title, cta, description };
}

// “Same horizontal row” = the CTA box overlaps the title box vertically, so a
// CTA that dropped under the title (or under the description) fails even if it
// is still inside the header element.
function expectSharesTitleRow({ title, cta }) {
  expect(cta.y).toBeLessThan(title.y + title.height);
  expect(cta.y + cta.height).toBeGreaterThan(title.y);
}

test.describe("Page header keeps the primary CTA on the title row", () => {
  for (const page of pages) {
    for (const width of [430, 390, 375]) {
      test(`${page.path} keeps CTA beside the title at ${width}px`, async ({
        page: browser,
      }) => {
        await browser.setViewportSize({ width, height: 844 });
        await installMock(browser);
        await browser.goto(page.path);
        await expect(
          browser.getByRole("heading", { name: page.title, exact: true }),
        ).toBeVisible();

        const { row, title, cta, description } = await headerGeometry(browser);
        // Same horizontal row as the title, never below it.
        expectSharesTitleRow({ title, cta });
        expect(cta.y + cta.height).toBeLessThanOrEqual(row.y + row.height + 1);
        // Right-aligned against the row.
        expect(row.x + row.width - (cta.x + cta.width)).toBeLessThanOrEqual(2);
        // Description spans the full width below the title/action row.
        expect(description.y).toBeGreaterThanOrEqual(row.y + row.height - 1);
        expect(description.width).toBeGreaterThanOrEqual(row.width - 2);
        // Full wording is preserved on normal phone widths.
        await expect(browser.locator(".cta-label-full")).toBeVisible();
        await expect(browser.locator(".cta-label-short")).toBeHidden();
        expect(
          await browser.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await browser.screenshot({
          path: `test-results/page-header-cta-${page.path.slice(1)}-${width}.png`,
          clip: { x: 0, y: 0, width, height: 240 },
        });
      });
    }
  }

  test("320px compacts the CTA but keeps it beside the title", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await installMock(page);
    await page.goto("/sales");
    await expect(
      page.getByRole("heading", { name: "Bán hàng & Thu nợ", exact: true }),
    ).toBeVisible();

    const { row, title, cta, description } = await headerGeometry(page);
    expectSharesTitleRow({ title, cta });
    expect(cta.y + cta.height).toBeLessThanOrEqual(row.y + row.height + 1);
    expect(row.x + row.width - (cta.x + cta.width)).toBeLessThanOrEqual(2);
    expect(description.y).toBeGreaterThanOrEqual(row.y + row.height - 1);

    // First-tier compact styling: reduced padding/font and shortened label.
    const style = await page
      .locator(".heading-actions .button")
      .first()
      .evaluate((node) => {
        const css = getComputedStyle(node);
        return {
          fontSize: parseFloat(css.fontSize),
          paddingTop: parseFloat(css.paddingTop),
          paddingLeft: parseFloat(css.paddingLeft),
        };
      });
    expect(style.fontSize).toBeLessThanOrEqual(12);
    expect(style.paddingTop).toBeLessThanOrEqual(8);
    expect(style.paddingLeft).toBeLessThanOrEqual(10);
    await expect(page.locator(".cta-label-full")).toBeHidden();
    await expect(page.locator(".cta-label-short")).toBeVisible();
    // Accessible name stays stable even though the label is shortened.
    await expect(
      page
        .locator(".heading-actions")
        .getByRole("link", { name: "Tạo giao dịch", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await page.screenshot({
      path: "test-results/page-header-cta-sales-320.png",
      clip: { x: 0, y: 0, width: 320, height: 260 },
    });
  });
});
