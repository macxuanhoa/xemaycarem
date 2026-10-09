import { test, expect } from "@playwright/test";

// 10/10/2026: "Loại xe" từ bỏ danh mục <select> để thành ô NHẬP TỰ DO có
// autocomplete. Gợi ý lấy từ DISTINCT vehicle_type của xe ĐÃ LƯU trong Kho
// (list_vehicles), không phải danh mục seed. Nhân viên gõ được tên mới chưa từng
// có; server chuẩn hoá + get-or-create khi lưu. Spec này giữ hợp đồng đó trên
// màn hình tạo xe: sáu trường cũ không được quay lại, "Loại xe" là combobox tự
// do (không còn là <select> danh mục), và nó vẫn bắt buộc phải có.

const ownerId = "00000000-0000-4000-8000-000000000001";

// Danh mục cũ: vẫn stub cho list_vehicle_types (bộ lọc Kho dùng), nhưng Ô NHẬP
// không còn đọc nó nữa — nên input không phụ thuộc danh mục này.
const catalogue = [
  { id: "vt-ga", name: "Xe tay ga", vehicle_count: 0 },
  { id: "vt-so", name: "Xe số", vehicle_count: 0 },
  { id: "vt-con", name: "Xe côn tay", vehicle_count: 0 },
  { id: "vt-dien", name: "Xe điện", vehicle_count: 0 },
  { id: "vt-50", name: "Ga 50cc", vehicle_count: 0 },
  { id: "vt-chua", name: "Chưa phân loại", vehicle_count: 0 },
];

// Xe đã lưu trong Kho — nguồn gợi ý "Loại xe" (DISTINCT vehicle_type).
const storedVehicles = [
  { id: "v1", vehicle_type: "Honda Vision", color: "Đen" },
  { id: "v2", vehicle_type: "Honda Vision", color: "Trắng" },
  { id: "v3", vehicle_type: "Wave Alpha", color: "Xám" },
];

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
    (value) => localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    session,
  );
  const saveRequests = [];
  await page.route("https://xe-test.supabase.co/**", async (route) => {
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
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true });
    if (name === "list_active_announcements") return reply([]);
    if (name === "list_notifications") return reply({ items: [], unread_count: 0 });
    if (name === "get_settings") return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "list_vehicle_types") return reply(catalogue);
    if (name === "list_vehicles") return reply({ items: storedVehicles, total: storedVehicles.length });
    if (name === "check_vehicle_duplicates")
      return reply({ level: "GREEN", reason: "", candidates: [], candidate_ids: [] });
    if (name === "save_vehicle") {
      saveRequests.push(request.postDataJSON());
      return reply({ error: "unexpected save" }, 400);
    }
    return reply({});
  });
  return saveRequests;
}

test("vehicle form shows no purged spec fields and offers a free-text autocomplete type", async ({ page }) => {
  await installMock(page);
  await page.goto("/vehicles/new");
  await expect(page.getByRole("heading", { name: "Nhập xe mới", exact: true })).toBeVisible();

  // The six purged inputs must never render again.
  for (const label of [
    "Hãng xe",
    "Dòng xe *",
    "Dòng xe",
    "Phiên bản",
    "Số máy",
    "Giá bán dự kiến (₫)",
  ])
    await expect(page.getByLabel(label, { exact: false })).toHaveCount(0);

  // "Loại xe" là ô nhập tự do (input[role=combobox]), KHÔNG còn là <select>.
  const typeField = page.getByLabel("Loại xe *", { exact: true });
  await expect(typeField).toBeVisible();
  await expect(typeField).toHaveAttribute("role", "combobox");
  await expect(page.getByRole("listbox")).toHaveCount(0); // chưa mở khi trống

  // Gợi ý học từ xe đã lưu: gõ "Honda" thì "Honda Vision" (DISTINCT) hiện ra.
  await typeField.click();
  await typeField.fill("Honda");
  await expect(page.getByRole("option", { name: "Honda Vision" })).toBeVisible();
  // Wave Alpha không khớp "Honda" nên bị lọc ra khỏi danh sách gợi ý.
  await expect(page.getByRole("option", { name: "Wave Alpha" })).toHaveCount(0);

  // Một tên hoàn toàn mới vẫn gõ được (không khớp gợi ý nào) — không bị chặn.
  await typeField.fill("Honda Winner X 2026");
  await expect(typeField).toHaveValue("Honda Winner X 2026");
});

test("saving a vehicle without a type name is blocked before any request", async ({ page }) => {
  const saveRequests = await installMock(page);
  await page.goto("/vehicles/new");
  await page.getByLabel("Biển số", { exact: true }).fill("59A1-234.56");
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("20000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();

  await expect(page.getByText("Nhập loại / dòng xe")).toBeVisible();
  expect(saveRequests).toHaveLength(0);
});
