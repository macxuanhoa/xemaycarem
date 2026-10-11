/**
 * Tết 2027 — visual verification harness (requirement 7 + 5).
 *
 * It is not an assertion suite about pixels; it is the evidence run that lets the
 * OWNER sign the look off. Every combination of the two ORTHOGONAL axes is captured
 * on desktop and on mobile, for the screens that were approved (app shell +
 * dashboard), and each shot is paired with the computed token it proves:
 *
 *   - `data-theme` (Sáng/Tối) keeps its own values — Tet must never break it;
 *   - `data-seasonal` adds the festive layer on top of either mode.
 *
 * The cinematic opener is switched off in every fixture so the screenshots show the
 * interface, not the overlay.
 *
 * Output: backups/uiux-evidence/tet2027-integration/ (git-ignored, local evidence).
 */

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const userId = "22222222-2222-4222-8222-222222222222";
const OUT = "backups/uiux-evidence/tet2027-integration";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2 },
];

const COMBOS = [
  { seasonal: "default", theme: "light" },
  { seasonal: "default", theme: "dark" },
  { seasonal: "tet", theme: "light" },
  { seasonal: "tet", theme: "dark" },
];

function iso(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function fixture(page, { seasonal, theme }) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token =
    [{ alg: "HS256", typ: "JWT" }, { sub: userId, role: "authenticated", aud: "authenticated", exp: expires }]
      .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
      .join(".") + ".fixture-signature";
  await page.addInitScript(
    ({ session, lightDark }) => {
      localStorage.setItem("xe-remember", "true");
      localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(session));
      // The pre-paint bootstrap reads the light axis straight from storage, so each
      // shot starts in the mode the OWNER is meant to see.
      localStorage.setItem("xe-theme", lightDark);
      // The seasonal hint starts clean on purpose: the read has to be what flips
      // the festive layer, exactly as it would in a real session.
      localStorage.removeItem("xe-seasonal");
    },
    {
      lightDark: theme,
      session: {
        access_token: token,
        refresh_token: "fixture-refresh",
        token_type: "bearer",
        expires_at: expires,
        expires_in: 3600,
        user: {
          id: userId,
          aud: "authenticated",
          role: "authenticated",
          email: "visual@example.test",
          created_at: new Date().toISOString(),
          app_metadata: { provider: "email" },
          user_metadata: {},
        },
      },
    },
  );

  const active = seasonal === "tet";
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
        headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
    if (path.startsWith("/realtime/v1/")) return reply({ ok: true });
    if (path === "/auth/v1/user")
      return reply({ id: userId, aud: "authenticated", role: "authenticated", email: "visual@example.test", user_metadata: {}, app_metadata: { provider: "email" } });
    if (path === "/rest/v1/profiles")
      return reply({ id: userId, username: "visual_fixture", full_name: "Chủ cửa hàng", role: "OWNER", active: true, must_change_password: false, deleted_at: null, can_view_financials: true });
    const name = path.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true, role: "OWNER", must_change_password: false });
    if (name === "get_seasonal_theme")
      return reply({
        mode: active ? "TET_2027" : "DEFAULT",
        tet_start: null,
        tet_end: null,
        // Never in these shots: the overlay would cover the interface.
        cinematic_enabled: false,
        is_active: active,
        updated_at: new Date().toISOString(),
      });
    if (name === "get_settings") return reply({ store_name: "Xe Máy Cà Rem", phone: "0905 111 222", address: "Châu Phú, An Giang" });
    if (name === "list_notifications") return reply({ items: [], total: 0, unread_count: 0 });
    if (name === "list_active_announcements") return reply([]);
    if (name === "daily_reconciliation")
      return reply({ date: iso(), opening_cash: 0, total_in: 52000000, total_out: 900000, closing_cash: 51100000, lines: [] });
    if (name === "dashboard")
      return reply({
        in_stock: 12, reserved: 2, sold_today: 2, sold_month: 14,
        acquired_today: 1, acquired_month: 9, acquisitions_count: 9,
        acquisition_cost: 190000000, inventory_cost: 240000000,
        inventory_cost_pending: 0, inventory_indicator: "NORMAL",
        today_revenue: 52000000, month_revenue: 380000000,
        today_profit: 6100000, month_profit: 44000000,
        revenue: 52000000, gross_profit: 6100000, sales_count: 2,
        business_expenses: 900000, unpaid_sales_count: 3, total_receivables: 74000000,
        overdue_sales_count: 1, total_overdue_debt: 12000000, old_inventory_count: 2,
        recent_sales: [
          { id: "s1", plate: "67-B1 123.45", customer_name: "Nguyễn Văn An", sold_at: iso(0), sale_price: 32000000, profit: 4200000, status: "SOLD" },
          { id: "s2", plate: "67-B2 987.65", customer_name: "Trần Thị Bình", sold_at: iso(-1), sale_price: 20000000, profit: 1900000, status: "SOLD" },
        ],
        recent_vehicles: [
          { id: "v1", plate: "67-C1 234.56", frame_number: "RLCS3123456789012", engine_number: "E123456", vehicle_type: "Wave Alpha", status: "IN_STOCK", purchase_price: 18000000, listing_price: 22000000, acquired_at: iso(-2), days_in_stock: 2 },
          { id: "v2", plate: "67-C2 345.67", frame_number: "RLCS39876543210987", engine_number: "E987654", vehicle_type: "Vision", status: "RESERVED", purchase_price: 26000000, listing_price: 31000000, acquired_at: iso(-12), days_in_stock: 12 },
        ],
        recent_acquisitions: [], recent_expenses: [],
        aging: [
          { bucket: "0-7 ngày", count: 4, cost: 80000000 },
          { bucket: "8-30 ngày", count: 5, cost: 100000000 },
          { bucket: "Trên 30 ngày", count: 3, cost: 60000000 },
        ],
        longest_stock: [], top_profitable: [],
        daily_sales: [7, 6, 5, 4, 3, 2, 1].map((back) => ({
          date: iso(-back), revenue: (8 - back) * 6000000, count: 8 - back,
        })),
      });
    return reply({ items: [], total: 0, page: 1, page_size: 20 });
  });
}

test("captures the four theme combinations on the approved screens", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const captured = [];

  for (const viewport of VIEWPORTS) {
    for (const combo of COMBOS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        isMobile: viewport.name === "mobile",
        hasTouch: viewport.name === "mobile",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await fixture(page, combo);
      await page.goto("/");
      // Wait until the dashboard really painted (not the loader) and the seasonal
      // read has settled, so the shot is the steady state.
      await expect(page.locator("html")).toHaveAttribute("data-seasonal", combo.seasonal === "tet" ? "tet" : "default");
      await expect(page.locator("html")).toHaveAttribute("data-theme", combo.theme);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);

      const tokens = await page.evaluate(() => {
        const paint = (selector, prop = "backgroundColor") => {
          const el = document.querySelector(selector);
          return el ? getComputedStyle(el)[prop] : null;
        };
        return {
          surface: paint(".card"),
          topbar: paint(".topbar"),
          sidebar: paint(".sidebar"),
          // The festive active-nav pill is a gradient, so it shows up in
          // backgroundImage rather than in the flat colour.
          activeNav: paint(".sidebar nav a.active", "backgroundImage"),
          banner: paint("[class*='banner']"),
          season: document.documentElement.dataset.seasonal,
          lightDark: document.documentElement.dataset.theme,
        };
      });

      const file = `${combo.seasonal}-x-${combo.theme}__${viewport.name}.png`;
      await page.screenshot({ path: `${OUT}/${file}`, fullPage: viewport.name === "mobile" });
      captured.push({ file, ...tokens });
      await context.close();
    }
  }

  // Print the token matrix next to the files: this is what the OWNER reads as proof
  // that Light/Dark survived the festive layer.
  console.table(captured);
  expect(captured).toHaveLength(VIEWPORTS.length * COMBOS.length);

  const at = (seasonal, theme) =>
    captured.find((c) => c.file === `${seasonal}-x-${theme}__desktop.png`);

  // The dashboard shell really painted (not a loader) in every shot.
  for (const shot of captured) {
    expect(shot.sidebar, shot.file).not.toBeNull();
    expect(shot.activeNav, shot.file).not.toBeNull();
  }

  // Requirement 5, proved on computed values rather than on trust:
  //  - the festive layer changes the shell,
  expect(at("tet", "light").sidebar).not.toBe(at("default", "light").sidebar);
  expect(at("tet", "dark").sidebar).not.toBe(at("default", "dark").sidebar);
  expect(at("tet", "light").activeNav).not.toBe(at("default", "light").activeNav);
  //  - and the light axis still decides the base surfaces underneath it.
  expect(at("tet", "light").topbar).not.toBe(at("tet", "dark").topbar);
  expect(at("default", "light").topbar).not.toBe(at("default", "dark").topbar);
});

test("captures the OWNER control card in both modes", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  for (const seasonal of ["default", "tet"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await fixture(page, { seasonal, theme: "light" });
    await page.goto("/settings");
    const tab = page.getByRole("button", { name: "Giao diện hệ thống", exact: true });
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    const card = page.getByRole("heading", { name: /Giao diện hệ thống — Tết 2027/ });
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${OUT}/settings-theme-card__${seasonal}-x-light__desktop.png`,
    });
    // Second shot with the whole control surface expanded: AUTO reveals the date
    // window and the cinematic switch is ticked (unsaved, so nothing is written).
    await page.getByText("Tự động theo lịch", { exact: true }).click();
    await page
      .getByText("Cho phép màn chào Tết điện ảnh khi mở ứng dụng")
      .click();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${OUT}/settings-theme-card-auto__${seasonal}-x-light__desktop.png`,
    });
    await context.close();
  }
});
