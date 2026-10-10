import { test, expect } from "@playwright/test";

// Mobile inventory card readability guard:
// each vehicle must render as an independent, well-spaced card.
const ownerId = "00000000-0000-4000-8000-000000000001";

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
  const vehicles = [
    {
      id: "00000000-0000-4000-8000-000000000011",
      internal_code: "XE-RD-001",
      vehicle_type: "Xe tay ga",
      year: 2023,
      color: "Đen",
      frame_number: "RLH2023XYZ000001",
      license_plate: "43A1-99999",
      status: "IN_STOCK",
      purchase_date: "2026-09-01",
      days_in_inventory: 31,
      purchase_price: 28000000,
      total_cost: 30000000,
      cost_pending: false,
    },
    {
      id: "00000000-0000-4000-8000-000000000012",
      internal_code: "XE-RD-002",
      vehicle_type: "Xe côn tay",
      frame_number: "RLY155ABC000002",
      license_plate: "43B2-11111",
      status: "RESERVED",
      purchase_date: new Date().toISOString().slice(0, 10),
      days_in_inventory: 0,
      purchase_price: 40000000,
      total_cost: 42000000,
      cost_pending: false,
    },
    {
      id: "00000000-0000-4000-8000-000000000013",
      internal_code: "XE-RD-003",
      vehicle_type: "Xe số",
      frame_number: "RLWRSX000000003",
      license_plate: "43C3-22222",
      status: "IN_STOCK",
      purchase_date: "2026-08-15",
      days_in_inventory: 48,
      purchase_price: 18000000,
      total_cost: 19500000,
      cost_pending: true,
    },
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
    if (name === "list_vehicle_types")
      return reply([
        { id: "vt-so", name: "Xe số", vehicle_count: 1 },
        { id: "vt-ga", name: "Xe tay ga", vehicle_count: 1 },
        { id: "vt-con", name: "Xe côn tay", vehicle_count: 1 },
        { id: "vt-chua", name: "Chưa phân loại", vehicle_count: 0 },
      ]);
    if (name === "list_vehicles")
      return reply({ items: vehicles, total: vehicles.length });
    return reply({});
  });
}

for (const width of [320, 375, 390, 430]) {
  test(`Inventory cards are independent, spaced and readable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installMock(page);
    await page.goto("/vehicles");

    const cards = page.locator(".mobile-cards .mobile-record");
    await expect(cards).toHaveCount(3);
    for (let i = 0; i < 3; i++)
      await expect(cards.nth(i)).toBeVisible();

    // A. Explicit vertical gap between cards in the list container.
    const list = page.locator(".mobile-cards");
    const listGap = await list.evaluate((node) =>
      parseInt(getComputedStyle(node).gap || "0", 10),
    );
    expect(listGap).toBeGreaterThanOrEqual(12);

    // Cards do not touch: real pixel separation between stacked boxes.
    const boxes = await cards.evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      }),
    );
    for (let i = 1; i < boxes.length; i++) {
      const separation = boxes[i].top - boxes[i - 1].bottom;
      expect(separation).toBeGreaterThanOrEqual(listGap - 1);
    }

    // B. Card identity: border, radius, shadow on every card.
    const identity = await cards.first().evaluate((node) => {
      const s = getComputedStyle(node);
      return {
        borderWidth: parseFloat(s.borderTopWidth),
        radius: parseFloat(s.borderTopLeftRadius),
        hasShadow: s.boxShadow && s.boxShadow !== "none",
      };
    });
    expect(identity.borderWidth).toBeGreaterThanOrEqual(1);
    expect(identity.radius).toBeGreaterThanOrEqual(10);
    expect(identity.hasShadow).toBe(true);

    // C. Internal hierarchy: type name leads, plate/chassis render as
    //    emphasized chips, then a grouped detail box, financials and cost.
    const card = cards.first();
    await expect(card.locator(".row").first().locator("strong")).toHaveText("Xe tay ga");
    await expect(card.getByText("Sẵn sàng bán", { exact: true })).toBeVisible();
    // Biển số & số khung nổi bật trong chip riêng (data-testid ổn định).
    await expect(card.getByTestId("plate-chip")).toContainText("43A1-99999");
    await expect(card.getByTestId("frame-chip")).toContainText("RLH2023XYZ000001");
    await expect(card.locator(".record-details")).toBeVisible();
    // Mã nội bộ được ẩn khỏi thẻ danh sách (phương án B). Vẫn tìm được xe
    // bằng mã qua ô tìm kiếm; nên thẻ không còn hiển thị dòng "Mã xe:".
    await expect(card.getByText("Mã xe:")).toHaveCount(0);
    await expect(card.getByText("Đời xe: 2023", { exact: true })).toBeVisible();
    await expect(card.getByText("Màu sắc: Đen", { exact: true })).toBeVisible();
    await expect(card.locator(".record-cost")).toContainText("Giá vốn:");

    // D. Actions are a compact ••• pinned to the card's top-right corner.
    const actions = card.locator(".record-actions");
    await expect(
      actions.getByRole("button", { name: "Thao tác với 43A1-99999 · RLH2023XYZ000001" }),
    ).toBeVisible();
    const corner = await actions.evaluate((node) => {
      const parent = node.closest(".mobile-record");
      const a = node.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      return {
        insideCard: Boolean(parent),
        position: getComputedStyle(node).position,
        nearTopRight: a.top - p.top < 24 && p.right - a.right < 24,
      };
    });
    expect(corner.insideCard).toBe(true);
    expect(corner.position).toBe("absolute");
    expect(corner.nearTopRight).toBe(true);

    // Date/age must not collide ("01/09/202631 ngày").
    await expect(card.locator(".record-age")).toHaveText("31 ngày");
    const [dateBox, ageBox] = await Promise.all([
      card.locator(".record-date").boundingBox(),
      card.locator(".record-age").boundingBox(),
    ]);
    expect(ageBox.x).toBeGreaterThan(dateBox.x);
    const ageSpacing = await card
      .locator(".record-age")
      .evaluate((node) => parseFloat(getComputedStyle(node).marginLeft));
    expect(ageSpacing).toBeGreaterThanOrEqual(4);
    // "Hôm nay" case renders as its own chip.
    await expect(cards.nth(1).locator(".record-age")).toHaveText("Hôm nay");

    // Long names wrap instead of crowding the badge.
    const title = await cards
      .nth(1)
      .locator(".row")
      .first()
      .locator("strong")
      .boundingBox();
    const cardBox = await cards.nth(1).boundingBox();
    expect(title.x + title.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width + 1,
    );

    // No horizontal overflow or clipping.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    await page.screenshot({
      path: `test-results/inventory-readability-${width}.png`,
      fullPage: true,
    });
  });
}

test("Inventory card readability holds on tablet", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 1024 });
  await installMock(page);
  await page.goto("/vehicles");
  await expect(page.locator(".mobile-record").first()).toBeVisible();
  const listGap = await page
    .locator(".mobile-cards")
    .evaluate((node) => parseInt(getComputedStyle(node).gap || "0", 10));
  expect(listGap).toBeGreaterThanOrEqual(12);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(760);
  await page.screenshot({
    path: "test-results/inventory-readability-760.png",
    fullPage: true,
  });
});

test("Desktop table layout is untouched", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installMock(page);
  await page.goto("/vehicles");
  await expect(page.locator(".desktop-table")).toBeVisible();
  await expect(page.locator(".mobile-cards")).toBeHidden();
  await expect(page.locator(".desktop-table tbody tr")).toHaveCount(3);
});
