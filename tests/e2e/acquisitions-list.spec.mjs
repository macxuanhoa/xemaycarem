import { test, expect } from "@playwright/test";

const ownerId = "00000000-0000-4000-8000-000000000001";
const vehicleId = "00000000-0000-4000-8000-000000000002";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

async function installMock(page) {
  const calls = [];
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
    calls.push({ name, body });
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "list_acquisitions") {
      return reply({
        items: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            vehicle_id: vehicleId,
            frame_number: "RLH123456",
            license_plate: "43A1-99999",
            brand: "Honda",
            model: "Vision",
            internal_code: "XE-UX-001",
            acquisition_date: today,
            purchase_price: 32000000,
            seller_name: "Nguyễn Văn Thanh",
            seller_phone: "0905123456",
            status: "COMPLETED",
            creator_name: "Chủ kiểm thử",
          },
        ],
        total: 1,
      });
    }
    return reply({});
  });
  return calls;
}

test("Thu vào list page preserves UX, simplifies date presets, enhances table readability and suppresses footer", async ({
  page,
}) => {
  await installMock(page);
  await page.goto("/acquisitions");

  // 1. Page Header & Primary Action preserved
  await expect(
    page.getByRole("heading", { name: "Thu vào", exact: true }),
  ).toBeVisible();
  const cta = page.getByRole("link", { name: "Thu xe mới", exact: true });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", "/acquisitions/new");

  // 2. Local search and global header both exist
  const searchInput = page.getByLabel("Tìm kiếm xe thu vào", { exact: true });
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveAttribute(
    "placeholder",
    "Tìm số khung, biển số, hãng, dòng xe, người bán…",
  );

  // 3. Date presets: 4 quick chips + 1 custom button, NO duplicate select dropdown
  await expect(page.getByRole("button", { name: "Hôm nay", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tuần này", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tháng này", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tháng trước", exact: true })).toBeVisible();
  const customBtn = page.getByRole("button", { name: "Tùy chọn ngày", exact: true });
  await expect(customBtn).toBeVisible();

  // No duplicate <select> dropdown in the filter area
  await expect(page.locator(".date-range select")).toHaveCount(0);

  // 4. Default preset: custom date range inputs are NOT visible
  await expect(page.locator(".date-inputs-pill")).toHaveCount(0);

  // 5. Clicking "Tùy chọn ngày" reveals the explicit DD/MM/YYYY inputs
  await customBtn.click();
  await expect(page.locator(".date-inputs-pill")).toBeVisible();
  await expect(page.getByLabel("Từ ngày (DD/MM/YYYY)")).toBeVisible();
  await expect(page.getByLabel("Đến ngày (DD/MM/YYYY)")).toBeVisible();

  // 6. Clicking a preset hides the custom date inputs again
  await page.getByRole("button", { name: "Hôm nay", exact: true }).click();
  await expect(page.locator(".date-inputs-pill")).toHaveCount(0);

  // 7. Table readability:
  // - Distinct semantic labels: Khung: and BS:
  await expect(page.locator(".data-table")).toBeVisible();
  await expect(page.locator(".data-table").getByText("Khung:")).toBeVisible();
  await expect(page.locator(".data-table").getByText("RLH123456")).toBeVisible();
  await expect(page.locator(".data-table").getByText("BS:")).toBeVisible();
  await expect(page.locator(".data-table").getByText("43A1-99999")).toBeVisible();

  // - Primary vehicle name + muted internal code
  await expect(page.locator(".data-table").getByText("Honda Vision")).toBeVisible();
  await expect(page.locator(".data-table").getByText("XE-UX-001")).toBeVisible();

  // - Seller name + phone as secondary
  await expect(page.locator(".data-table").getByText("Nguyễn Văn Thanh")).toBeVisible();
  await expect(page.locator(".data-table").getByText("0905123456")).toBeVisible();

  // - Right-aligned monetary amount formatted with ₫
  const priceCell = page.locator(".data-table td.numeric.price");
  await expect(priceCell).toBeVisible();
  await expect(priceCell).toContainText("32.000.000");
  await expect(priceCell).toContainText("₫");

  // - Detail action arrow with accessible title & label
  const detailLink = page.getByRole("link", {
    name: "Xem chi tiết xe Honda Vision",
  });
  await expect(detailLink).toBeVisible();
  await expect(detailLink).toHaveAttribute("href", `/vehicles/${vehicleId}`);

  // 8. Footer copy suppression:
  await expect(
    page.getByText("Cà Rem · Vận hành cửa hàng xe máy chuyên nghiệp."),
  ).toHaveCount(0);
  await expect(page.getByText("Dữ liệu được phân quyền")).toHaveCount(0);
});

test("Thu vào list mobile responsive view has accessible cards, distinct chassis/plate, and no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMock(page);
  await page.goto("/acquisitions");

  // Mobile card is visible
  const card = page.locator(".mobile-cards .mobile-record").first();
  await expect(card).toBeVisible();

  // Distinct chassis & plate subline
  await expect(card.getByText("Khung:")).toBeVisible();
  await expect(card.getByText("RLH123456")).toBeVisible();
  await expect(card.getByText("BS:")).toBeVisible();
  await expect(card.getByText("43A1-99999")).toBeVisible();

  // Primary action Thu xe mới visible
  await expect(
    page.getByRole("link", { name: "Thu xe mới", exact: true }),
  ).toBeVisible();

  // No horizontal page overflow
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  const clientWidth = await page.evaluate(
    () => document.documentElement.clientWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
});
