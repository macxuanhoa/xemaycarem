import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import QRCode from "qrcode";
import sharp from "sharp";
import {
  installUiuxMock,
  saleId,
  vehicleId,
  vehicleTitle,
} from "../helpers/uiux-fixtures.mjs";

const backend = "https://xe-test.supabase.co/rest/v1/rpc/";
const paymentVisualSurfaces = [
  { name: "desktop-light", theme: "light", width: 1440, height: 960 },
  { name: "mobile-dark", theme: "dark", width: 375, height: 667 },
  { name: "narrow-dark", theme: "dark", width: 320, height: 667 },
];

async function installQrMock(
  page,
  { theme = "light", monitoring = true, fixedClock = false } = {},
) {
  await page.clock.install();
  if (fixedClock) await page.clock.setFixedTime(new Date("2026-10-16T03:00:00Z"));
  const calls = await installUiuxMock(page, { theme });
  const anchor = await page.evaluate(() => ({
    date: Date.now(),
    monotonic: performance.now(),
  }));
  const serverMs = async () =>
    fixedClock ? anchor.date : anchor.date +
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
  // Ảnh VietQR chính thống (img.vietqr.io) được mock để mã hiển thị ổn định trong test.
  // Ghi lại URL đã xin ảnh để đối soát: ảnh ghép phải xuất phát từ đúng mã có addInfo
  // mà màn hình đang hiển thị.
  const qrImageRequests = [];
  await page.route("https://img.vietqr.io/**", async (route) => {
    const requestUrl = route.request().url();
    qrImageRequests.push(requestUrl);
    const png = await QRCode.toBuffer(requestUrl, {
      width: 480,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: png,
    });
  });
  const withServerTime = async () => {
    if (!current) return null;
    const now = await serverMs();
    if (current.status === "PENDING" && Date.parse(current.expires_at) <= now)
      current.status = "EXPIRED";
    return { ...current, server_now: new Date(now).toISOString() };
  };
  const makeRequest = async (data) => {
    const now = await serverMs();
    const reference = `CAREM GD${String(createCount + replaceCount).padStart(5, "0")}`;
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
      transfer_content: `${data.payer_name ?? "Khách kiểm thử"} thanh toán tiền xe Xe tay ga - XE-UI-001 với giá: ${String(
        Math.round(Number(data.amount) || 0),
      ).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}; Mã giao dịch là: ${reference}`,
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
      const data = route.request().postDataJSON().p_data;
      // Server bỏ 60 giây chờ khi thay mã vì ĐỔI THÔNG TIN (số tiền/tên người trả)
      // trên mã còn PENDING và chưa có bằng chứng ngân hàng. Thay mã CÙNG thông tin
      // (bấm spam) vẫn dính cooldown — giữ nguyên cam kết chống lạm phát mã.
      const detailChanged =
        !!current &&
        current.status === "PENDING" &&
        !current.bank_transaction_id &&
        (String(current.amount) !== String(data.amount) ||
          (!!data.payer_name && current.payer_name !== data.payer_name));
      if (
        !detailChanged &&
        Date.parse(current.replace_available_at) > (await serverMs())
      )
        return reply(route, { message: "VIETQR_REPLACEMENT_COOLDOWN" }, 400);
      replaceCount += 1;
      return reply(route, await makeRequest(data));
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
    get qrImageRequests() {
      return qrImageRequests;
    },
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
  await expect(dialog.locator(".vietqr-transfer-text")).toHaveText(
    /^CAREM GD\d{5} \(Xe tay ga\)$/,
  );
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
    // Giữ mock memo dài theo mẫu cũ để kiểm tra cả yêu cầu đã tồn tại: UI, ảnh
    // QR và Copy cùng chuyển về mã đối soát nguyên vẹn + tên xe trong ngoặc.
    const serverMemo = fixture.current.transfer_content;
    const reference = fixture.current.qr_reference;
    const byteLength = (value) => new TextEncoder().encode(value).length;
    const shown = (
      await dialog.locator(".vietqr-transfer-text").textContent()
    )?.trim();
    expect(serverMemo).toContain("thanh toán tiền xe");
    expect(shown).toBe(`${reference} (Xe tay ga)`);
    expect(byteLength(shown)).toBeLessThanOrEqual(95);
    // Ảnh ghép sinh ra từ đúng mã chính thống mang nội dung đang hiển thị.
    const requested = fixture.qrImageRequests.at(-1);
    expect(new URL(requested).pathname).toContain("-qr_only.png");
    expect(new URL(requested).searchParams.get("addInfo")).toBe(shown);
    // Số tiền + nội dung nằm TRONG ảnh: màn hình là ảnh ghép PNG, hàng chữ HTML
    // dưới mã không còn nữa nên không thể wrap tràn form.
    await expect(qr).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(dialog.locator(".vietqr-qr-cardfoot")).toHaveCount(0);
    // Nút copy phải đưa cả câu số tiền + nội dung, không phải một bản khác.
    await page.evaluate(() => {
      window.__copied = null;
      navigator.clipboard.writeText = (text) => {
        window.__copied = text;
        return Promise.resolve();
      };
    });
    await dialog
      .getByRole("button", { name: "Sao chép số tiền và nội dung chuyển khoản" })
      .click();
    const copied = await page.evaluate(() => window.__copied);
    expect(copied).toContain(shown);
    expect(copied).toMatch(/35\.000\.000/);
    await expect(
      dialog.getByRole("button", { name: "Sao chép số tiền", exact: true }),
    ).toHaveCount(0);
    const qrBox = await qr.boundingBox();
    const downloadButton = await dialog
      .getByRole("button", { name: "Lưu ảnh QR", exact: true })
      .boundingBox();
    expect(
      Math.abs(
        qrBox.x + qrBox.width / 2 - downloadButton.x - downloadButton.width / 2,
      ),
    ).toBeLessThan(2);
    if (surface.width >= 1000) {
      // Tệp tải về chính là tấm ảnh đã ghép: thẻ đứng có chỗ cho số tiền và
      // nội dung bên dưới mã, không phải ô mã vuông trơ trọi.
      const [fileDownload] = await Promise.all([
        page.waitForEvent("download"),
        dialog
          .getByRole("button", { name: "Lưu ảnh QR", exact: true })
          .click(),
      ]);
      expect(fileDownload.suggestedFilename()).toMatch(
        /^VietQR-CAREM_GD\d+\.png$/,
      );
      const saved = await sharp(await fileDownload.path()).metadata();
      expect(saved.format).toBe("png");
      expect(saved.height).toBeGreaterThan(saved.width);
    }
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
  await dialog.getByRole("button", { name: "Quay lại", exact: true }).click();
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
  await expect(dialog.locator(".vietqr-countdown")).toHaveText(/^13:5\d$/);
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

test("editing the payer after closing instantly reissues the code on reopen, no cooldown wait", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  const launcher = page.getByRole("button", {
    name: "Thanh toán chuyển khoản",
    exact: true,
  });
  await page.getByLabel(/^Tên khách hàng/).fill("Khách Lần Đầu");
  await page.getByLabel("Bán với giá", { exact: true }).fill("35000000");
  await launcher.click();
  const dialog = page.getByRole("dialog", {
    name: "Thanh toán chuyển khoản",
    exact: true,
  });
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  expect(fixture.createCount).toBe(1);
  expect(fixture.replaceCount).toBe(0);
  const firstId = fixture.current.id;
  // Đóng, đổi người trả ngay trong 60 giây cooldown của mã cũ rồi mở lại.
  await dialog.getByRole("button", { name: "Quay lại", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel(/^Tên khách hàng/).fill("Khách Đổi Tên");
  await launcher.click();
  // Server bỏ cooldown cho đổi thông tin → mã mới hiện tức thì, nhân viên không
  // bị kẹt nhìn mã cũ sai dữ liệu.
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  expect(fixture.replaceCount).toBe(1);
  expect(fixture.current.id).not.toBe(firstId);
  expect(fixture.current.payer_name).toBe("Khách Đổi Tên");
});

test("a very large amount still produces a code but flags the bank transfer limit", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await page.getByLabel(/^Tên khách hàng/).fill("Khách Tiền Lớn");
  await page
    .getByLabel("Bán với giá", { exact: true })
    .fill("500000000");
  await page
    .getByRole("button", { name: "Thanh toán chuyển khoản", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Thanh toán chuyển khoản",
    exact: true,
  });
  // Vẫn tạo và hiển thị được mã (không chặn cứng).
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  // Kèm nhắc hạn mức chuyển nhanh 24/7 của ngân hàng.
  await expect(
    dialog.getByText("Số tiền lớn — kiểm tra hạn mức ngân hàng", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByText(/vượt 300\.000\.000/)).toBeVisible();
  expect(fixture.createCount).toBe(1);
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
  const successDialog = page.getByRole("dialog", { name: "Hoàn tất thanh toán", exact: true });
  await expect(
    successDialog.getByText("Đã nhận tiền vào tài khoản", { exact: true }),
  ).toBeVisible();
  await expect(
    successDialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toHaveCount(0);
  await successDialog
    .getByRole("button", { name: "Xác nhận và đóng", exact: true })
    .click();
  await expect(successDialog).toHaveCount(0);
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
  const successDialog = page.getByRole("dialog", { name: "Hoàn tất thanh toán", exact: true });
  await successDialog
    .getByRole("button", { name: "Xác nhận và đóng", exact: true })
    .click();
  await expect(successDialog).toHaveCount(0);
  await expect(page.getByText(/Ngân hàng đã nhận 35\.000\.000/)).toBeVisible();
  // Nhận tiền xong → biểu mẫu BỊ KHÓA: không còn nút "Xem khoản chuyển đã nhận",
  // hành động gộp thành một nút "Kiểm tra & xác nhận bán xe", và ô giá không nhập được.
  await expect(
    page.getByRole("button", { name: "Xem khoản chuyển đã nhận", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Kiểm tra & xác nhận bán xe", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Bán với giá", { exact: true })).toBeDisabled();
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
    dialog.getByText("Cà Rem chưa bật báo tiền tự động cho mã này", { exact: true }),
  ).toBeVisible();
  // Webhook không thể báo tiền về cho mã này ⇒ cấm hứa "tự động kiểm tra".
  await expect(
    dialog.getByText("Tự động kiểm tra thông báo từ ngân hàng.", { exact: true }),
  ).toHaveCount(0);
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

test("no automatic monitoring → 'Đã hoàn tất giao dịch' opens the normal payment form without touching money", async ({
  page,
}) => {
  const fixture = await installQrMock(page, { monitoring: false });
  const dialog = await openSaleQr(page);
  await expect(
    dialog.getByText("Cà Rem chưa bật báo tiền tự động cho mã này", { exact: true }),
  ).toBeVisible();
  // Mục đích kép của thiết kế: bỏ vòng tự kiểm tra nhưng KHÔNG bỏ khả năng quét mã.
  await expect(
    dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(/hỏi lại Cà Rem tiền đã về chưa/),
  ).toBeVisible();

  await dialog.getByRole("button", { name: /Đã hoàn tất giao dịch/ }).click();
  const gate = page.getByRole("alertdialog", {
    name: "Ghi nhận khách đã chuyển khoản?",
  });
  await expect(gate.getByText(/KHÔNG trừ công nợ/)).toBeVisible();
  await gate.getByRole("button", { name: /Mở form thu tiền/ }).click();

  // Modal đóng, form thu tiền thường hiện ra với đúng số liệu của mã QR.
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ghi nhận thanh toán", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Mã tham chiếu", { exact: true })).toHaveValue(
    /^CAREM GD\d{5}$/,
  );
  await expect(page.getByLabel("Tài khoản nhận / sổ chứng từ")).toHaveValue(
    "0000000000",
  );
  // Một cú khai báo không được ghi tiền: không RPC chuyển trạng thái nào đã gọi.
  expect(fixture.manualWrites).toHaveLength(0);
});

for (const surface of paymentVisualSurfaces) {
  test(`transfer appearance remains unchanged (${surface.name})`, async ({ page }) => {
    test.skip(!process.env.CAREM_PAYMENT_VISUAL_MODE, "Opt-in comparison against the local pre-redesign screenshot.");
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await installQrMock(page, { ...surface, fixedClock: true });
    const dialog = await openSaleQr(page);
    await page.evaluate(() => document.fonts.ready);
    const mode = process.env.CAREM_PAYMENT_VISUAL_MODE;
    const folder = mode === "baseline"
      ? "payment-success-baseline-20261016"
      : "payment-success-preview-20261016";
    const directory = resolve("scratch", folder);
    mkdirSync(directory, { recursive: true });
    const screenshot = await dialog.screenshot({
      path: resolve(directory, `transfer-${surface.name}.png`),
      animations: "disabled",
    });
    if (mode !== "baseline") {
      const baseline = readFileSync(resolve("scratch", "payment-success-baseline-20261016", `transfer-${surface.name}.png`));
      const before = await sharp(baseline).raw().toBuffer({ resolveWithObject: true });
      const after = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true });
      expect(after.info).toEqual(before.info);
      expect(after.data.equals(before.data)).toBe(true);
    }
  });

  test(`verified receipt stays readable and accessible (${surface.name})`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    const fixture = await installQrMock(page, { ...surface, fixedClock: true });
    await openSaleQr(page);
    const snapshot = { ...fixture.current };
    fixture.receive("CONFIRMED");
    await page.clock.fastForward(6_000);
    const dialog = page.getByRole("dialog", { name: "Hoàn tất thanh toán", exact: true });
    const heading = dialog.getByRole("heading", { name: "Thanh toán thành công", exact: true });
    const done = dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true });
    const close = dialog.getByRole("button", { name: "Đóng hộp thoại", exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(dialog.getByText("Đã nhận tiền vào tài khoản", { exact: true })).toBeVisible();
    await expect(dialog.locator(".vietqr-success-amount strong")).toHaveText(/25\.000\.000/);
    await expect(dialog.locator(".vietqr-success-reference")).toHaveText(snapshot.qr_reference);
    await expect(dialog.getByText(`${snapshot.qr_reference} (Xe tay ga)`, { exact: true })).toBeVisible();
    await expect(dialog.getByText(snapshot.bank_account_name, { exact: true })).toBeVisible();
    await expect(dialog.getByText(snapshot.bank_account_no, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("img", { name: "Mã QR chuyển khoản", exact: true })).toHaveCount(0);
    await expect(dialog.locator(".vietqr-countdown")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^Tạo mã mới/ })).toHaveCount(0);
    await expect(done).toBeVisible();
    const layout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const action = element.querySelector(".vietqr-success-done").getBoundingClientRect();
      const receipt = element.querySelector(".vietqr-success-receipt");
      return {
        noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
        receiptFits: receipt.scrollWidth <= receipt.clientWidth,
        dialogFits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        actionFits: action.top >= rect.top && action.bottom <= rect.bottom,
        actionHeight: action.height,
      };
    });
    expect(layout.noHorizontalOverflow).toBe(true);
    expect(layout.receiptFits).toBe(true);
    expect(layout.dialogFits).toBe(true);
    expect(layout.actionFits).toBe(true);
    expect(layout.actionHeight).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Tab");
    await expect(done).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(done).toBeFocused();
    await heading.focus();
    await page.evaluate(() => document.fonts.ready);
    const directory = resolve("scratch", "payment-success-preview-20261016");
    mkdirSync(directory, { recursive: true });
    await dialog.screenshot({ path: resolve(directory, `success-${surface.name}.png`), animations: "disabled" });
    await done.click();
    await expect(dialog).toHaveCount(0);
    expect(fixture.manualWrites).toHaveLength(0);
    expect(fixture.createCount).toBe(1);
    expect(fixture.replaceCount).toBe(0);
  });
}

for (const surface of [
  { name: "landscape-dark", width: 667, height: 375 },
  { name: "long-details-narrow-dark", width: 320, height: 667 },
]) {
  test(`verified receipt keeps long details and its action accessible (${surface.name})`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    const fixture = await installQrMock(page, { theme: "dark", fixedClock: true });
    await openSaleQr(page);
    const reference = "CAREM GD123456789012345678";
    const memo = `${reference} (Honda Gold Wing Tour 2026 màu xám)`;
    Object.assign(fixture.current, {
      amount: 1_250_000_000,
      qr_reference: reference,
      transfer_content: memo,
      bank_account_no: "1900000000000000123",
      bank_account_name: "CONG TY TNHH THUONG MAI XE MAY CA REM",
    });
    fixture.receive("CONFIRMED");
    await page.clock.fastForward(6_000);
    const dialog = page.getByRole("dialog", { name: "Hoàn tất thanh toán", exact: true });
    const done = dialog.getByRole("button", { name: "Xác nhận và đóng", exact: true });
    const heading = dialog.getByRole("heading", { name: "Thanh toán thành công", exact: true });
    const owner = dialog.getByText(fixture.current.bank_account_name, { exact: true });
    await expect(heading).toBeFocused();
    await expect(dialog.locator(".vietqr-success-amount strong")).toHaveText(/1\.250\.000\.000/);
    await expect(dialog.locator(".vietqr-success-reference")).toHaveText(reference);
    await expect(dialog.getByText(memo, { exact: true })).toHaveCount(1);
    await expect(dialog.getByText(fixture.current.bank_account_no, { exact: true })).toHaveCount(1);
    const actionFits = async () => done.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    });
    expect(await actionFits()).toBe(true);
    await owner.scrollIntoViewIfNeeded();
    await dialog.locator(".vietqr-success-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(owner).toBeVisible();
    const readable = await dialog.evaluate((element) => {
      const scroll = element.querySelector(".vietqr-success-scroll");
      const receipt = element.querySelector(".vietqr-success-receipt");
      const owner = element.querySelector(".vietqr-success-row:last-child dd");
      const viewport = scroll.getBoundingClientRect();
      const value = owner.getBoundingClientRect();
      return {
        noHorizontalOverflow: element.scrollWidth <= element.clientWidth && receipt.scrollWidth <= receipt.clientWidth,
        ownerInScrollViewport: value.top >= viewport.top - 1 && value.bottom <= viewport.bottom + 1,
        scrollsVertically: scroll.scrollHeight > scroll.clientHeight,
        ownerBounds: { top: value.top, bottom: value.bottom },
        viewportBounds: { top: viewport.top, bottom: viewport.bottom },
      };
    });
    expect(readable.noHorizontalOverflow).toBe(true);
    expect(readable.ownerInScrollViewport, JSON.stringify(readable)).toBe(true);
    if (surface.height < 400) expect(readable.scrollsVertically).toBe(true);
    expect(await actionFits()).toBe(true);
    await heading.focus();
    await page.keyboard.press("Tab");
    await expect(done).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Đóng hộp thoại", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(done).toBeFocused();
    await owner.scrollIntoViewIfNeeded();
    await dialog.locator(".vietqr-success-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.evaluate(() => document.fonts.ready);
    const directory = resolve("scratch", "payment-success-preview-20261016");
    mkdirSync(directory, { recursive: true });
    await dialog.screenshot({ path: resolve(directory, `success-${surface.name}.png`), animations: "disabled" });
    await done.click();
    await expect(dialog).toHaveCount(0);
    expect(fixture.manualWrites).toHaveLength(0);
    expect(fixture.createCount).toBe(1);
    expect(fixture.replaceCount).toBe(0);
  });
}
