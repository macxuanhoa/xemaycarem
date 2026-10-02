import { test, expect } from "@playwright/test";

// Mobile drawer layering contract: the open drawer + backdrop must cover the
// full viewport, including the sticky topbar and the persistent bottom nav.
// Layer order: page content 0 · bottom nav 25 · topbar 30 · backdrop 50 · drawer 60.
const ownerId = "00000000-0000-4000-8000-000000000001";
const vehicleId = "00000000-0000-4000-8000-000000000002";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const seedVehicle = {
  id: vehicleId,
  internal_code: "XE-LAYER-001",
  frame_number: "LAYER-FRAME-1",
  brand: "Honda",
  model: "Vision",
  license_plate: "43A1-99999",
  status: "IN_STOCK",
  purchase_date: today,
  purchase_price: 30000000,
  asking_price: 35000000,
  total_cost: 30000000,
  cost_pending: false,
  expenses: [],
  images: [],
  activity: [],
  sales: [],
};

async function installMock(page) {
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
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postDataJSON() ?? {};
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
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "dashboard")
      return reply({
        in_stock: 18,
        reserved: 3,
        sold_today: 2,
        sold_month: 24,
        acquired_today: 1,
        acquired_month: 27,
        recent_sales: [],
        recent_vehicles: [],
        recent_acquisitions: [],
        recent_expenses: [],
        aging: [],
        longest_stock: [],
        top_profitable: [],
        daily_sales: [],
      });
    if (name === "list_vehicles") {
      const filters = body.p_filters ?? {};
      return reply({
        items: Array.from({ length: 40 }, (_, index) => ({
          ...seedVehicle,
          id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
          internal_code: `XE-L-${index + 1}`,
          frame_number: `LAYER-${index + 1}`,
        })).slice(
          filters.offset ?? 0,
          (filters.offset ?? 0) + (filters.limit ?? 20),
        ),
        total: 40,
      });
    }
    return reply({});
  });
}

const opener = (page) =>
  page.getByRole("button", { name: "Mở menu", exact: true });

test("Mobile drawer covers the topbar and bottom nav across phone and tablet widths", async ({
  page,
}) => {
  await installMock(page);
  for (const width of [320, 375, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.locator(".sidebar")).toBeAttached();
    const sidebar = page.locator(".sidebar");
    const topbar = page.locator(".topbar");
    const bottomNav = page.locator(".bottom-nav");
    // Closed state: header and bottom nav are on top and fully interactive.
    await expect(topbar).toBeVisible();
    await expect(bottomNav).toBeVisible();
    await opener(page).click();
    await expect(sidebar).toHaveClass(/open/);
    await expect
      .poll(() =>
        sidebar.evaluate((node) => getComputedStyle(node).zIndex),
      )
      .toBe("60");
    // Wait for the 0.2s slide-in transform to settle before measuring.
    await expect
      .poll(async () =>
        Math.abs(await sidebar.evaluate((node) => node.getBoundingClientRect().left)),
      )
      .toBeLessThan(0.5);
    const geometry = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        const box = node.getBoundingClientRect();
        return { top: box.top, left: box.left, bottom: box.bottom, right: box.right };
      };
      const stackAt = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        return hit?.closest(".sidebar")
          ? "drawer"
          : hit?.closest(".sidebar-overlay")
            ? "backdrop"
            : (hit?.className || hit?.tagName || "").toString();
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        drawer: rect(".sidebar"),
        topbar: rect(".topbar"),
        bottomNav: rect(".bottom-nav"),
        overlay: rect(".sidebar-overlay"),
        topOfDrawer: stackAt(40, 8),
        topOfBackdrop: stackAt(innerWidth - 10, 8),
        bottomOfBackdrop: stackAt(innerWidth - 10, innerHeight - 8),
        bodyLocked: getComputedStyle(document.body).position === "fixed",
      };
    });
    // Drawer starts at the very top of the viewport (no header-height offset)
    // and spans the full height, covering the topbar and bottom nav regions.
    expect(geometry.drawer.top, `${width}px: drawer must start at y=0`).toBeCloseTo(0, 0);
    expect(geometry.drawer.left).toBeCloseTo(0, 0);
    expect(geometry.drawer.bottom).toBeCloseTo(geometry.viewport.height, 0);
    expect(geometry.topbar.top).toBeLessThan(geometry.drawer.bottom);
    // Width stays a drawer (80-88% band, ±1px for scrollbar rounding), never full-screen.
    expect(geometry.drawer.right / geometry.viewport.width).toBeLessThanOrEqual(0.89);
    expect(geometry.drawer.right / geometry.viewport.width).toBeGreaterThanOrEqual(0.79);
    // Backdrop covers the remainder of the viewport top-to-bottom.
    expect(geometry.overlay.top).toBeCloseTo(0, 0);
    expect(geometry.overlay.bottom).toBeCloseTo(geometry.viewport.height, 0);
    // Hit-testing: header area belongs to the drawer, the rest to the backdrop,
    // so the topbar and bottom nav are neither visible-on-top nor clickable.
    expect(geometry.topOfDrawer, `${width}px: top-left must be the drawer`).toBe("drawer");
    expect(geometry.topOfBackdrop, `${width}px: top-right must be the backdrop`).toBe("backdrop");
    expect(geometry.bottomOfBackdrop, `${width}px: bottom-right must be the backdrop`).toBe("backdrop");
    // Background scrolling is locked while the drawer is open.
    expect(geometry.bodyLocked, `${width}px: body must be pinned`).toBe(true);
    await expect(bottomNav).toHaveAttribute("inert", "");
    // Backdrop tap closes the drawer and normal scrolling returns.
    await page.mouse.click(width - 15, 400);
    await expect(sidebar).not.toHaveClass(/open/);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).position !== "fixed",
      ),
    ).toBe(true);
    // Reopening works and navigation from the drawer closes it.
    await opener(page).click();
    await expect(sidebar).toHaveClass(/open/);
    await sidebar.getByRole("link", { name: "Tồn kho", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Tồn kho", exact: true }),
    ).toBeVisible();
    await expect(sidebar).not.toHaveClass(/open/);
    await expect(topbar).toBeVisible();
  }
  await page.screenshot({ path: "test-results/drawer-layering-final.png" });
});

test("Desktop keeps the permanent sidebar above the sticky topbar", async ({
  page,
}) => {
  await installMock(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).not.toHaveClass(/open/);
  await expect(page.locator(".sidebar-overlay")).toHaveCount(0);
  const [sidebarZ, topbarZ] = await Promise.all([
    sidebar.evaluate((node) => getComputedStyle(node).zIndex),
    page.locator(".topbar").evaluate((node) => getComputedStyle(node).zIndex),
  ]);
  expect(Number(sidebarZ)).toBeGreaterThan(Number(topbarZ));
  // The permanent sidebar still scrolls with tall pages and never opens a backdrop.
  await page.goto("/vehicles");
  await expect(
    page.getByRole("heading", { name: "Tồn kho", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sidebar-overlay")).toHaveCount(0);
});
