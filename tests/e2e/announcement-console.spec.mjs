import { test, expect } from "@playwright/test";

// Announcement console (Cài đặt → Tin nhắn & Bảng tin) contract: the OWNER sees
// real derived status per announcement (đang hiển thị / hẹn giờ / hết hạn / tạm
// ngừng), the stat cards and filters agree with each other, the composer fills
// from a ready template and previews on both device frames, and nothing
// overflows the 390px viewport.
const ownerId = "00000000-0000-4000-8000-000000000009";
const hour = 3_600_000;

const announcement = (over = {}) => ({
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  title: "Lịch nghỉ lễ 30/4",
  message: "Cửa hàng nghỉ từ 30/04 đến hết 03/05.",
  type: "INFO",
  display_mode: "STATIC",
  audience: "ALL",
  is_active: true,
  starts_at: null,
  ends_at: null,
  dismissible: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

async function installMock(page, { items = [] } = {}) {
  await page.addInitScript(
    (value) =>
      localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    {
      access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
        JSON.stringify({
          sub: ownerId,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
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
    },
  );
  const routes = [
    [
      "/rest/v1/profiles",
      () => [
        {
          id: ownerId,
          full_name: "Chủ cửa hàng thử nghiệm",
          role: "OWNER",
          active: true,
          can_view_financials: true,
          must_change_password: false,
          disabled_until: null,
          allowed_from: null,
          allowed_until: null,
          working_days: null,
          deleted_at: null,
          username: "owner",
        },
      ],
    ],
    ["/rest/v1/rpc/check_user_access", { allowed: true }],
    ["/rest/v1/rpc/get_settings", { store_name: "Cửa hàng kiểm thử" }],
    ["/rest/v1/rpc/list_active_announcements", []],
    ["/rest/v1/rpc/list_announcements", () => ({ items })],
    ["/rest/v1/rpc/save_announcement", () => announcement()],
    ["/rest/v1/rpc/set_announcement_active", () => announcement()],
    ["/rest/v1/rpc/delete_announcement", () => ({ ok: true })],
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
        id: ownerId,
        aud: "authenticated",
        role: "authenticated",
        email: "owner@example.test",
        app_metadata: {},
        user_metadata: {},
      });
    for (const [match, value] of routes) {
      const hit =
        match instanceof RegExp ? match.test(url.pathname) : url.pathname === match;
      if (hit) return reply(typeof value === "function" ? value() : value);
    }
    return reply({});
  });
}

async function openConsole(page) {
  await page.goto("/settings");
  await page
    .getByRole("button", { name: /Tin nhắn & Bảng tin/ })
    .click();
  await expect(page.locator(".announcement-console")).toBeVisible();
}

test("Owner console renders derived status, matching stats and filters", async ({
  page,
}) => {
  const now = Date.now();
  await installMock(page, {
    items: [
      announcement(),
      announcement({
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        title: null,
        type: "WARNING",
        display_mode: "SCROLLING",
        audience: "STAFF",
        message: "Nhắc quy trình bàn giao xe: kiểm tra đồng hồ, phụ kiện, hóa đơn.",
      }),
      announcement({
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        title: "Bảo trì phần mềm",
        type: "CRITICAL",
        starts_at: new Date(now + 24 * hour).toISOString(),
        ends_at: new Date(now + 26 * hour).toISOString(),
      }),
      announcement({
        id: "aaaaaaaa-0000-4000-8000-000000000004",
        title: "Khen thưởng tháng trước",
        type: "SUCCESS",
        ends_at: new Date(now - hour).toISOString(),
      }),
      announcement({
        id: "aaaaaaaa-0000-4000-8000-000000000005",
        title: "Nghỉ lễ giỗ Tổ",
        is_active: false,
      }),
    ],
  });
  await openConsole(page);

  await expect(page.locator(".ac-card")).toHaveCount(5);
  const statuses = page.locator(".ac-status");
  await expect(statuses.nth(0)).toHaveText("Đang hiển thị");
  await expect(statuses.nth(2)).toHaveText("Đã hẹn giờ");
  await expect(statuses.nth(3)).toHaveText("Đã hết hạn");
  await expect(statuses.nth(4)).toHaveText("Tạm ngừng");

  // Stat cards agree with the same derivation: 2 live, 1 scheduled, 2 idle.
  await expect(page.locator(".ac-stat-num").nth(0)).toHaveText("5");
  await expect(page.locator(".ac-stat-num").nth(1)).toHaveText("2");
  await expect(page.locator(".ac-stat-num").nth(2)).toHaveText("1");
  await expect(page.locator(".ac-stat-num").nth(3)).toHaveText("2");

  // Filter chips narrow the list and the counts match the stat row.
  await page.getByRole("button", { name: /Hẹn giờ/ }).click();
  await expect(page.locator(".ac-card")).toHaveCount(1);
  await expect(page.locator(".ac-card-title")).toHaveText("Bảo trì phần mềm");
  await page.getByRole("button", { name: /^Tất cả/ }).click();
  await expect(page.locator(".ac-card")).toHaveCount(5);

  // A scheduled row cannot be force-activated from the list.
  await expect(
    page.locator(".ac-card").nth(3).getByRole("button", { name: /Kích hoạt/ }),
  ).toBeDisabled();
});

test("Composer opens with templates, pill choices and dual-device preview", async ({
  page,
}) => {
  await installMock(page, { items: [announcement()] });
  await openConsole(page);

  await page.getByRole("button", { name: /Tạo thông báo/ }).first().click();
  await expect(page.locator(".ac-form")).toBeVisible();
  await expect(page.locator(".ac-device-desktop")).toBeVisible();
  await expect(page.locator(".ac-device-phone")).toBeVisible();
  await expect(
    page.locator(".ac-device-phone .announcement-static-text"),
  ).toHaveText("Nhập nội dung để xem trước.");

  // Sample content lands in the fields and in the live preview.
  await page.getByRole("button", { name: "Lịch nghỉ lễ" }).click();
  await expect(page.locator(".ac-form textarea")).toContainText("Hotline");
  await expect(
    page.locator(".ac-device-desktop .announcement-static-text"),
  ).toContainText("Lịch nghỉ lễ:");

  // Pill selectors are real toggles, not native selects.
  await page.getByRole("button", { name: "Khẩn cấp" }).click();
  await expect(
    page.locator('.ac-pill-option.ac-po-CRITICAL[aria-pressed="true"]'),
  ).toHaveCount(1);
  await expect(page.locator(".ac-device .announcement-CRITICAL")).toHaveCount(2);

  // Quick schedule writes concrete Vietnam-time bounds into the datetime fields.
  await page.getByRole("button", { name: "7 ngày tới" }).click();
  await expect(page.locator('input[type="datetime-local"]').nth(0)).not.toHaveValue("");
  await expect(page.locator('input[type="datetime-local"]').nth(1)).not.toHaveValue("");

  // Ends-before-starts blocks the save.
  await page.locator('input[type="datetime-local"]').nth(1).fill("2020-01-01T08:00");
  await expect(page.getByText("Giờ ngừng phải muộn hơn giờ bắt đầu.")).toBeVisible();
  await expect(page.locator(".ac-form button[type=submit]")).toBeDisabled();

  // Switch rows are keyboard reachable and reflected in the payload controls.
  await page.getByText("Cho phép ẩn").click();
  await expect(page.locator(".ac-switch input").nth(1)).not.toBeChecked();
});

test("Console stays inside the layout column on phones and desktops", async ({
  page,
}) => {
  const now = Date.now();
  await installMock(page, {
    items: [
      announcement({
        message:
          "Cửa hàng nghỉ Tết Nguyên đán từ ngày 27/01 đến hết ngày 02/02. Hotline hỗ trợ bán hàng và bảo hành trong thời gian nghỉ: 0905 111 222.",
      }),
      announcement({
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        title: "Bảo trì phần mềm",
        type: "CRITICAL",
        starts_at: new Date(now + 24 * hour).toISOString(),
        ends_at: new Date(now + 26 * hour).toISOString(),
      }),
    ],
  });

  // Chrome thu nhỏ layout viewport về 980px khi mô phỏng điện thoại bằng
  // setViewportSize, nên so với window.innerWidth sẽ luôn "tràn" giả. Cách tin
  // cậy: không khối nào được cuộn ngang bên trong chính nó (scrollWidth > clientWidth).
  const overflowProbe = () =>
    Array.from(
      document.querySelectorAll(
        ".announcement-console, .announcement-console *",
      ),
    )
      .filter((node) => node.scrollWidth - node.clientWidth > 1)
      .filter((node) => getComputedStyle(node).overflowX === "visible")
      .map(
        (node) =>
          `${node.className || node.tagName}: ${node.scrollWidth}>${node.clientWidth}`,
      );

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await openConsole(page);
    const overflowing = await page.evaluate(overflowProbe);
    expect(overflowing, `overflow at ${width}px`).toEqual([]);

    // Mỗi thẻ giữ nội dung trong khối của nó, không phình ra ngoài cột.
    const card = page.locator(".ac-card").first();
    expect(
      await card.evaluate(
        (node) => node.scrollWidth - node.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    // Nội dung dài tự ngắt dòng, không đẩy pill nào tràn ra khỏi thẻ.
    expect(
      await page
        .locator(".ac-card-message")
        .first()
        .evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
  }

  // Mobile giữ sàn 16px cho ô nhập để iOS không phóng khi focus.
  await page.setViewportSize({ width: 390, height: 844 });
  await openConsole(page);
  await page.getByRole("button", { name: /Tạo thông báo/ }).first().click();
  const fontSize = await page
    .locator(".ac-form textarea")
    .evaluate((node) => getComputedStyle(node).fontSize);
  expect(parseFloat(fontSize)).toBeGreaterThanOrEqual(16);
  const formOverflow = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".ac-form, .ac-form *"))
      .filter(
        (node) =>
          node.scrollWidth - node.clientWidth > 1 &&
          getComputedStyle(node).overflowX === "visible",
      )
      .map((node) => String(node.className)),
  );
  expect(formOverflow).toEqual([]);
});

test("Empty console invites the first announcement honestly", async ({ page }) => {
  await installMock(page, { items: [] });
  await openConsole(page);
  await expect(page.locator(".ac-empty")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chưa có thông báo nào" })).toBeVisible();
  await expect(page.locator(".announcement-admin-list")).toHaveCount(0);
});
