import { test, expect } from "@playwright/test";
import { installUiuxMock, saleId } from "../helpers/uiux-fixtures.mjs";

const backend = "https://xe-test.supabase.co/rest/v1/";

async function setup(page) {
  const calls = await installUiuxMock(page);
  await page.route(`${backend}rpc/list_payment_receipts`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.route(`${backend}rpc/get_active_vietqr_request`, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  }));
  return calls;
}

test("a failed background sale refresh keeps unsent payment fields mounted", async ({ page }) => {
  await page.clock.install();
  const calls = await setup(page);
  let failRefresh = false;
  let failedReads = 0;
  await page.route(`${backend}rpc/get_sale`, (route) => {
    if (!failRefresh) return route.fallback();
    failedReads += 1;
    return route.abort("failed");
  });
  await page.goto(`/sales/${saleId}`);
  await page.locator(".card").filter({
    has: page.getByRole("heading", { name: "Lịch sử thanh toán", exact: true }),
  }).getByRole("button", { name: "Thu tiền", exact: true }).click();
  const reference = page.getByLabel("Mã tham chiếu", { exact: true });
  await reference.fill("Chứng từ đang nhập chưa gửi");
  await page.getByLabel("Số tiền (₫) *", { exact: true }).fill("1000000");
  await page.clock.fastForward(31_000);
  failRefresh = true;
  // Focus-manager event triggers the stale read without submitting the editor.
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  await expect(page.locator(".network-banner--offline")).toBeVisible();
  await expect(reference).toHaveValue("Chứng từ đang nhập chưa gửi");
  await expect(page.getByLabel("Số tiền (₫) *", { exact: true })).toHaveValue("1.000.000");
  expect(calls.writes).toHaveLength(0);
});

test("failed QR creation waits for an explicit retry after connection recovery", async ({ page }) => {
  await setup(page);
  await page.route(`${backend}rpc/get_settings`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      store_name: "Cửa hàng kiểm thử",
      vietqr_enabled: true,
      bank_bin: "970436",
      bank_account_no: "0000000000",
      bank_account_name: "CA REM TEST",
    }),
  }));
  let createCalls = 0;
  await page.route(`${backend}rpc/create_vietqr_payment_request`, (route) => {
    createCalls += 1;
    return route.abort("failed");
  });
  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Tạo mã VietQR", exact: true }).click();
  const retry = page.getByRole("button", { name: "Thử tạo lại mã QR", exact: true });
  await expect(retry).toBeVisible();
  await expect(page.locator(".network-banner--recovered")).toBeVisible();
  expect(createCalls).toBe(1);
  await retry.click();
  await expect.poll(() => createCalls).toBe(2);
  await expect(retry).toBeVisible();
});
