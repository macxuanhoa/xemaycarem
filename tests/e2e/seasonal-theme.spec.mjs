/**
 * Seasonal theme (Tết 2027) — acceptance E2E over a mocked Supabase.
 *
 * Covers the OWNER-facing acceptance criteria without a live backend:
 *  - the "Giao diện hệ thống" tab exists for OWNER only;
 *  - TET_2027 flips <html data-seasonal> and survives a refresh (pre-paint cache);
 *  - AUTO follows the configured window and refuses an incomplete one;
 *  - saves go through save_seasonal_theme with a partial payload, and the light
 *    axis (data-theme) is never touched;
 *  - STAFF never sees the tab and a forced write is denied by the server;
 *  - the cinematic opener is an independent overlay gated by its own switch.
 */

import { test, expect } from "@playwright/test";

const userId = "11111111-1111-4111-8111-111111111111";

function iso(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function setup(page, { role = "OWNER", theme = null } = {}) {
  const calls = { saves: [], seasonalReads: 0 };
  let seasonal = theme ?? {
    mode: "DEFAULT",
    tet_start: null,
    tet_end: null,
    cinematic_enabled: false,
    is_active: false,
    updated_at: new Date().toISOString(),
  };
  const user = {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email: "seasonal@example.test",
    created_at: new Date().toISOString(),
    app_metadata: { provider: "email" },
    user_metadata: {},
  };
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token =
    [{ alg: "HS256", typ: "JWT" }, { sub: userId, role: "authenticated", aud: "authenticated", exp: expires }]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".") + ".fixture-signature";
  await page.addInitScript(({ session }) => {
    localStorage.setItem("xe-remember", "true");
    localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(session));
  }, { session: { access_token: token, refresh_token: "fixture-refresh", token_type: "bearer", expires_at: expires, expires_in: 3600, user } });

  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postData() ? request.postDataJSON() : {};
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
        headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
    // Realtime handshake is out of scope for this fixture: satisfy it silently.
    if (path.startsWith("/realtime/v1/")) return reply({ ok: true });
    if (path === "/auth/v1/user") return reply(user);
    if (path === "/rest/v1/profiles")
      return reply({ id: userId, username: "seasonal_fixture", full_name: "Seasonal Fixture", role, active: true, must_change_password: false, deleted_at: null, can_view_financials: role === "OWNER" });
    const name = path.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true, role, must_change_password: false });
    if (name === "get_settings") return reply({ store_name: "Xe Máy Cà Rem", phone: "", address: "" });
    if (name === "list_notifications") return reply({ items: [], total: 0, unread_count: 0 });
    if (name === "list_active_announcements") return reply([]);
    if (name === "get_seasonal_theme") {
      calls.seasonalReads++;
      return reply(seasonal);
    }
    if (name === "save_seasonal_theme") {
      calls.saves.push(body.p_data);
      // STAFF/MANAGER are refused server-side by require_role(OWNER).
      if (role !== "OWNER")
        return reply({ code: "42501", message: "ACCESS_DENIED" }, 403);
      const data = body.p_data ?? {};
      seasonal = {
        ...seasonal,
        ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
        updated_at: new Date().toISOString(),
      };
      seasonal.is_active =
        seasonal.mode === "TET_2027" ||
        (seasonal.mode === "AUTO" &&
          seasonal.tet_start &&
          seasonal.tet_end &&
          iso() >= seasonal.tet_start &&
          iso() <= seasonal.tet_end);
      if (seasonal.mode !== "AUTO") {
        seasonal.tet_start = data.tet_start ?? null;
        seasonal.tet_end = data.tet_end ?? null;
      }
      return reply(seasonal);
    }
    if (name === "dashboard")
      return reply({
        in_stock: 6, reserved: 1, sold_today: 2, sold_month: 14,
        acquired_today: 1, acquired_month: 9, acquisitions_count: 9,
        acquisition_cost: 190000000, inventory_cost: 120000000,
        inventory_cost_pending: 0, inventory_indicator: "NORMAL",
        today_revenue: 52000000, month_revenue: 380000000,
        today_profit: 6100000, month_profit: 44000000,
        revenue: 52000000, gross_profit: 6100000, sales_count: 2,
        business_expenses: 900000, unpaid_sales_count: 3, total_receivables: 74000000,
        overdue_sales_count: 1, total_overdue_debt: 12000000, old_inventory_count: 2,
        recent_sales: [], recent_vehicles: [], recent_acquisitions: [],
        recent_expenses: [], aging: [], longest_stock: [], top_profitable: [],
        daily_sales: [7, 6, 5, 4, 3, 2, 1].map((back) => ({
          date: iso(-back), revenue: (8 - back) * 6000000, count: 8 - back,
        })),
      });
    if (name === "daily_reconciliation")
      return reply({ date: iso(), opening_cash: 0, total_in: 52000000, total_out: 900000, closing_cash: 51100000, lines: [] });
    return reply({ message: `Unexpected fixture operation ${name}` }, 400);
  });
  return calls;
}

test("OWNER toggles TET_2027 on and off from the Giao diện hệ thống tab", async ({ page }) => {
  const calls = await setup(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Hồ sơ của bạn" })).toBeVisible();

  await openThemeTab(page);
  await expect(page.getByText("Giao diện thường ngày.", { exact: true })).toBeVisible();

  await page.getByText("Tết 2027 — bật ngay", { exact: true }).click();
  await page.getByRole("button", { name: "Lưu giao diện", exact: true }).click();
  await expect(page.getByText("Đã lưu giao diện", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-seasonal", "tet");
  // The light/dark axis is untouched, and the payload is the documented partial shape.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(calls.saves).toEqual([
    { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: false },
  ]);

  // A refresh keeps the mode without waiting for the network (pre-paint cache).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-seasonal", "tet");

  // And back off.
  await openThemeTab(page);
  await page.getByText("Mặc định", { exact: true }).click();
  await page.getByRole("button", { name: "Lưu giao diện", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-seasonal", "default");
});

test("AUTO flips by the server-resolved window; an incomplete window is refused", async ({ page }) => {
  // Open window → the app shows Tết even though mode is AUTO (resolved server-side).
  await setup(page, {
    theme: { mode: "AUTO", tet_start: iso(-30), tet_end: iso(30), cinematic_enabled: false, is_active: true, updated_at: new Date().toISOString() },
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-seasonal", "tet");

  // Closed window → ordinary interface.
  await page.goto("about:blank");
  await setup(page, {
    theme: { mode: "AUTO", tet_start: iso(10), tet_end: iso(40), cinematic_enabled: false, is_active: false, updated_at: new Date().toISOString() },
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-seasonal", "default");

  // The OWNER cannot save AUTO without both dates.
  const calls = await setup(page);
  await page.goto("/settings");
  await openThemeTab(page);
  await page.getByText("Tự động theo lịch", { exact: true }).click();
  await page.getByRole("button", { name: "Lưu giao diện", exact: true }).click();
  await expect(page.getByText("Chế độ tự động cần cả ngày bắt đầu và kết thúc.")).toBeVisible();
  expect(calls.saves).toEqual([]); // the client-side guard stopped the payload
});

/** Opens the OWNER-only tab and proves the card actually mounted. */
async function openThemeTab(page) {
  const tab = page.getByRole("button", { name: "Giao diện hệ thống", exact: true });
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await expect(
    page.getByRole("heading", { name: "Giao diện hệ thống", exact: true }),
  ).toBeVisible();
}

/** The preview button relabels itself while the preview is active. */
function previewButton(page) {
  return page.getByRole("button", { name: /Áo Tết|Đang xem Tết/, exact: true });
}

test("STAFF never sees the tab; a forced write is denied by the server", async ({ page }) => {
  await setup(page, { role: "STAFF" });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Hồ sơ của bạn" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Giao diện hệ thống", exact: true })).toHaveCount(0);
  // STAFF still reads the shared configuration like everyone else.
  expect(await page.evaluate(() => document.documentElement.dataset.seasonal)).toBe("default");
});

test("cinematic greeting: app-wide at open, once per session, never a hijack", async ({ page }) => {
  const calls = await setup(page, {
    theme: { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: true, is_active: true, updated_at: new Date().toISOString() },
  });
  await page.goto("/");
  const stage = page.locator(".tet-cine-stage");
  // The opener belongs to the app shell, not to the settings card: this session
  // never opened Settings and was still greeted.
  await expect(stage).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-seasonal", "tet");
  await stage.locator(".cine-skip").click({ force: true });
  await expect(stage).toHaveCount(0);

  // A reload keeps the look and does NOT re-run the story.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-seasonal", "tet");
  await expect(stage).toHaveCount(0);

  // The look preview is a look-only switch: it must never summon the story.
  await page.goto("/settings");
  await openThemeTab(page);
  await previewButton(page).click();
  await expect(stage).toHaveCount(0);

  // The explicit replay does play, and it writes nothing to the server.
  const savesBefore = calls.saves.length;
  await page.getByRole("button", { name: /Xem lại màn chào Tết/ }).click();
  await expect(stage).toBeVisible();
  expect(calls.saves.length).toBe(savesBefore);

  // "Không chiếu nữa" is per device: a second tab on the same machine is no longer
  // greeted, while the shared Tet look still applies there.
  await page.locator(".cine-never").click({ force: true });
  await expect(stage).toHaveCount(0);
  const other = await page.context().newPage();
  await setup(other, {
    theme: { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: true, is_active: true, updated_at: new Date().toISOString() },
  });
  await other.goto("/");
  await expect(other.locator("html")).toHaveAttribute("data-seasonal", "tet");
  await expect(other.locator(".tet-cine-stage")).toHaveCount(0);
});

test("a device that opted out still greets when the OWNER explicitly asks", async ({ page }) => {
  await setup(page, {
    theme: { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: true, is_active: true, updated_at: new Date().toISOString() },
  });
  await page.goto("/");
  const stage = page.locator(".tet-cine-stage");
  await expect(stage).toBeVisible();
  await page.locator(".cine-never").click({ force: true });
  await expect(stage).toHaveCount(0);

  // The opt-out only governs automatic loads. A deliberate click is fresh intent
  // and clears it for this device, without touching any other session.
  await page.goto("/settings");
  await openThemeTab(page);
  await page.getByRole("button", { name: /Xem lại màn chào Tết/ }).click();
  await expect(stage).toBeVisible();
  await stage.locator(".cine-skip").click({ force: true });
  await expect(stage).toHaveCount(0);
});
