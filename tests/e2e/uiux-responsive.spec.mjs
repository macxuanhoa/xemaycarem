import { test, expect } from "@playwright/test";
import {
  installUiuxMock,
  vehicleId,
  evidence,
} from "../helpers/uiux-fixtures.mjs";

for (const width of [320, 360, 375, 390, 430]) {
  test(`UI audit core pages stay within ${width}px and navigation matches workflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { writes } = await installUiuxMock(page, { long: true });
    for (const [path, active] of [
      ["/copilot", null],
      ["/intake", "Thu xe"],
      ["/acquisitions", "Thu xe"],
      [`/vehicles/${vehicleId}`, "Tồn kho"],
      [`/vehicles/${vehicleId}/sell`, "Bán ra"],
    ]) {
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        width: document.documentElement.scrollWidth,
      }));
      expect(geometry.width, path).toBeLessThanOrEqual(geometry.viewport);
      const selected = page.locator(
        '.bottom-nav a[aria-current]:not([aria-current="false"])',
      );
      if (active) await expect(selected).toHaveText(active);
      else await expect(selected).toHaveCount(0);
    }
    expect(writes).toHaveLength(0);
  });
  test(`Mobile search handles focus, close and shortened viewport at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { writes } = await installUiuxMock(page);
    await page.goto("/vehicles");
    const trigger = page.getByRole("button", {
      name: "Tìm xe toàn hệ thống",
      exact: true,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /Tìm/ });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("searchbox");
    await expect(input).toBeFocused();
    expect(await input.getAttribute("placeholder")).not.toMatch(/Ctrl|⌘/);
    expect(
      await input.evaluate((x) => parseFloat(getComputedStyle(x).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await input.fill("Vision");
    await expect(
      dialog.getByRole("button", { name: /Honda Vision/ }).first(),
    ).toBeVisible();
    await page.setViewportSize({ width, height: 450 });
    await expect
      .poll(() => dialog.evaluate((x) => x.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(450);
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(writes).toHaveLength(0);
  });
}

test("Malformed money stays invalid and cannot become a different amount", async ({
  page,
}) => {
  const { writes } = await installUiuxMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  const input = page.getByLabel("Giá bán thực tế (₫) *", { exact: true });
  for (const raw of [
    "-82.000.000",
    "82000000.5",
    "1e6",
    "1000000000001",
    "12..000",
  ]) {
    await input.fill(raw);
    await input.blur();
    await expect(input).toHaveValue(raw);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(/Nhập số tiền nguyên đồng/);
    const duplicateIds = await page.evaluate(() => {
      const seen = new Set(),
        duplicates = [];
      for (const node of document.querySelectorAll("[id]")) {
        if (seen.has(node.id)) duplicates.push(node.id);
        seen.add(node.id);
      }
      return duplicates;
    });
    expect(duplicateIds).toEqual([]);
    expect(await input.evaluate((x) => x.checkValidity())).toBe(false);
    await page
      .getByLabel("Tên khách hàng *", { exact: true })
      .fill("Khách kiểm thử");
    await page
      .getByRole("button", { name: "Xác nhận bán xe", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(writes).toHaveLength(0);
  }
  for (const [raw, value] of [
    ["82tr", "82.000.000"],
    ["1.2ty", "1.200.000.000"],
    ["1,000,000", "1.000.000"],
  ]) {
    await input.fill(raw);
    await input.blur();
    await expect(input).toHaveValue(value);
    await expect(input).toHaveAttribute("aria-invalid", "false");
  }
});

test("Sale review uses intended values and cancellation preserves form without write", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await installUiuxMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page
    .getByLabel("Tên khách hàng *", { exact: true })
    .fill("Nguyễn Văn Kiểm Thử");
  await page.getByLabel("Số điện thoại", { exact: true }).fill("0900000000");
  await page.getByLabel("Giá bán thực tế (₫) *", { exact: true }).fill("35tr");
  await page.getByLabel("Thu tiền lần đầu (₫)", { exact: true }).fill("10tr");
  await page
    .getByLabel("Hình thức thanh toán", { exact: true })
    .selectOption("BANK_TRANSFER");
  await page
    .getByRole("button", { name: "Xác nhận bán xe", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Nguyễn Văn Kiểm Thử", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Chuyển khoản", { exact: true })).toBeVisible();
  await expect(dialog.getByText("25.000.000 ₫", { exact: true })).toBeVisible();
  expect(await dialog.getAttribute("aria-describedby")).toBeTruthy();
  expect(writes).toHaveLength(0);
  await dialog
    .getByRole("button", { name: /Hủy|Kiểm tra|Quay lại|Sửa/ })
    .first()
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByLabel("Tên khách hàng *", { exact: true }),
  ).toHaveValue("Nguyễn Văn Kiểm Thử");
  await expect(
    page.getByLabel("Thu tiền lần đầu (₫)", { exact: true }),
  ).toHaveValue("10.000.000");
  expect(writes).toHaveLength(0);
});

test("Full-payment control is accessible and overpayment is not presented as zero debt", async ({
  page,
}) => {
  await installUiuxMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel("Thu tiền lần đầu (₫)", { exact: true }).fill("40tr");
  await expect(page.locator(".sale-payment-summary")).toHaveAttribute(
    "data-state",
    "invalid",
  );
  const full = page.getByRole("button", {
    name: "Đã thu đủ tiền",
    exact: true,
  });
  await expect(full).toBeVisible();
  await full.click();
  await expect(
    page.getByLabel("Thu tiền lần đầu (₫)", { exact: true }),
  ).toHaveValue("35.000.000");
  await expect(page.locator(".sale-payment-summary")).toHaveAttribute(
    "data-state",
    "valid",
  );
});

test("Intake retains shorthand parsing, invalid raw money and edited rows on cancelled reparse", async ({
  page,
}) => {
  const { writes } = await installUiuxMock(page);
  await page.goto("/intake");
  await page
    .getByLabel("Ghi chú tốc ký danh sách xe cần thu")
    .fill("sh den 29b1 123.45 21 gia 18tr5");
  await page
    .getByRole("button", { name: "Tách thành danh sách", exact: true })
    .click();
  const money = page
    .locator(".intake-entry")
    .getByLabel("Giá thu", { exact: true });
  await expect(money).toHaveValue("18.500.000");
  await money.fill("1.5");
  await money.blur();
  await expect(money).toHaveValue("1.5");
  await expect(money).toHaveAttribute("aria-invalid", "true");
  await money.fill("20tr");
  await money.blur();
  await page
    .getByRole("button", { name: "Tách thành danh sách", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: "Tách lại danh sách xe?",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Giữ danh sách hiện tại" }).click();
  await expect(money).toHaveValue("20.000.000");
  expect(writes).toHaveLength(0);
});

test("Single-page intake has no pagination controls and first-blur plate validation works", async ({
  page,
}) => {
  await installUiuxMock(page);
  await page.goto("/acquisitions");
  await expect(page.locator(".pagination")).toHaveCount(0);
  await page.goto("/acquisitions/new");
  const plate = page.getByLabel("Biển số (nếu có)", { exact: true });
  await plate.fill("NOT_A_PLATE");
  await plate.blur();
  await expect(page.getByText(/Biển số không đúng định dạng/)).toBeVisible();
  await expect(plate).toHaveAttribute("aria-invalid", "true");
});

test("Copilot sources have readable names, current-stock scope and provider fallback", async ({
  page,
}) => {
  const { writes } = await installUiuxMock(page, {
    ai: {
      ...evidence,
      available: false,
      warnings: ["AI đang tạm nghỉ. Cà Rem vẫn tra cứu trực tiếp."],
    },
  });
  await page.goto("/copilot");
  await page
    .getByLabel("Bạn muốn hỏi gì về cửa hàng?")
    .fill("Tồn kho tháng 9?");
  await page.getByRole("button", { name: "Hỏi Cà Rem", exact: true }).click();
  await expect(page.getByText(/Tồn kho là số xe hiện tại/)).toBeVisible();
  await expect(page.getByText(/AI đang tạm nghỉ/)).toBeVisible();
  await expect(page.locator(".copilot-evidence")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(
    page
      .getByRole("link", {
        name: "Mở nguồn Số liệu: Xe đang tồn kho",
        exact: true,
      })
      .first(),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});

test("Dark long-detail labels preserve contrast and empty vehicle has a recoverable state", async ({
  page,
}) => {
  await installUiuxMock(page, { theme: "dark", long: true });
  await page.goto(`/vehicles/${vehicleId}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".details-list dt").first()).toBeVisible();
  const labels = await page.locator(".details-list dt").evaluateAll((nodes) => {
    const rgba = (color) => color.match(/[\d.]+/g).map(Number);
    const luminance = (color) =>
      color
        .slice(0, 3)
        .map((x) => x / 255)
        .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
        .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
    return nodes.map((node) => {
      const ancestors = [];
      for (let x = node; x; x = x.parentElement) ancestors.unshift(x);
      const background = ancestors.reduce(
        (base, x) => {
          const color = rgba(getComputedStyle(x).backgroundColor),
            alpha = color[3] ?? 1;
          return base.map((v, i) => color[i] * alpha + v * (1 - alpha));
        },
        [255, 255, 255],
      );
      const a = luminance(rgba(getComputedStyle(node).color)),
        b = luminance(background);
      return {
        text: node.textContent,
        contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
  });
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels)
    expect(label.contrast, label.text).toBeGreaterThanOrEqual(4.5);
  const state = await page.context().newPage();
  await installUiuxMock(state, { empty: true });
  await state.goto(`/vehicles/${vehicleId}`);
  await expect(
    state.getByText("Không tìm thấy xe", { exact: true }),
  ).toBeVisible();
  await state.close();
});
