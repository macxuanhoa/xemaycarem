import { test, expect } from "@playwright/test";
import { installUiuxMock } from "../helpers/uiux-fixtures.mjs";

const healthUrl = "https://xe-test.supabase.co/auth/v1/health";
const banner = (page) =>
  page.getByRole("region", { name: "Trạng thái kết nối" });
const recovered = (page) => page.locator(".network-banner--recovered");

async function setup(page, { theme = "light", health = () => 200 } = {}) {
  const calls = await installUiuxMock(page, { theme });
  await page.route(healthUrl, async (route) =>
    route.fulfill({
      status: await health(),
      contentType: "application/json",
      body: "{}",
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
      },
    }),
  );
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Hồ sơ của bạn" }),
  ).toBeVisible();
  return calls;
}

test("sudden offline keeps input, rejects writes and recovers without replaying them", async ({
  page,
  context,
}) => {
  const calls = await setup(page);
  const name = page.getByLabel("Họ và tên");
  await name.fill("Thông tin chưa gửi");
  await expect(recovered(page)).toHaveCount(0);

  await context.setOffline(true);
  await expect(banner(page)).toContainText("Mất kết nối mạng");
  await expect(banner(page)).toContainText("Giữ trang mở");
  await expect(banner(page)).not.toContainText("tự động lưu nháp");
  await banner(page).getByRole("button", { name: "Thử kết nối lại" }).click();
  await expect(banner(page)).toContainText("Chưa thể kết nối");
  await page
    .getByRole("button", { name: "Lưu thông tin", exact: true })
    .click();
  await expect(
    page.locator("form").filter({ has: name }).getByRole("alert"),
  ).toBeVisible();
  await expect(name).toHaveValue("Thông tin chưa gửi");
  expect(calls.writes).toHaveLength(0);

  await context.setOffline(false);
  await expect(recovered(page)).toContainText("Đã kết nối lại");
  await expect(recovered(page)).toContainText(
    "Kiểm tra giao dịch chưa rõ kết quả",
  );
  await expect(name).toHaveValue("Thông tin chưa gửi");
  await expect(recovered(page)).toHaveCount(0, { timeout: 9000 });
  expect(calls.writes).toHaveLength(0);

  // A later outage gets its own success message; the prior timer cannot hide it.
  await context.setOffline(true);
  await expect(banner(page)).toContainText("Mất kết nối mạng");
  await context.setOffline(false);
  await expect(recovered(page)).toContainText("Đã kết nối lại");
  await expect(name).toHaveValue("Thông tin chưa gửi");
  expect(calls.writes).toHaveLength(0);
});

test("backend outage stays visible until a successful explicit check", async ({
  page,
  context,
}) => {
  let healthStatus = 200;
  let releaseProbe;
  let probeGate;
  const calls = await setup(page, {
    health: async () => {
      if (probeGate) await probeGate;
      return healthStatus;
    },
  });

  healthStatus = 503;
  await context.setOffline(true);
  await expect(banner(page)).toContainText("Mất kết nối mạng");
  await context.setOffline(false);
  await expect(banner(page)).toContainText("Máy chủ tạm thời không khả dụng");
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  probeGate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  try {
    await banner(page).getByRole("button", { name: "Thử kết nối lại" }).click();
    await expect(
      banner(page).getByRole("button", { name: "Đang kiểm tra kết nối" }),
    ).toBeDisabled();
  } finally {
    releaseProbe();
    probeGate = undefined;
  }
  await expect(banner(page)).toContainText("Chưa thể kết nối");
  await expect(recovered(page)).toHaveCount(0);

  healthStatus = 200;
  await banner(page).getByRole("button", { name: "Thử kết nối lại" }).click();
  await expect(recovered(page)).toContainText("Đã kết nối lại");
  await expect(banner(page)).toHaveCount(0);
  expect(calls.writes).toHaveLength(0);
});

test("mobile dark banner has readable controls and honors reduced motion", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page, { theme: "dark" });
  await context.setOffline(true);
  await expect(banner(page)).toBeVisible();
  const retry = banner(page).getByRole("button", { name: "Thử kết nối lại" });
  const bounds = await retry.boundingBox();
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await banner(page).evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).toBe("none");
  await retry.focus();
  await expect(retry).toBeFocused();
  expect(
    await retry.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("solid");
  await expect(banner(page).locator('[aria-live="polite"]')).not.toContainText(
    "Đã gián đoạn",
  );
  await page.screenshot({
    path: test.info().outputPath("network-banner-mobile.png"),
  });
});
