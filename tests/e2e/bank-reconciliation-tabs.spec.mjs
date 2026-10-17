import { test, expect } from "@playwright/test";
import { installUiuxMock } from "../helpers/uiux-fixtures.mjs";

const backend = "https://xe-test.supabase.co/rest/v1/";

const txn = (over = {}) => ({
  id: "00000000-0000-4000-8000-0000000000aa",
  provider: "SEPAY",
  provider_txn_id: "SP-E2E-1",
  amount: 30000000,
  transfer_at: new Date().toISOString(),
  reference: "CAREM GD01001",
  transfer_content: "CAREM GD01001",
  sender_name: "KHACH KIEM THU",
  sender_bank: "MB",
  status: "MATCHED_PENDING",
  match_reason: "REFERENCE_AMOUNT_MATCH",
  qr_request_id: null,
  sale_id: null,
  vehicle_id: null,
  sale_code: null,
  vehicle_label: null,
  payment_id: null,
  confirmed_by: null,
  confirmed_at: null,
  received_at: new Date().toISOString(),
  ...over,
});

test("đối soát mở sẵn hàng đợi gộp 'Cần bạn xử lý' và chuyển nhóm Lịch sử", async ({ page }) => {
  await installUiuxMock(page);
  const seen = [];
  await page.route(`${backend}rpc/list_bank_transactions`, (route) => {
    const status = (route.request().postDataJSON()?.p_filters ?? {}).status ?? "all";
    seen.push(status);
    const items = status === "ATTENTION" ? [txn()] : [];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        total: items.length,
        pending_count: status === "ATTENTION" ? 1 : 0,
      }),
    });
  });

  await page.goto("/bank-reconciliation");
  // Sidebar badge cũng gọi list_bank_transactions (status UNMATCHED) — chỉ cần
  // hàng đợi trang mở đúng bộ lọc gộp ATTENTION, không so thứ tự tuyệt đối.
  await expect.poll(() => seen.includes("ATTENTION")).toBe(true);
  await expect(page.getByRole("button", { name: "Cần bạn xử lý", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Chờ xác nhận", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Xác nhận thu tiền" })).toBeVisible();

  await page.getByRole("button", { name: "Lịch sử", exact: true }).click();
  await expect.poll(() => seen.includes("HISTORY")).toBe(true);
  await expect(page.getByText("Chưa có giao dịch đã ngã ngũ")).toBeVisible();

  await page.getByRole("button", { name: "Tất cả", exact: true }).click();
  await expect.poll(() => seen.includes("all")).toBe(true);
});
