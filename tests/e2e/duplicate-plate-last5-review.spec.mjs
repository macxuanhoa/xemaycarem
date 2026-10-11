import { expect, test } from "@playwright/test";

// Nghi trùng PLATE_AND_LAST5 — luồng UI client cho migration 20261011000400.
// Server là nơi chốt quyết định (tests/db/duplicate-plate-last5-review.test.mjs);
// spec này khoá frontend không được "mềm" hơn hợp đồng nghiệp vụ:
//   * FULL_FRAME_MATCH = chặn tuyệt đối với MỌI vai trò (kể cả Chủ) — không lưu,
//     cũng không được gửi yêu cầu xác minh;
//   * PLATE_AND_LAST5: STAFF không lưu xe, chỉ GỬI YÊU CẦU (request_vehicle_duplicate_review,
//     KHÔNG bao giờ acquire_vehicle/save_vehicle → không tạo xe trước duyệt);
//   * OWNER/MANAGER lưu NGOẠI LỆ trực tiếp (acquire_vehicle kèm bộ ba duplicate_override),
//     bắt buộc lý do ≥ 5 ký tự + chọn đúng hồ sơ đã đối chiếu;
//   * hàng đợi /duplicate-reviews (OWNER/MANAGER) phê duyệt/từ chối qua
//     resolve_vehicle_duplicate_review; giá vốn riêng tư của xe đối chiếu KHÔNG lộ;
//   * mất mạng: client chặn trước RPC, giữ request_id để gửi lại idempotent;
//   * desktop (1440) và mobile (390) cùng chạy.

const staffId = "00000000-0000-4000-8000-00000000000a";
const managerId = "00000000-0000-4000-8000-00000000000b";
const ownerId = "00000000-0000-4000-8000-000000000001";
const candidateId = "00000000-0000-4000-8000-0000000000c1";
const approvalId = "00000000-0000-4000-8000-0000000000ad";
const newVehicleId = "00000000-0000-4000-8000-0000000000ee";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

// Giá vốn RIÊNG TƯ của xe đối chiếu (chỉ OWNER thấy ở hồ sơ xe). Hàng đợi xác
// minh nghi trùng KHÔNG bao giờ được render con số này.
const ownerSecretCost = 41414141;

const candidateVehicle = {
  id: candidateId,
  internal_code: "XE-DUP-0001",
  vehicle_type: "Xe tay ga",
  year: 2022,
  color: "Đỏ",
  frame_number: "RLHJDUPCAND001",
  license_plate: "59N1-555.55",
  supplier_name: "Người bán cũ",
  supplier_phone: "0900000009",
  notes: "",
  status: "IN_STOCK",
  purchase_date: today,
  purchase_price: ownerSecretCost,
  expense_total: 0,
  total_cost: ownerSecretCost,
  cost_pending: false,
  expenses: [],
  images: [],
  activity: [],
  sales: [],
};

const savedVehicle = {
  ...candidateVehicle,
  id: newVehicleId,
  internal_code: "XE-DUP-0002",
  frame_number: "RLHJDUPCAND989",
  color: "Trắng",
  year: 2024,
  supplier_name: "Người bán Z",
  purchase_price: 30000000,
  total_cost: 30000000,
};

// Thí sinh nghi trùng do check_vehicle_duplicates trả về (chữ ký nhận diện,
// không có giá vốn).
const dupCandidate = {
  id: candidateId,
  internal_code: "XE-DUP-0001",
  license_plate: "59N1-555.55",
  frame_number: "RLHJDUPCAND001",
  frame_input_kind: "FULL",
  status: "IN_STOCK",
  vehicle_title: "59N1-555.55 · RLHJDUPCAND001",
};

const DUP = {
  GREEN: { level: "GREEN", reason: "", candidates: [], candidate_ids: [] },
  PLATE: {
    level: "RED",
    reason: "PLATE_AND_LAST5",
    candidates: [dupCandidate],
    candidate_ids: [candidateId],
  },
  FULL: {
    level: "RED",
    reason: "FULL_FRAME_MATCH",
    candidates: [dupCandidate],
    candidate_ids: [candidateId],
  },
};

// Một yêu cầu nghi trùng đang chờ trong hàng đợi OWNER/MANAGER. Payload do
// server sinh: requested_data = xe nhân viên ĐANG SOẠN (không chứa giá vốn của
// xe đối chiếu).
const reviewRow = (mode = "ACQUIRE") => ({
  id: approvalId,
  kind: "VEHICLE_DUPLICATE_REVIEW",
  subject_id: candidateId,
  status: "PENDING",
  reason:
    "Nghi trùng lúc thu xe: biển 59N1-555.55 và 5 ký tự cuối số khung khớp xe XE-DUP-0001 đang chờ bán.",
  requested_by: staffId,
  requester_name: "Nhân viên Kiểm Thử",
  created_at: new Date().toISOString(),
  payload: {
    mode,
    candidate_ids: [candidateId],
    license_plate: "59N1-555.55",
    frame_number: "RLHJDUPCAND989",
    staff_note: "Khách mang xe tới thu, xin xác minh giúp.",
    requested_data: {
      vehicle_type: "Xe số",
      license_plate: "59N1-555.55",
      frame_number: "RLHJDUPCAND989",
      year: 2024,
      color: "Trắng",
      seller_name: "Người bán Z",
      purchase_price: 30000000,
    },
  },
});

async function installMock(
  page,
  { role = "STAFF", dup = DUP.GREEN, reviews = [] } = {},
) {
  const userId =
    role === "OWNER" ? ownerId : role === "MANAGER" ? managerId : staffId;
  const calls = { check: [], acquire: [], save: [], request: [], resolve: [] };
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
      JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")}.mock`,
    refresh_token: "mock-refresh",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${role.toLowerCase()}@example.test`,
      created_at: new Date().toISOString(),
      app_metadata: {},
      user_metadata: {},
    },
  };
  await page.addInitScript(
    (value) => localStorage.setItem("sb-xe-test-auth-token", JSON.stringify(value)),
    session,
  );
  await page.route("https://xe-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = () => JSON.parse(request.postData() || "{}");
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
        id: userId,
        full_name:
          role === "OWNER"
            ? "Chủ kiểm thử"
            : role === "MANAGER"
              ? "Quản lý kiểm thử"
              : "Nhân viên kiểm thử",
        role,
        active: true,
        can_view_financials: role === "OWNER",
        must_change_password: false,
      });
    const name = url.pathname.split("/").at(-1);
    if (name === "check_user_access") return reply({ allowed: true, role });
    if (name === "list_active_announcements") return reply([]);
    if (name === "list_notifications")
      return reply({ items: [], unread_count: 0 });
    if (name === "get_settings")
      return reply({ store_name: "Cửa hàng kiểm thử" });
    if (name === "check_vehicle_duplicates") {
      calls.check.push(body());
      return reply(dup);
    }
    if (name === "list_vehicles")
      return reply({ items: [candidateVehicle], total: 1 });
    if (name === "get_vehicle")
      return reply(body().p_id === candidateId ? candidateVehicle : savedVehicle);
    if (name === "acquire_vehicle") {
      calls.acquire.push(body());
      return reply(newVehicleId);
    }
    if (name === "save_vehicle") {
      calls.save.push(body());
      return reply(newVehicleId);
    }
    if (name === "request_vehicle_duplicate_review") {
      calls.request.push(body());
      return reply(approvalId);
    }
    if (name === "resolve_vehicle_duplicate_review") {
      calls.resolve.push(body());
      return reply({
        approval_id: approvalId,
        action: body().p_action,
        vehicle_id: body().p_action === "APPROVE" ? newVehicleId : null,
      });
    }
    if (name === "list_vehicle_duplicate_reviews")
      return reply({ items: reviews, total: reviews.length });
    return reply({});
  });
  return calls;
}

async function fillAcquisition(page) {
  await page.getByLabel("Số khung", { exact: true }).fill("RLHJDUPCAND989");
  await page.getByLabel("Biển số (nếu có)", { exact: true }).fill("59N1-555.55");
  await page.getByLabel("Loại xe *", { exact: true }).fill("Xe số");
  await page.getByLabel("Giá thu (₫) *", { exact: true }).fill("30000000");
}

const submitButton = (page) => page.locator("form button[type=submit]");

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 960 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test(`[${label}] STAFF nghi trùng PLATE_AND_LAST5: gửi yêu cầu, KHÔNG tạo xe`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const calls = await installMock(page, { role: "STAFF", dup: DUP.PLATE });
    await page.goto("/acquisitions/new");
    await expect(
      page.getByRole("heading", { name: "Thu xe mới", exact: true }),
    ).toBeVisible();
    await fillAcquisition(page);

    await expect(
      page.getByText(/Nghi trùng — cần Chủ\/Quản lý xác minh/),
    ).toBeVisible();
    const submit = submitButton(page);
    await expect(submit).toHaveText(/Gửi yêu cầu xác minh/);
    await expect(submit).toBeEnabled();
    await submit.click();

    const dialog = page.getByRole("dialog", {
      name: "Gửi yêu cầu xác minh xe nghi trùng",
    });
    await expect(dialog).toBeVisible();
    // Hiện rõ hồ sơ đang nghi trùng để nhân viên mở đối chiếu trước khi gửi.
    await expect(dialog.getByText("XE-DUP-0001")).toBeVisible();
    await expect(
      dialog.getByRole("link", { name: "Mở hồ sơ" }),
    ).toHaveAttribute("href", `/vehicles/${candidateId}`);
    await dialog.getByRole("button", { name: "Gửi yêu cầu xác minh", exact: true }).click();

    await expect.poll(() => calls.request.length).toBe(1);
    expect(calls.request[0]).toMatchObject({ p_data: { _op: "ACQUIRE" } });
    expect(uuid.test(calls.request[0].p_data.request_id)).toBe(true);
    // Không bao giờ tạo xe trước khi được duyệt.
    expect(calls.acquire).toHaveLength(0);
    expect(calls.save).toHaveLength(0);
    await expect(page).toHaveURL(/\/acquisitions$/);
  });

  test(`[${label}] STAFF FULL_FRAME_MATCH: chặn tuyệt đối, không lưu cũng không gửi yêu cầu`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const calls = await installMock(page, { role: "STAFF", dup: DUP.FULL });
    await page.goto("/acquisitions/new");
    await fillAcquisition(page);
    await expect(
      page.getByText(/Trùng số khung đầy đủ — không lưu được/),
    ).toBeVisible();
    const submit = submitButton(page);
    await expect(submit).toHaveText(/Trùng số khung — không lưu được/);
    await expect(submit).toBeDisabled();
    // FULL_FRAME_MATCH không có đường gửi yêu cầu xác minh.
    expect(calls.request).toHaveLength(0);
    expect(calls.acquire).toHaveLength(0);
  });

  test(`[${label}] OWNER nghi trùng PLATE_AND_LAST5: lưu ngoại lệ bắt buộc lý do + hồ sơ đối chiếu`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const calls = await installMock(page, { role: "OWNER", dup: DUP.PLATE });
    await page.goto("/acquisitions/new");
    await fillAcquisition(page);
    await expect(
      page.getByText(/Nghi trùng — Chủ\/Quản lý có thể lưu ngoại lệ/),
    ).toBeVisible();
    const submit = submitButton(page);
    await expect(submit).toHaveText(/Thu xe & tạo phiếu/);
    await submit.click();

    const dialog = page.getByRole("dialog", {
      name: "Lưu ngoại lệ hồ sơ nghi trùng",
    });
    await expect(dialog).toBeVisible();
    const saveBtn = dialog.getByRole("button", { name: "Lưu ngoại lệ", exact: true });
    // Chưa chọn hồ sơ + chưa có lý do → chưa lưu được.
    await expect(saveBtn).toBeDisabled();
    await dialog.getByLabel("Lý do ngoại lệ *", { exact: true }).fill("abc");
    await expect(dialog.getByText("Ít nhất 5 ký tự.")).toBeVisible();
    await expect(saveBtn).toBeDisabled();

    await dialog
      .locator('input[type=radio][name="dup-reviewed-candidate"]')
      .first()
      .check();
    await dialog
      .getByLabel("Lý do ngoại lệ *", { exact: true })
      .fill("Đã mở hồ sơ XE-DUP-0001, xác nhận đây là xe khác thật (biển mới đổi).");
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await expect.poll(() => calls.acquire.length).toBe(1);
    expect(calls.acquire[0].p_data).toMatchObject({
      duplicate_override: true,
      duplicate_reviewed_vehicle_id: candidateId,
      duplicate_ack: true,
    });
    expect(calls.acquire[0].p_data.duplicate_override_reason).toContain("xe khác thật");
    // Lưu thẳng, không vòng qua hàng đợi.
    expect(calls.request).toHaveLength(0);
    await expect(page).toHaveURL(new RegExp(`/vehicles/${newVehicleId}$`));
  });

  test(`[${label}] Mất mạng: chặn trước RPC, giữ request_id gửi lại idempotent`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const calls = await installMock(page, { role: "STAFF", dup: DUP.PLATE });
    await page.goto("/acquisitions/new");
    await fillAcquisition(page);
    await expect(
      page.getByText(/Nghi trùng — cần Chủ\/Quản lý xác minh/),
    ).toBeVisible();
    await submitButton(page).click();
    const dialog = page.getByRole("dialog", {
      name: "Gửi yêu cầu xác minh xe nghi trùng",
    });
    await expect(dialog).toBeVisible();

    await page.context().setOffline(true);
    await dialog
      .getByRole("button", { name: "Gửi yêu cầu xác minh", exact: true })
      .click();
    // Client báo mất kết nối TRƯỚC khi gọi RPC; xe tuyệt đối không được ghi.
    await expect(dialog.getByText(/mất kết nối/i)).toBeVisible();
    expect(calls.request).toHaveLength(0);
    expect(calls.acquire).toHaveLength(0);

    await page.context().setOffline(false);
    // Chờ React ghi nhận đã lên mạng (banner mất kết nối rút đi) để bố cục ổn
    // định trước khi bấm lại — tránh actionability flake ngay sau khi resume.
    await expect(page.locator(".offline-banner")).toHaveCount(0);
    const retry = dialog.getByRole("button", { name: "Gửi yêu cầu xác minh", exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => calls.request.length).toBe(1);
    expect(uuid.test(calls.request[0].p_data.request_id)).toBe(true);
    await expect(page).toHaveURL(/\/acquisitions$/);
  });
}

test("MANAGER duyệt APPROVE trong hàng đợi /duplicate-reviews, không lộ giá vốn riêng tư", async ({
  page,
}) => {
  const calls = await installMock(page, { role: "MANAGER", reviews: [reviewRow()] });
  await page.goto("/duplicate-reviews");
  await expect(
    page.getByRole("heading", { name: "Xác minh xe nghi trùng" }),
  ).toBeVisible();

  const card = page.locator(".card").first();
  // Hiện rõ người gửi + hồ sơ đang nghi trùng.
  await expect(card.getByText("Nhân viên Kiểm Thử")).toBeVisible();
  await expect(card.getByText("59N1-555.55", { exact: true })).toBeVisible();
  await expect(card.getByText("RLHJDUPCAND989", { exact: true })).toBeVisible();
  await expect(card.getByText("Người bán Z")).toBeVisible();
  await expect(
    card.getByRole("link", { name: /Mở hồ sơ nghi trùng/ }),
  ).toHaveAttribute("href", `/vehicles/${candidateId}`);
  // Tài chính riêng tư: giá vốn của xe đối chiếu không xuất hiện.
  await expect(page.getByText(/41\.414\.141/)).toHaveCount(0);

  const approve = card.getByRole("button", { name: /Phê duyệt & lưu ngoại lệ/ });
  await expect(approve).toBeDisabled();
  await card.locator("textarea").fill("Đã đối chiếu trực tiếp, là hai xe khác nhau.");
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect.poll(() => calls.resolve.length).toBe(1);
  expect(calls.resolve[0]).toMatchObject({
    p_approval_id: approvalId,
    p_action: "APPROVE",
  });
  expect(uuid.test(calls.resolve[0].p_request_id)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/vehicles/${newVehicleId}$`));
});

test("OWNER từ chối REJECT: không tạo xe, giữ nguyên hồ sơ", async ({ page }) => {
  const calls = await installMock(page, { role: "OWNER", reviews: [reviewRow()] });
  await page.goto("/duplicate-reviews");
  const card = page.locator(".card").first();
  await card.getByRole("button", { name: /Từ chối/ }).click();
  await expect.poll(() => calls.resolve.length).toBe(1);
  expect(calls.resolve[0]).toMatchObject({
    p_approval_id: approvalId,
    p_action: "REJECT",
  });
  // REJECT không bắt buộc lý do → p_reason = null.
  expect(calls.resolve[0].p_reason).toBeNull();
  // Không có xe nào được tạo.
  expect(calls.acquire).toHaveLength(0);
  expect(calls.save).toHaveLength(0);
  await expect(page).toHaveURL(/\/duplicate-reviews$/);
});
