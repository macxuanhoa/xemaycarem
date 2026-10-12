import { test, expect } from "@playwright/test";
import {
  installUiuxMock,
  saleId,
  vehicleId,
  vehicleTitle,
} from "../helpers/uiux-fixtures.mjs";

const backend = "https://xe-test.supabase.co/rest/v1/rpc/";

async function installQrMock(
  page,
  { theme = "light", monitoring = true } = {},
) {
  await page.clock.install();
  const calls = await installUiuxMock(page, { theme });
  const anchor = await page.evaluate(() => ({
    date: Date.now(),
    monotonic: performance.now(),
  }));
  const serverMs = async () =>
    anchor.date +
    (await page.evaluate(() => performance.now())) -
    anchor.monotonic;
  const reply = (route, data, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  let current = null;
  let bankState = "NONE";
  let createCount = 0;
  let replaceCount = 0;
  const manualWrites = [];
  const withServerTime = async () => {
    if (!current) return null;
    const now = await serverMs();
    if (current.status === "PENDING" && Date.parse(current.expires_at) <= now)
      current.status = "EXPIRED";
    return { ...current, server_now: new Date(now).toISOString() };
  };
  const makeRequest = async (data) => {
    const now = await serverMs();
    const reference = `CRTEST00000${createCount + replaceCount}`;
    current = {
      id: `00000000-0000-4000-8000-00000000010${createCount + replaceCount}`,
      qr_reference: reference,
      vehicle_id: vehicleId,
      sale_id: data.sale_id ?? null,
      amount: data.amount,
      bank_bin: "970436",
      bank_name: "Vietcombank",
      bank_account_no: "0000000000",
      bank_account_name: "CA REM TEST",
      qr_payload: "",
      expires_at: new Date(now + 15 * 60_000).toISOString(),
      replace_available_at: new Date(now + 60_000).toISOString(),
      server_now: new Date(now).toISOString(),
      monitoring_available: monitoring,
      transfer_content: `${reference} XE-UI-001 BAN-UI-001 KHACH CA REM`,
      agreement_text: `${data.payer_name ?? "Khách kiểm thử"} đồng ý thanh toán cho CA REM TEST; xe Xe tay ga, biển 43A1-123.45, mã XE-UI-001, hợp đồng ${data.contract_reference ?? "BAN-UI-001"}.`,
      payer_name: data.payer_name ?? "Khách kiểm thử",
      contract_reference: data.contract_reference ?? "BAN-UI-001",
      vehicle_label: vehicleTitle,
      bank_transaction_id: null,
      receipt_id: null,
      status: "PENDING",
      payment_id: null,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
    return current;
  };
  await page.route(`${backend}get_settings`, (route) =>
    reply(route, {
      vietqr_enabled: true,
      bank_bin: "970436",
      bank_account_no: "0000000000",
      bank_account_name: "CA REM TEST",
    }),
  );
  await page.route(`${backend}list_payment_receipts`, (route) =>
    reply(route, []),
  );
  await page.route(`${backend}get_active_vietqr_request`, async (route) =>
    reply(route, await withServerTime()),
  );
  await page.route(`${backend}create_vietqr_payment_request`, async (route) => {
    createCount += 1;
    return reply(
      route,
      await makeRequest(route.request().postDataJSON().p_data),
    );
  });
  await page.route(
    `${backend}replace_vietqr_payment_request`,
    async (route) => {
      if (Date.parse(current.replace_available_at) > (await serverMs()))
        return reply(route, { message: "VIETQR_REPLACEMENT_COOLDOWN" }, 400);
      replaceCount += 1;
      return reply(
        route,
        await makeRequest(route.request().postDataJSON().p_data),
      );
    },
  );
  await page.route(`${backend}get_vietqr_payment_request`, async (route) =>
    reply(route, await withServerTime()),
  );
  await page.route(`${backend}get_vietqr_matching_status`, async (route) =>
    reply(route, {
      state: bankState,
      qr_status: current?.status,
      bank_received:
        !!current?.bank_transaction_id &&
        ["RECEIVED", "CONFIRMED"].includes(current?.status),
      monitoring_available: monitoring,
      bank_transaction_id: current?.bank_transaction_id,
    }),
  );
  for (const action of [
    "confirm_vietqr_payment",
    "cancel_vietqr_payment_request",
  ]) {
    await page.route(`${backend}${action}`, (route) => {
      manualWrites.push(action);
      return reply(
        route,
        { message: "No manual payment transitions allowed" },
        403,
      );
    });
  }
  return {
    calls,
    manualWrites,
    get current() {
      return current;
    },
    get createCount() {
      return createCount;
    },
    get replaceCount() {
      return replaceCount;
    },
    setBankState(state) {
      bankState = state;
    },
    receive(status = "RECEIVED") {
      current.status = status;
      current.bank_transaction_id = "00000000-0000-4000-8000-000000000201";
      current.receipt_id = "00000000-0000-4000-8000-000000000202";
      if (status === "CONFIRMED")
        current.payment_id = "00000000-0000-4000-8000-000000000203";
      bankState = status === "CONFIRMED" ? "RECORDED" : "RECEIVED";
    },
  };
}

async function openSaleQr(page) {
  await page.goto(`/sales/${saleId}`);
  await page
    .getByRole("button", { name: "VietQR", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Thanh toán chuyển khoản",
    exact: true,
  });
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  return dialog;
}

for (const surface of [
  { theme: "light", width: 1440 },
  { theme: "dark", width: 375 },
]) {
  test(`one payment action at the bottom and a centered plain QR (${surface.theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: surface.width, height: 960 });
    const fixture = await installQrMock(page, surface);
    await page.goto(`/vehicles/${vehicleId}/sell`);
    const launcher = page.getByRole("button", {
      name: "Thanh toán chuyển khoản",
      exact: true,
    });
    await expect(launcher).toHaveCount(1);
    await page.getByLabel(/^Tên khách hàng/).fill("Khách kiểm thử");
    await page.getByLabel("Bán với giá", { exact: true }).fill("35000000");
    const footerAfterNotes = await launcher.evaluate((element) => {
      const notes = document.querySelector('textarea[name="notes"]');
      return (
        !!notes &&
        !!(
          notes.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    });
    expect(footerAfterNotes).toBe(true);
    await launcher.click();
    const dialog = page.getByRole("dialog", {
      name: "Thanh toán chuyển khoản",
      exact: true,
    });
    const qr = dialog.getByRole("img", {
      name: "Mã QR chuyển khoản",
      exact: true,
    });
    await expect(qr).toBeVisible();
    await expect(dialog.getByText("Mã QR đơn", { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByText("Thẻ có logo ngân hàng", { exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /Xác nhận đã nhận tiền/ }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText(fixture.current.agreement_text, { exact: true }),
    ).toBeVisible();
    const qrBox = await qr.boundingBox();
    const download = await dialog
      .getByRole("button", { name: "Tải mã QR", exact: true })
      .boundingBox();
    expect(
      Math.abs(qrBox.x + qrBox.width / 2 - download.x - download.width / 2),
    ).toBeLessThan(2);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await dialog
      .getByRole("button", { name: "Đóng hộp thoại", exact: true })
      .focus();
    await page.keyboard.press("Shift+Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(fixture.manualWrites).toHaveLength(0);
  });
}

test("closing and reopening preserves the deadline; expiry hides QR and replacement has a cooldown", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  let dialog = await openSaleQr(page);
  const firstId = fixture.current.id;
  const firstExpiry = fixture.current.expires_at;
  await expect(
    dialog.getByRole("button", { name: /^Tạo mã mới \(/ }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
  await page.clock.fastForward(65_000);
  await page
    .getByRole("button", { name: "VietQR", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Thanh toán chuyển khoản",
    exact: true,
  });
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  expect(fixture.current.id).toBe(firstId);
  expect(fixture.current.expires_at).toBe(firstExpiry);
  expect(fixture.createCount).toBe(1);
  await expect(dialog.locator(".vietqr-countdown strong")).toHaveText(
    /^13:5\d$/,
  );
  await page.clock.fastForward(15 * 60_000);
  await expect(
    dialog.getByText("Mã QR đã hết hạn", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Tạo mã mới", exact: true }).click();
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  expect(fixture.current.id).not.toBe(firstId);
  expect(fixture.replaceCount).toBe(1);
  await expect(
    dialog.getByRole("button", { name: /^Tạo mã mới \(/ }),
  ).toBeDisabled();
  expect(fixture.manualWrites).toHaveLength(0);
});

test("a bank match or review is insufficient; trusted receipt enables acknowledgement only", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  const dialog = await openSaleQr(page);
  fixture.setBankState("MATCHED");
  await page.clock.fastForward(6_000);
  await expect(
    dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true }),
  ).toHaveCount(0);
  fixture.setBankState("REVIEW");
  await page.clock.fastForward(6_000);
  await expect(
    dialog.getByText("Giao dịch cần đối soát", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true }),
  ).toHaveCount(0);
  fixture.receive("CONFIRMED");
  await page.clock.fastForward(6_000);
  await expect(
    dialog.getByText("Đã nhận tiền vào tài khoản", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Xác nhận và đóng", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.manualWrites).toHaveLength(0);
});

test("a trusted pre-sale receipt returns to the form without another collection", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel(/^Tên khách hàng/).fill("Khách kiểm thử");
  await page.getByLabel("Bán với giá", { exact: true }).fill("35000000");
  await page
    .getByRole("button", { name: "Thanh toán chuyển khoản", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Thanh toán chuyển khoản",
    exact: true,
  });
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  const requestId = fixture.current.id;
  fixture.receive("RECEIVED");
  await page.clock.fastForward(6_000);
  await dialog
    .getByRole("button", { name: "Xác nhận và đóng", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Ngân hàng đã nhận 35\.000\.000/)).toBeVisible();
  await page
    .getByRole("button", { name: "Xem khoản chuyển đã nhận", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true }),
  ).toBeVisible();
  expect(fixture.current.id).toBe(requestId);
  expect(fixture.createCount).toBe(1);
  expect(fixture.manualWrites).toHaveLength(0);
});

test("offline does not enable payment success and does not pause expiry", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  const dialog = await openSaleQr(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(
    dialog.getByText("Tạm dừng kiểm tra kết nối", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /^Tạo mã mới/ }),
  ).toBeDisabled();
  await page.clock.fastForward(16 * 60_000);
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true }),
  ).toHaveCount(0);
  expect(fixture.createCount).toBe(1);
  expect(fixture.manualWrites).toHaveLength(0);
});

test("legacy manual confirmation never appears as bank-backed success", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  const dialog = await openSaleQr(page);
  fixture.current.status = "CONFIRMED";
  fixture.current.bank_transaction_id = null;
  await page.clock.fastForward(6_000);
  await expect(
    dialog.getByText("Đã nhận tiền vào tài khoản", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true }),
  ).toHaveCount(0);
  expect(fixture.manualWrites).toHaveLength(0);
});

test("unconfigured bank monitoring is visible and changing the workstation clock cannot extend QR lifetime", async ({
  page,
}) => {
  const fixture = await installQrMock(page, { monitoring: false });
  const dialog = await openSaleQr(page);
  await expect(
    dialog.getByText("Chưa kết nối thông báo ngân hàng", { exact: true }),
  ).toBeVisible();
  await page.clock.setSystemTime(new Date("2020-01-01T00:00:00Z"));
  await page.clock.fastForward(16 * 60_000);
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true }),
  ).toHaveCount(0);
  expect(fixture.manualWrites).toHaveLength(0);
});
