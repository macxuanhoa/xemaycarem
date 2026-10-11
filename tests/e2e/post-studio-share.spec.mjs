import { test, expect } from "@playwright/test";

// E2E cho "Đăng bài từ kho xe" + Smart Facebook Share.
//
// Điều cổng này bảo vệ (phần unit test không với tới vì cần trình duyệt thật):
//  1. Mục nav riêng, không nằm sau accordion TRỢ LÝ AI.
//  2. Bước 1 đưa sang trang Kho THẬT ở chế độ chọn (chỉ Chọn / Xem chi tiết,
//     không sửa dữ liệu xe) rồi quay lại trang đăng bài với đúng chiếc xe.
//  3. Mô tả tự do được gửi NGUYÊN VĂN cho trợ lý; kết quả trình bày như bài
//     Facebook; lời nhắc sớm chỉ hiện khi mô tả thật sự phạm quy tắc.
//  4. Nút chuyển bài không bao giờ tự nhận "đã đăng": nhánh dán tay chỉ copy +
//     mở Facebook, và thứ clipboard nhận chính là caption người dùng thấy.
//  5. Bản nháp chờ duyệt hiển thị như bài Facebook kèm nút xác nhận.
//
// Phần KHÔNG test ở đây (cần máy thật, ghi rõ trong báo cáo): Cầu đăng điền vào
// composer của Facebook thật, và share sheet trên điện thoại.

const ownerId = "00000000-0000-4000-8000-000000000001";
const inStockId = "00000000-0000-4000-8000-0000000000b1";
const soldId = "00000000-0000-4000-8000-0000000000b2";
const draftId = "00000000-0000-4000-8000-0000000000d1";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const row = (over) => ({
  internal_code: "CR-0001",
  frame_number: "RLH160KD0123456",
  vehicle_type: "Xe tay ga",
  year: 2023,
  color: "Đen",
  status: "IN_STOCK",
  purchase_date: "2026-10-01",
  days_in_inventory: 5,
  created_at: "2026-10-01T02:00:00Z",
  images: [],
  ...over,
});

const inStock = row({
  id: inStockId,
  license_plate: "43D1-111.22",
  vehicle_title: "43D1-111.22 · RLH160KD0123456",
  vehicle_subtitle: "Xe tay ga · 2023 · Đen",
});
const sold = row({
  id: soldId,
  license_plate: "92D1-888.77",
  frame_number: "MHLE1234567890",
  vehicle_type: "Xe số",
  color: "Trắng",
  status: "SOLD",
  vehicle_title: "92D1-888.77 · MHLE1234567890",
  vehicle_subtitle: "Xe số · 2022 · Trắng",
});

/** Bản chiếu Tier-A đúng như `get_post_studio_context` trả: không giá, không PII. */
const studioContext = (vehicle) => ({
  id: vehicle.id,
  internal_code: vehicle.internal_code,
  license_plate: vehicle.license_plate,
  frame_number: vehicle.frame_number,
  vehicle_type: vehicle.vehicle_type,
  year: vehicle.year,
  color: vehicle.color,
  status: vehicle.status,
  vehicle_title: vehicle.vehicle_title,
  vehicle_subtitle: vehicle.vehicle_subtitle,
  listed_at: "2026-10-01T02:00:00Z",
  images: [{ id: `img-${vehicle.id}`, storage_path: `${vehicle.id}/photo-1.jpg` }],
  store: { store_name: "Cà Rem kiểm thử", phone: "0914929292", address: "Hội An" },
});

const aiCaptions = [
  "Wave Alpha biển 43D1-111.22 vừa về Cà Rem, còn zin, ghé quán uống trà xem xe nhé ☕️",
  "Xe tay ga 2023 màu đen, biển 43D1-111.22 đang ở quán. Inbox Cà Rem để hẹn lịch xem xe.",
  "Cảm ơn anh khách đã tin quán! Chiếc Wave Alpha đã sang tên, mời bà con ghé Cà Rem xem xe.",
];

async function installMock(page, options = {}) {
  const mode = options.ai ?? "ok";
  const seen = { postAi: [] };
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
    (value) => localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    session,
  );
  // Dựng môi trường desktop giống máy khách hàng nhưng KHÔNG có tiện ích: không
  // share sheet, không chrome.runtime, window.open chỉ ghi lại. Nhờ vậy nhánh
  // chạy luôn là MANUAL — nhánh duy nhất test được mà không cần mở Facebook thật.
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true });
  });

  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
        headers: { "access-control-allow-origin": "*" },
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
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
    if (url.pathname.startsWith("/storage/v1/object/sign")) {
      if (request.method() === "POST")
        return reply({ signedURL: `${url.pathname.replace("/storage/v1", "")}?token=e2e` });
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(PNG_1X1, "base64"),
        headers: { "access-control-allow-origin": "*" },
      });
    }
    if (url.pathname.startsWith("/functions/v1/post-ai")) {
      seen.postAi.push(JSON.parse(request.postData() ?? "{}"));
      if (mode === "off") return reply({ error: "AI_NOT_CONFIGURED", message: "Trợ lý chưa bật." }, 503);
      return reply({
        task: "captions",
        model: "gemini-kiem-thu",
        requires_human_review: true,
        captions: aiCaptions,
        vehicle: studioContext(inStock),
      });
    }
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true, must_change_password: false });
    if (name === "get_settings") return reply({ store_name: "Cà Rem kiểm thử" });
    if (name === "list_active_announcements") return reply([]);
    if (name === "list_vehicle_types") return reply([]);
    if (name === "list_vehicles") return reply({ items: [inStock, sold], total: 2 });
    if (name === "get_post_studio_context")
      return reply(studioContext((request.postData() ?? "").includes(soldId) ? sold : inStock));
    if (name === "list_post_drafts")
      return reply({
        items: [
          {
            id: draftId,
            vehicle_id: inStockId,
            post_kind: "SOLD",
            channel: "FACEBOOK",
            tone: "THAN_THIEN",
            caption: aiCaptions[2],
            status: "DRAFT",
            ai_generated: true,
            creator_name: "Chủ kiểm thử",
            vehicle_title: inStock.vehicle_title,
            created_at: "2026-10-11T03:00:00Z",
          },
        ],
        total: 1,
      });
    if (name === "list_post_draft_versions")
      return reply({ items: [], current_caption: aiCaptions[2], status: "DRAFT" });
    if (name === "save_post_draft") return reply(draftId);
    if (name === "set_post_draft_status") return reply(null);
    return reply({});
  });
  return seen;
}


test.describe("Đăng bài từ kho xe", () => {
  // Clipboard là nhánh thật duy nhất test được trên máy CI: cho phép đọc/ghi để
  // chứng minh thứ CRM trao đi đúng là caption người dùng đang thấy.
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  /** Đi đúng luồng người dùng: sang Kho ở chế độ chọn rồi quay lại với chiếc xe. */
  async function pickVehicle(page, plate = "43D1-111.22") {
    await page.getByRole("button", { name: /^Chọn xe từ Kho/ }).click();
    await page.getByRole("button", { name: new RegExp(`Chọn .*${plate.replace(/\./g, "\\.")}`) }).click();
    await expect(page.locator(".ps-picked-vehicle")).toContainText(plate);
  }

  test("nằm ở mục nav riêng, không giấu sau accordion TRỢ LÝ AI", async ({ page }) => {
    await installMock(page);
    await page.goto("/");
    const mainNav = page.locator('nav[aria-label="Chính"]');
    await expect(mainNav.getByRole("link", { name: "Đăng bài từ kho xe" })).toBeVisible();
    // Accordion trợ lý mở ra vẫn không chứa mục này.
    await page.getByRole("button", { name: /TRỢ LÝ AI/ }).click();
    await expect(page.locator("#ai-nav-links")).toBeVisible();
    await expect(
      page.locator("#ai-nav-links").getByRole("link", { name: "Đăng bài từ kho xe" }),
    ).toHaveCount(0);
    await mainNav.getByRole("link", { name: "Đăng bài từ kho xe" }).click();
    await expect(
      page.getByRole("heading", { name: "Đăng bài từ kho xe", level: 1 }),
    ).toBeVisible();
  });

  test("bước 1 sang Kho ở chế độ chọn rồi quay lại với đúng xe đã chọn", async ({ page }) => {
    await installMock(page);
    await page.goto("/posts");
    await page.getByRole("button", { name: /^Chọn xe từ Kho/ }).click();
    await expect(page).toHaveURL(/\/vehicles\?pick=post&return=\/posts/);
    await expect(page.getByRole("heading", { name: "Chọn xe để đăng bài" })).toBeVisible();
    // Chỉ chọn: không bộ lọc nghiệp vụ, không cột giá vốn, chỉ một cột "Chọn".
    await expect(page.getByText("Lọc nhanh")).toHaveCount(0);
    await expect(page.locator("th", { hasText: "Giá vốn" })).toHaveCount(0);
    await expect(page.locator("th", { hasText: "Chọn" })).toHaveCount(1);
    // Chọn xe ĐÃ BÁN → trang đăng bài tự chuyển sang bài dạng đã bán / cảm ơn.
    await page.getByRole("button", { name: /Chọn .*92D1-888\.77/ }).click();
    await expect(page).toHaveURL(/\/posts$/);
    await expect(page.locator(".ps-picked-vehicle")).toContainText("92D1-888.77");
    await expect(page.locator(".ps-picked-vehicle")).toContainText("đã bán");
    await expect(
      page
        .getByRole("group", { name: "Loại bài đăng" })
        .getByRole("button", { name: "Xe vừa bán" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("bước 2 gửi nguyên văn mô tả cho AI và trình bày kết quả như bài Facebook", async ({ page }) => {
    const seen = await installMock(page);
    await page.goto("/posts");
    await pickVehicle(page);
    const brief =
      "Viết bài cảm ơn anh khách mua Wave Alpha 🙏\nNhắc quán hỗ trợ sang tên cuối tuần";
    await page.locator("#ps-brief").fill(brief);
    await expect(page.getByRole("status").filter({ hasText: "Mô tả đang có" })).toHaveCount(0);

    await page.getByRole("button", { name: "Tạo bài viết" }).click();
    await expect(page.locator(".fb-post").first()).toBeVisible();
    expect(seen.postAi).toHaveLength(1);
    expect(seen.postAi[0]).toMatchObject({
      task: "captions",
      post_kind: "NEW_STOCK",
      channel: "FACEBOOK",
    });
    // Nguyên văn, kể cả emoji và xuống dòng — không tự sửa chữ của người bán.
    expect(seen.postAi[0].brief).toBe(brief);

    const firstCard = page.locator(".fb-post").first();
    await expect(firstCard.locator(".fb-post-name")).toHaveText("Cà Rem kiểm thử");
    await expect(firstCard.locator(".fb-post-edit")).toHaveValue(aiCaptions[0]);
    await expect(firstCard.locator('img[alt="Ảnh xe 1"]')).toBeVisible();
    await expect(page.locator(".ps-source").first()).toContainText("AI: gemini-kiem-thu");
    // Không có nút "Đăng" nào trong CRM, và hướng dẫn cài Cầu đăng nói thẳng giới hạn.
    await expect(page.getByRole("button", { name: "Đăng", exact: true })).toHaveCount(0);
    await expect(page.locator(".ps-ext-hint")).toContainText(/KHÔNG bấm Đăng/);
  });

  test("mô tả phạm quy tắc được nhắc sớm ngay dưới ô nhập", async ({ page }) => {
    await installMock(page);
    await page.goto("/posts");
    await page.locator("#ps-brief").fill("Nhấn mạnh giá 25tr5 cho khách dễ hình dung");
    await expect(page.getByRole("status").filter({ hasText: "Mô tả đang có" })).toContainText(
      "giá hoặc con số tiền",
    );
  });

  test("AI tắt vẫn ra bài bằng mẫu có sẵn, nói rõ nguồn và khóa chat sửa bằng AI", async ({ page }) => {
    await installMock(page, { ai: "off" });
    await page.goto("/posts");
    await pickVehicle(page);
    await page.getByRole("button", { name: "Tạo bài viết" }).click();
    await expect(page.locator(".ps-source").first()).toContainText("Dùng mẫu có sẵn");
    await expect(page.locator(".fb-post").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Sửa bằng AI" })).toBeDisabled();
  });

  test("nhánh dán tay: copy đúng caption, mở Facebook, không bao giờ nói đã đăng", async ({
    page,
  }) => {
    await installMock(page);
    await page.goto("/posts");
    await pickVehicle(page);
    await page.getByRole("button", { name: "Tạo bài viết" }).click();
    const card = page.locator(".fb-post").first();
    const caption = await card.locator(".fb-post-edit").inputValue();

    // Clipboard chỉ đọc/ghi được khi tab thật sự được focus.
    await page.bringToFront();
    await card.getByRole("button", { name: "Chuyển vào Facebook" }).click();

    const status = page.locator(".ps-share-status").first();
    await expect(status).toBeVisible();
    // Trung thực: không được tuyên bố bài đã lên Facebook.
    expect(((await status.innerText()) ?? "").toLowerCase()).not.toMatch(
      /đã đăng bài|đã lên facebook|vừa đăng lên facebook/,
    );
    // Bằng chứng thật: clipboard mang đúng caption người dùng vừa thấy.
    const clipped = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipped).toBe(caption);
    expect(await page.evaluate(() => window.__opened)).toContain("https://www.facebook.com/");
  });

  test("bản nháp chờ duyệt trưng như bài Facebook kèm nút xác nhận chuyển bài", async ({ page }) => {
    await installMock(page);
    await page.goto("/posts");
    const draftCard = page.locator(".fb-post").filter({ hasText: aiCaptions[2] }).first();
    await expect(draftCard.locator(".fb-post-caption")).toBeVisible();
    await expect(draftCard.locator(".ps-draft-status")).toHaveText("Nháp");
    const confirm = draftCard.getByRole("button", {
      name: "Xác nhận & chuyển vào Facebook",
    });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(page.locator(".ps-share-status").first()).toBeVisible();
  });
});
