import { test, expect } from "@playwright/test";

// The field purge turned the free-text "Dòng xe" (model) column into a mandatory
// catalogue "Loại xe" picker and dropped brand/variant/engine_number/odometer/
// asking_price from the vehicle form entirely. This spec guards that contract on
// the very screen staff create vehicles from: none of the six old inputs may
// reappear, the type must come from the catalogue, and it must be required.

const ownerId = "00000000-0000-4000-8000-000000000001";
const catalogue = [
  { id: "vt-ga", name: "Xe tay ga", vehicle_count: 0 },
  { id: "vt-so", name: "Xe số", vehicle_count: 0 },
  { id: "vt-con", name: "Xe côn tay", vehicle_count: 0 },
  { id: "vt-dien", name: "Xe điện", vehicle_count: 0 },
  { id: "vt-50", name: "Ga 50cc", vehicle_count: 0 },
  { id: "vt-chua", name: "Chưa phân loại", vehicle_count: 0 },
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
    if (name === "list_vehicles") return reply({ items: [], total: 0 });
    if (name === "save_vehicle") {
      saveRequests.push(request.postDataJSON());
      return reply({ error: "unexpected save" }, 400);
    }
    return reply({});
  });
  return saveRequests;
}

test("vehicle form shows no purged spec fields and offers a catalogue type picker", async ({ page }) => {
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

  // "Loại xe" is now a select fed by the catalogue, not a free-text field.
  const typeSelect = page.getByLabel("Loại xe *", { exact: true });
  await expect(typeSelect).toBeVisible();
  const options = await typeSelect.locator("option").allTextContents();
  for (const type of catalogue)
    expect(options).toContain(type.name);
  expect(options).toContain("Chưa phân loại");
});

test("saving a vehicle without a catalogue type is blocked before any request", async ({ page }) => {
  const saveRequests = await installMock(page);
  await page.goto("/vehicles/new");
  await page.getByLabel("Biển số", { exact: true }).fill("59A1-234.56");
  await page.getByLabel("Giá mua (₫) *", { exact: false }).fill("20000000");
  await page.getByRole("button", { name: "Lưu xe mới", exact: true }).click();

  await expect(page.getByText("Chọn loại xe.")).toBeVisible();
  expect(saveRequests).toHaveLength(0);
});
