import { expect, test } from "@playwright/test";

/**
 * The privacy policy must be readable by anyone, including a customer who has
 * never logged in and an external reviewer following the URL from an app
 * consent screen. The app's catch-all route redirects unknown paths to "/"
 * (the staff login), so these checks pin down the two things that make this
 * page public: it is registered, and it renders with no session and no backend.
 *
 * playwright.config.ts points VITE_SUPABASE_URL at a non-existent host, so a
 * passing run also proves the page performs no data fetching at all.
 */

const LOGIN_MARKERS = [
  "Đăng nhập",
  "Mật khẩu",
  "Tên đăng nhập",
];

test("privacy policy opens without a session and is not redirected to login", async ({
  page,
}) => {
  await page.goto("/privacy-policy");

  // A redirect to the protected shell would land on /login.
  await expect.poll(() => new URL(page.url()).pathname).toBe("/privacy-policy");

  await expect(
    page.getByRole("heading", { level: 1, name: "Chính sách quyền riêng tư" }),
  ).toBeVisible();

  for (const marker of LOGIN_MARKERS) {
    await expect(page.getByRole("button", { name: marker })).toHaveCount(0);
  }
});

test("privacy policy sets its own document title and covers the real data flows", async ({
  page,
}) => {
  await page.goto("/privacy-policy");

  await expect(page).toHaveTitle(/Chính sách quyền riêng tư/);

  // Named after what the system actually does, verified in this codebase:
  // role-gated financial fields, bank webhooks, on-device OCR, and audit
  // history that cannot be hard-deleted once a sale exists.
  for (const heading of [
    "2. Thông tin chúng tôi ghi nhận",
    "4. Ai được xem dữ liệu trong nội bộ cửa hàng",
    "5. Đơn vị xử lý dữ liệu thay mặt chúng tôi",
    "7. Thời gian lưu trữ",
    "12. Liên hệ",
  ]) {
    await expect(
      page.getByRole("heading", { level: 2, name: heading }),
    ).toBeVisible();
  }

  await expect(page.getByText("0914.92.92.92")).toBeVisible();
});

test("privacy policy is plain reading: no forms, no buttons, no data writes", async ({
  page,
}) => {
  const writes = [];
  // Every business call this app makes is a POST to /rest/v1/rpc/, so an empty
  // list proves the page neither writes nor reads the store.
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });

  await page.goto("/privacy-policy");
  await expect(
    page.getByRole("heading", { level: 1, name: "Chính sách quyền riêng tư" }),
  ).toBeVisible();

  await expect(page.getByRole("form")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(0);
  expect(writes).toEqual([]);
});
