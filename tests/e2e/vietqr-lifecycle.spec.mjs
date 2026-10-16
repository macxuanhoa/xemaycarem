import { test, expect } from "@playwright/test";
import {
  installUiuxMock,
  saleId,
  vehicleId,
  vehicleTitle,
} from "../helpers/uiux-fixtures.mjs";

const backend = "https://xe-test.supabase.co/rest/v1/rpc/";

// Miền thanh toán do kiến trúc Mac làm chủ (quyết duyệt 15/10/2026): modal tạo
// mã VietQR động, TIỀN VỀ do server webhook tự ghi nhận — client không còn
// đồng hồ đếm ngược, không tự tính hết hạn, không có nút "Xác nhận và đóng"
// sau bằng chứng ngân hàng. Client chỉ đọc hai nguồn: create (server replay
// bản ghi đang chạy) và matching status poll 6s. Memo ngắn lấy mã đối soát
// đứng đầu, vừa trần byte EMVCo — hợp đồng đó test:db bảo chứng; mock ở đây
// chỉ giả lập server trung thực cùng giao thức.
async function installQrMock(page, { theme = "light", configured = true } = {}) {
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
  const manualWrites = [];
  const nameKey = (value) =>
    (value || "").trim().toLowerCase().replace(/\s+/g, " ");
  // Ảnh VietQR chính thống (img.vietqr.io) được mock để thẻ ảnh hiển thị ổn
  // định trong test.
  await page.route("https://img.vietqr.io/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  const withServerTime = async () => {
    if (!current) return null;
    const now = await serverMs();
    // Server chỉ lật PENDING→EXPIRED khi được hỏi (lazy-expiry, đúng như
    // migration); quá hạn thì tiền không tự nối vào mã nữa.
    if (current.status === "PENDING" && Date.parse(current.expires_at) <= now)
      current.status = "EXPIRED";
    return { ...current, server_now: new Date(now).toISOString() };
  };
  const makeRequest = async (data) => {
    const now = await serverMs();
    const reference = `CAREM GD10000${createCount}`;
    const payer = data.payer_name ?? "Khách kiểm thử";
    current = {
      id: `00000000-0000-4000-8000-00000000010${createCount}`,
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
      // Server Mac sinh memo BẮT ĐẦU bằng mã đối soát và tự rút gọn khi vượt
      // trần; fixture đi đúng shape đó để client không bao giờ cắt nhầm mã.
      transfer_content: `${reference} thanh toán tiền xe XE-UI-001`,
      agreement_text: `${payer} đồng ý thanh toán cho CA REM TEST; xe Xe tay ga, biển 43A1-123.45, mã XE-UI-001, hợp đồng ${data.contract_reference ?? "BAN-UI-001"}.`,
      payer_name: payer,
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
      vietqr_enabled: configured,
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
    const data = route.request().postDataJSON().p_data;
    if (current) {
      // Tiền đã về/đã vào sổ: server trung thực phát lại bản ghi, không xếp mã mới chồng lên.
      if (["RECEIVED", "CONFIRMED"].includes(current.status))
        return reply(route, { ...(await withServerTime()), superseded: false });
      if (
        Number(current.amount) !== Number(data.amount) ||
        nameKey(current.payer_name) !== nameKey(data.payer_name)
      )
        return reply(route, { message: "VIETQR_REPLACE_REQUIRED" }, 400);
      return reply(route, { ...(await withServerTime()), superseded: false });
    }
    return reply(route, { ...(await makeRequest(data)), superseded: false });
  });
  await page.route(`${backend}get_vietqr_matching_status`, async (route) =>
    reply(route, {
      state: bankState,
      qr_status: current?.status,
      bank_received:
        !!current?.bank_transaction_id &&
        ["RECEIVED", "CONFIRMED"].includes(current?.status),
      monitoring_available: true,
      bank_transaction_id: current?.bank_transaction_id,
      sender_name: bankState === "NONE" ? null : "Khách kiểm thử",
      transfer_at: bankState === "NONE" ? null : current?.updated_at,
    }),
  );
  await page.route(`${backend}confirm_vietqr_payment`, async (route) => {
    // Đường lùi cho cửa hàng chưa nối ngân hàng: server CHỈ ghi sau khi chủ
    // kiểm bằng chứng; từ chối trùng/nghiệp vụ sống ở test:db, mock giữ đúng
    // shape đáp án tin cậy.
    manualWrites.push("confirm_vietqr_payment");
    const now = await serverMs();
    current.status = "CONFIRMED";
    current.payment_id = "00000000-0000-4000-8000-000000000203";
    current.updated_at = new Date(now).toISOString();
    return reply(route, current.payment_id);
  });
  await page.route(`${backend}cancel_vietqr_payment_request`, (route) => {
    manualWrites.push("cancel_vietqr_payment_request");
    return reply(route, { message: "UNEXPECTED_WRITE" }, 500);
  });
  return {
    calls,
    manualWrites,
    get current() {
      return current;
    },
    get createCount() {
      return createCount;
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

const panelOf = (page) => page.locator(".vietqr-modal-panel");
// Mặc định cũ (vỏ 011a138): ảnh thẻ VietQR chính thống từ img.vietqr.io — có
// avt chủ tài khoản; mã QR trơn lùi về chế độ "Mã QR đơn".
const qrImage = (panel) =>
  panel.getByRole("img", { name: "Mã QR chuyển khoản", exact: true });

async function openPanel(page, launcherName) {
  await page.getByRole("button", { name: launcherName, exact: true }).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function openSalePanel(page) {
  await page.goto(`/sales/${saleId}`);
  return openPanel(page, "VietQR");
}

async function fillSellForm(page) {
  await page.getByLabel(/^Tên khách hàng/).fill("Khách kiểm thử");
  await page.getByLabel("Bán với giá", { exact: true }).fill("35000000");
}

for (const surface of [
  { theme: "light", width: 1440 },
  { theme: "dark", width: 375 },
]) {
  test(`dynamic VietQR with one display = copy chain and no silent writes (${surface.theme})`, async ({
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
    await fillSellForm(page);
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
    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("heading", {
        name: "Thanh toán chuyển khoản",
        exact: true,
      }),
    ).toBeVisible();
    // Huy hiệu thương hiệu cũ phải còn: avt Logo Cà Rem cạnh đề thoại.
    await expect(
      panel.getByRole("img", { name: "Logo Cà Rem", exact: true }),
    ).toBeVisible();
    const qr = qrImage(panel);
    await expect(qr).toBeVisible();
    await expect(
      panel.getByText("Đang chờ khách chuyển khoản", { exact: true }),
    ).toBeVisible();
    // Giao diện Mac có đủ hai chế độ xem cạnh mã đơn và nút tải kèm theo.
    await expect(
      panel.getByRole("button", { name: "Mã QR đơn", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Thẻ có logo ngân hàng", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Tải mã QR", exact: true }),
    ).toBeVisible();
    // P0-4 · chuỗi duy nhất: hiển thị = memo server = bản copy. Memo ngắn đã
    // nằm trong trần byte EMVCo và mở đầu bằng mã đối soát (server chốt,
    // test:db kiểm; client từ chối mã vượt trần chứ không cắt trộm).
    const serverMemo = fixture.current.transfer_content;
    const byteLength = (value) => new TextEncoder().encode(value).length;
    await expect(panel.getByText(serverMemo, { exact: true })).toBeVisible();
    expect(byteLength(serverMemo)).toBeLessThanOrEqual(95);
    expect(serverMemo.startsWith(fixture.current.qr_reference)).toBe(true);
    await page.evaluate(() => {
      window.__copied = null;
      navigator.clipboard.writeText = (text) => {
        window.__copied = text;
        return Promise.resolve();
      };
    });
    await panel.getByRole("button", { name: "Sao chép", exact: true }).click();
    expect(await page.evaluate(() => window.__copied)).toBe(serverMemo);
    // Học thuyết Mac: lối ghi nhận thủ công HIỆN DIỆN nhưng client không bao
    // giờ tự bấm hộ — mở cửa sổ chỉ được đọc, không được ghi.
    await expect(
      panel.getByRole("button", {
        name: "Tôi đã thấy tiền vào app ngân hàng",
      }),
    ).toBeVisible();
    expect(fixture.createCount).toBe(1);
    expect(fixture.manualWrites).toHaveLength(0);
    // Mã đơn nằm giữa khung hiển thị; panel không tràn ngang trên cả hai khổ.
    const box = await panel.locator(".vietqr-display-box").boundingBox();
    const img = await qr.boundingBox();
    expect(
      Math.abs(img.x + img.width / 2 - (box.x + box.width / 2)),
    ).toBeLessThan(8);
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await panel
      .getByRole("button", { name: "Đóng hộp thoại", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    // Đóng cửa sổ KHÔNG hủy yêu cầu — khách vẫn chuyển được vào mã đang treo.
    expect(fixture.manualWrites).toHaveLength(0);
  });
}

test("reopening replays the active request; changing the amount never stacks a second code", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await fillSellForm(page);
  let panel = await openPanel(page, "Thanh toán chuyển khoản");
  const firstId = fixture.current.id;
  await panel
    .getByRole("button", { name: "Đóng hộp thoại", exact: true })
    .click();
  await page.clock.fastForward(65_000);
  panel = await openPanel(page, "Thanh toán chuyển khoản");
  await expect(qrImage(panel)).toBeVisible();
  // Client hỏi lại, server phát lại ĐÚNG một bản ghi — không mã chồng mã.
  expect(fixture.current.id).toBe(firstId);
  expect(fixture.createCount).toBe(2);
  await panel
    .getByRole("button", { name: "Đóng hộp thoại", exact: true })
    .click();
  // Đổi số tiền khi mã còn treo: server từ chối phát hành chồng lên
  // (VIETQR_REPLACE_REQUIRED); UI hiển thị nhánh lỗi, bản ghi cũ nguyên trạng.
  await page.getByLabel("Bán với giá", { exact: true }).fill("32000000");
  panel = await openPanel(page, "Thanh toán chuyển khoản");
  await expect(
    panel.getByRole("button", { name: "Thử tạo lại mã QR" }),
  ).toBeVisible();
  expect(fixture.current.id).toBe(firstId);
  expect(Number(fixture.current.amount)).toBe(35000000);
  expect(fixture.manualWrites).toHaveLength(0);
});

test("webhook states drive the window: pending approval, mismatch review, recorded completion", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  const panel = await openSalePanel(page);
  await expect(qrImage(panel)).toBeVisible();
  // Đúng mã đúng tiền nhưng người tạo không phải OWNER → hàng đợi chờ chủ ghi
  // nhận; tiền đã về thì không đưa mã cho khách quét lại.
  fixture.setBankState("MATCHED");
  await page.clock.fastForward(6_000);
  await expect(
    panel.getByText("Tiền đã về", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(/Đang chờ chủ cửa hàng ghi nhận vào đơn/),
  ).toBeVisible();
  await expect(qrImage(panel)).toHaveCount(0);
  // Số tiền lệch mã → nhắc đối soát, mã vẫn còn cho khách chuyển tiếp.
  fixture.setBankState("REVIEW");
  await page.clock.fastForward(6_000);
  await expect(
    panel.getByText("Tiền về chưa khớp", { exact: true }),
  ).toBeVisible();
  await expect(qrImage(panel)).toBeVisible();
  // Máy tự ghi sổ (webhook + confirm phía server) → màn hình hoàn tất, không
  // cần — và không cho — nhân viên bấm thu.
  fixture.receive("CONFIRMED");
  await page.clock.fastForward(6_000);
  await expect(panel.getByText(/Đã nhận đủ 25\.000\.000/)).toBeVisible();
  await expect(qrImage(panel)).toHaveCount(0);
  await expect(
    panel.getByRole("link", { name: /Xem đơn hàng/ }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Đóng", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(fixture.manualWrites).toHaveLength(0);
});

test("money arriving while the window is closed: page watcher books the form and reopening replays the same record", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  await page.goto(`/vehicles/${vehicleId}/sell`);
  await fillSellForm(page);
  let panel = await openPanel(page, "Thanh toán chuyển khoản");
  const firstId = fixture.current.id;
  await panel
    .getByRole("button", { name: "Đóng hộp thoại", exact: true })
    .click();
  // Khách chuyển ngay sau khi đóng cửa sổ: vòng theo dõi CẤP TRANG
  // (["vietqr-active"], modal báo khi phát hành mã) phải bắt được tiền — nhân
  // viên không phải mở QR đi "câu" lại trạng thái.
  fixture.receive("RECEIVED");
  await page.clock.fastForward(30_000);
  await expect(
    page.getByText(/Ngân hàng đã nhận 35\.000\.000/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Xem khoản chuyển đã nhận", exact: true }),
  ).toBeVisible();
  panel = await openPanel(page, "Xem khoản chuyển đã nhận");
  // Tiền đang treo trên đúng bản ghi cũ — không phát sinh mã thứ hai.
  expect(fixture.current.id).toBe(firstId);
  expect(fixture.manualWrites).toHaveLength(0);
});

test("offline freezes live checks and cannot fabricate a recorded-money state", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  const panel = await openSalePanel(page);
  await expect(qrImage(panel)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  // Server "đã ghi nhận" nhưng máy nhân viên mất kết nối: mọi poll dừng,
  // màn hình KHÔNG được tự vẽ trạng thái tiền vào sổ từ hư không.
  fixture.setBankState("RECORDED");
  await page.clock.fastForward(60_000);
  await expect(panel.getByText(/Đã nhận đủ/)).toHaveCount(0);
  await expect(qrImage(panel)).toBeVisible();
  expect(fixture.manualWrites).toHaveLength(0);
});

test("manual fallback records only on an explicit staff click, through the server", async ({
  page,
}) => {
  const fixture = await installQrMock(page);
  const panel = await openSalePanel(page);
  await panel
    .getByRole("button", { name: "Tôi đã thấy tiền vào app ngân hàng" })
    .click();
  const alert = page.getByRole("alertdialog", {
    name: "Xác nhận tiền đã vào tài khoản?",
  });
  await expect(alert).toBeVisible();
  await expect(
    alert.getByText(/Kiểm tra ứng dụng ngân hàng đã nhận đúng số tiền/),
  ).toBeVisible();
  await alert
    .getByRole("button", { name: "Đã nhận tiền, xác nhận" })
    .click();
  // SaleDetail đóng cửa sổ sau khi server xác nhận ghi sổ.
  await expect(panel).toHaveCount(0);
  expect(fixture.manualWrites).toEqual(["confirm_vietqr_payment"]);
  expect(fixture.current.status).toBe("CONFIRMED");
  expect(fixture.current.payment_id).not.toBeNull();
});

test("unconfigured VietQR sends staff to settings instead of drawing a code", async ({
  page,
}) => {
  const fixture = await installQrMock(page, { configured: false });
  const panel = await openSalePanel(page);
  await expect(
    panel.getByText("Chưa cấu hình tài khoản nhận tiền", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: /Vào Cài đặt thanh toán/ }),
  ).toBeVisible();
  // Chưa cấu hình thì không gọi server tạo mã làm gì.
  expect(fixture.createCount).toBe(0);
});
