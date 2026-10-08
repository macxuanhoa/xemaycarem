import { test, expect } from "@playwright/test";

// Vehicle detail page on phones: the "Thông tin chi tiết" block carries long,
// unbreakable values (17-char VIN frame numbers, engine numbers, codes) next to
// 44px copy buttons. On narrow screens the details list must render as a single
// column, never overflow its card, and never create a horizontal page scroll.
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
  internal_code: "XE-DET-0001",
  vehicle_type_id: "vt-con",
  vehicle_type: "Xe côn tay",
  year: 2024,
  color: "Đen nhám",
  frame_number: "RLHSH35002S012345",
  license_plate: "59-B1 889.99",
  supplier_name: "Nguyễn Văn Thành",
  supplier_phone: "0914929292",
  notes: "Xe chính chủ, đã sang tên. Kèm sẵn 2 mũ bảo hiểm và bộ sạc theo xe.",
  status: "IN_STOCK",
  purchase_date: today,
  purchase_price: 158000000,
  expense_total: 2500000,
  total_cost: 160500000,
  cost_pending: false,
  expenses: [
    {
      id: "00000000-0000-4000-8000-000000000021",
      description: "Thay nhớt và cân bằng bánh trước",
      expense_type: "REPAIR",
      amount: 850000,
      expense_date: today,
      status: "ACTIVE",
    },
  ],
  images: [],
  activity: [
    {
      id: "00000000-0000-4000-8000-000000000031",
      action: "PURCHASE",
      actor_name: "Chủ kiểm thử",
      created_at: new Date().toISOString(),
    },
  ],
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
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "get_vehicle") return reply(seedVehicle);
    if (name === "get_acquisition_for_vehicle") return reply(null);
    if (name === "list_vehicles")
      return reply({ items: [seedVehicle], total: 1 });
    return reply({});
  });
}

for (const width of [320, 390]) {
  test(`Vehicle details stay readable and inside their card at ${width}px`, async ({
    page,
  }) => {
    await installMock(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/vehicles/${vehicleId}`);
    await expect(
      page.getByRole("heading", { name: "Thông tin chi tiết" }),
    ).toBeVisible();

    const geometry = await page.evaluate(() => {
      const dl = document.querySelector(".details-list");
      const card = dl.closest(".card");
      const dlBox = dl.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const inner = getComputedStyle(card);
      const contentRight =
        cardBox.right - parseFloat(inner.paddingRight || "0");
      const contentLeft = cardBox.left + parseFloat(inner.paddingLeft || "0");
      // Every value cell (including its copy button) must fit the card content box.
      const overflowing = [...dl.querySelectorAll("dd")].filter((dd) => {
        const box = dd.getBoundingClientRect();
        return box.right > contentRight + 1 || box.left < contentLeft - 1;
      });
      return {
        pageScroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        dlWidth: dlBox.width,
        overflowingCount: overflowing.length,
        overflowingLabels: overflowing.map(
          (dd) => dd.parentElement.querySelector("dt")?.textContent,
        ),
        columns: getComputedStyle(dl).gridTemplateColumns.split(" ").length,
      };
    });
    await page.screenshot({
      path: `test-results/vehicle-detail-mobile-${width}.png`,
      fullPage: true,
    });
    expect(
      geometry.pageScroll,
      `${width}px: page must not scroll horizontally`,
    ).toBeLessThanOrEqual(geometry.viewport);
    expect(
      geometry.overflowingCount,
      `${width}px: overflowing value cells: ${geometry.overflowingLabels.join(", ")}`,
    ).toBe(0);
    expect(
      geometry.columns,
      `${width}px: details list must collapse to one column`,
    ).toBe(1);
  });
}
