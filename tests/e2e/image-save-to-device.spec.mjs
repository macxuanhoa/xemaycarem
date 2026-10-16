import { test, expect } from "@playwright/test";

// Nút "Tải ảnh" ở mục Căn cước công dân và thư viện ảnh xe.
//
// Yêu cầu của cửa hàng: bấm một lần, ảnh về máy. Đường đi KHÔNG giống nhau giữa
// thiết bị, và mỗi đường ở đây là một ràng buộc thật đã từng hỏng:
//  · Máy tính: trình duyệt tải tệp, tên tệp không dấu để hệ điều hành hiển thị
//    thẳng trong thư mục Tải xuống.
//  · Điện thoại có bảng chia sẻ của máy (Android Chrome, iOS Safari): ảnh được
//    đưa vào bảng đó để người dùng chọn "Lưu vào Ảnh" → vào Bộ sưu tập.
//  · iPhone trong trình duyệt nhúng (không chia sẻ được tệp): KHÔNG được tải tệp
//    (ảnh sẽ rơi vào app FILES, sai yêu cầu) mà phải mở khung hướng dẫn nhấn giữ.
//
// Mọi dữ liệu và ký URL đều mô phỏng; không có lượt gọi nào ra ngoài mạng.

const ownerId = "00000000-0000-4000-8000-000000000001";
const vehicleId = "00000000-0000-4000-8000-000000000002";
const acquisitionId = "00000000-0000-4000-8000-0000000000aa";
const SUPABASE = /https:\/\/[a-z0-9-]+\.supabase\.co\/.*/;
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/505.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
/** Một ảnh JPEG "thật" vừa đủ để fetch dựng Blob có MIME image/jpeg. */
const JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const vehicleTitle = "59B1-889.99 · RLHSH35002S012345";
/** Tên tệp mong đợi: không dấu, không khoảng trắng, đuôi theo MIME của ảnh. */
const VEHICLE_FILE = "59B1-889-99-RLHSH35002S012345-ANH-1.jpg";
const CCCD_FILE = "CCCD-NGUOI-BAN-MAT-TRUOC.jpg";

const vehicle = {
  id: vehicleId,
  internal_code: "XE-SAVE-0001",
  vehicle_type_id: "vt-con",
  vehicle_type: "Xe côn tay",
  year: 2024,
  color: "Đen nhám",
  frame_number: "RLHSH35002S012345",
  license_plate: "59B1-889.99",
  supplier_name: "Nguyễn Văn Thành",
  status: "IN_STOCK",
  purchase_date: today,
  purchase_price: 158000000,
  total_cost: 158000000,
  expense_total: 0,
  cost_pending: false,
  expenses: [],
  sales: [],
  activity: [],
  images: [
    {
      id: "00000000-0000-4000-8000-000000000051",
      vehicle_id: vehicleId,
      storage_path: `vehicle-images/${vehicleId}/01.jpg`,
      display_order: 1,
    },
  ],
};

const identityDocument = {
  id: "00000000-0000-4000-8000-0000000000bb",
  id_number: "079123456789",
  front_image_path: `${acquisitionId}/front.jpg`,
  back_image_path: null,
};

async function installMock(page) {
  const session = {
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
  };
  await page.addInitScript(
    (value) =>
      localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    session,
  );
  await page.route(SUPABASE, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
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
    // Kho ảnh: lượt POST ký URL trả body như Supabase (kho thật về đường dẫn
    // tương đối trong `signedURL`, storage-js tự nối thành URL đầy đủ); mọi lượt
    // GET ảnh trả đúng bay bytes JPEG — cùng một liên kết ký thì khung ảnh và nút
    // tải ảnh phải đọc được một ảnh thật, blob mang MIME image/jpeg như máy thật.
    if (url.pathname.startsWith("/storage/v1/")) {
      if (request.method() === "POST")
        return reply({
          signedURL: `${url.pathname}?token=mock-token`,
          token: "mock-token",
        });
      return route.fulfill({
        status: 200,
        body: Buffer.from(JPEG.split(",")[1], "base64"),
        contentType: "image/jpeg",
        headers: { "access-control-allow-origin": "*" },
      });
    }
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "get_vehicle") return reply(vehicle);
    if (name === "list_vehicles") return reply({ items: [vehicle], total: 1 });
    if (name === "get_acquisition_for_vehicle") return reply(acquisitionId);
    if (name === "get_identity_document") return reply(identityDocument);
    return reply({});
  });
}

/** Ghi lại mọi cú gọi bảng chia sẻ của hệ điều hành. */
async function installShareSheet(page, { canShareFiles }) {
  await page.addInitScript((support) => {
    // navigator.share/canShare là accessor chỉ đọc trên Navigator.prototype,
    // nên phải định nghĩa lại ngay trên instance thay vì gán trực tiếp.
    const define = (name, value) =>
      Object.defineProperty(navigator, name, { value, configurable: true });
    window.__shared = [];
    define(
      "canShare",
      (data) =>
        !!(data && data.files && data.files.length && support) &&
        data.files.every((file) => file.type.startsWith("image/")),
    );
    define("share", async (data) => {
      window.__shared.push({
        title: data.title,
        names: (data.files || []).map((file) => file.name),
        types: (data.files || []).map((file) => file.type),
      });
    });
  }, canShareFiles);
}

const shared = (page) => page.evaluate(() => window.__shared);

test.describe("Máy tính — tải tệp bình thường", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("nút 'Tải ảnh' trong thư viện xe tải về tệp có tên không dấu", async ({
    page,
  }) => {
    await installMock(page);
    await page.goto(`/vehicles/${vehicleId}`);
    const save = page.getByRole("button", { name: "Tải ảnh 1/1 về máy" });
    await expect(save).toBeVisible();
    const pending = page.waitForEvent("download");
    await save.click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(VEHICLE_FILE);
  });

  test("nút 'Tải ảnh' của mặt CCCD cũng tải về đúng tên hồ sơ", async ({
    page,
  }) => {
    await installMock(page);
    await page.goto(`/vehicles/${vehicleId}`);
    const save = page.getByRole("button", {
      name: "Tải ảnh CCCD mặt trước về máy",
    });
    await expect(save).toBeVisible();
    const pending = page.waitForEvent("download");
    await save.click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(CCCD_FILE);
  });
});

test.describe("Điện thoại có bảng chia sẻ của máy", () => {
  test.use({
    userAgent: ANDROID_UA,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("chạm 'Tải ảnh' đưa đúng tấm ảnh vào bảng lưu của máy", async ({
    page,
  }) => {
    await installMock(page);
    await installShareSheet(page, { canShareFiles: true });
    await page.goto(`/vehicles/${vehicleId}`);
    await page.getByRole("button", { name: "Tải ảnh 1/1 về máy" }).click();
    await expect
      .poll(() => shared(page), { message: "ảnh phải vào bảng chia sẻ" })
      .toEqual([
        {
          title: `${vehicleTitle} — ảnh 1/1`,
          names: [VEHICLE_FILE],
          types: ["image/jpeg"],
        },
      ]);
  });

  test("mặt CCCD đi qua bảng lưu của máy thay vì tải tệp", async ({ page }) => {
    await installMock(page);
    await installShareSheet(page, { canShareFiles: true });
    await page.goto(`/vehicles/${vehicleId}`);
    await page
      .getByRole("button", { name: "Tải ảnh CCCD mặt trước về máy" })
      .click();
    await expect
      .poll(() => shared(page), { message: "CCCD phải vào bảng chia sẻ" })
      .toEqual([
        {
          title: "CCCD mặt trước — CCCD Người bán Mặt trước",
          names: [CCCD_FILE],
          types: ["image/jpeg"],
        },
      ]);
  });
});

test.describe("iPhone không mở được bảng chia sẻ", () => {
  test.use({
    userAgent: IPHONE_UA,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("mở khung hướng dẫn nhấn giữ, tuyệt đối không tải tệp sang FILES", async ({
    page,
  }) => {
    await installMock(page);
    await installShareSheet(page, { canShareFiles: false });
    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    await page.goto(`/vehicles/${vehicleId}`);
    await page
      .getByRole("button", { name: "Tải ảnh CCCD mặt trước về máy" })
      .click();
    const sheet = page.getByRole("dialog", { name: "Lưu ảnh vào Bộ sưu tập" });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText("Nhấn giữ vào ảnh", { exact: false }),
    ).toBeVisible();
    // Khung nhấn giữ phải đúng tấm ảnh đang hiện trong hồ sơ, không phải ảnh khác.
    const shown = await page.locator(".identity-photo").getAttribute("src");
    expect(shown).toBeTruthy();
    await expect(sheet.locator("img")).toHaveAttribute("src", shown ?? "");
    expect(downloaded).toBe(false);
    await sheet.getByRole("button", { name: "Đã hiểu" }).click();
    await expect(sheet).toHaveCount(0);
  });

  test("bấm tải ngay trong khung ảnh xem lớn: khung hướng dẫn phải đè lên ảnh", async ({
    page,
  }) => {
    await installMock(page);
    await installShareSheet(page, { canShareFiles: false });
    await page.goto(`/vehicles/${vehicleId}`);
    await page.locator(".vehicle-display-main").click();
    await expect(page.locator(".vehicle-display-lightbox")).toBeVisible();
    await page.locator(".vehicle-display-save").click();
    const sheet = page.getByRole("dialog", {
      name: "Lưu ảnh vào Bộ sưu tập",
    });
    await expect(sheet).toBeVisible();
    // toBeVisible() không kiểm tra thứ tự lớp — phải đo điểm ảnh thật giữa khung:
    // nếu nền chỉ z-index 80 thì cú chạm sẽ rơi vào ảnh xem lớn phía sau.
    const onTop = await page.evaluate(() => {
      const lead = document.querySelector(".photo-save-sheet-lead");
      const r = lead.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return !!hit && !!hit.closest(".photo-save-sheet");
    });
    expect(onTop, "khung nhấn giữ không được nằm sau ảnh xem lớn").toBe(true);
  });
});

test.describe("Nút tải ảnh đọc được và chạm được trên điện thoại", () => {
  for (const width of [320, 390, 430]) {
    test.use({ viewport: { width, height: 844 } });

    test(`CCCD ${width}px: "Tải ảnh" đứng cạnh "Gỡ ảnh", đủ cao và không tràn ngang`, async ({
      page,
    }) => {
      await installMock(page);
      await page.goto(`/vehicles/${vehicleId}`);
      // Chờ nguyên trang CCCD hiện ra: hai nút nằm trong slot chỉ tồn tại khi
      // hồ sơ đã tải xong, không có gì để đo trước đó.
      await expect(
        page.getByRole("button", { name: "Tải ảnh CCCD mặt trước về máy" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Gỡ ảnh CCCD mặt trước" }),
      ).toBeVisible();
      const geometry = await page.evaluate(() => {
        const box = (node) => {
          const r = node.getBoundingClientRect();
          return {
            w: Math.round(r.width),
            h: Math.round(r.height),
            right: Math.round(r.right),
          };
        };
        const save = document.querySelector(".identity-slot-save");
        const remove = document.querySelector(".identity-slot-remove");
        return {
          save: box(save),
          remove: box(remove),
          sameRow:
            Math.abs(
              save.getBoundingClientRect().top -
                remove.getBoundingClientRect().top,
            ) <= 1,
          overflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      expect(
        geometry.save.h,
        "nút tải ảnh phải đủ cao để chạm",
      ).toBeGreaterThanOrEqual(41);
      expect(geometry.remove.h).toBeGreaterThanOrEqual(41);
      expect(
        geometry.overflow,
        `${width}px: trang không cuộn ngang`,
      ).toBeLessThanOrEqual(0);
      // Hai nút hoặc cùng hàng, hoặc xếp chồng — không được cắt chữ.
      expect(geometry.sameRow || geometry.save.w >= 90).toBe(true);
    });
  }
});
