import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isMoneyMonitorUnavailable,
  isSettledRequest,
  isVerifiedReceipt,
  isWatchableRequest,
  moneyPollMs,
  QR_POLL_ACTIVE_MS,
  QR_POLL_IDLE_MS,
  vietqrActiveQueryKey,
} from "@/features/sales/vietqrVerification";
import type { VietQrPaymentRequest } from "@/types";

/**
 * P1-c: vòng xác minh tiền vào phải sống sót sau khi đóng modal, và chỉ được
 * tin vào bằng chứng server — không bao giờ tin trạng thái tự xưng ở máy khách.
 */

const base: VietQrPaymentRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  qr_reference: "CAREM GD00123",
  vehicle_id: "22222222-2222-4222-8222-222222222222",
  sale_id: null,
  amount: 17_500_000,
  bank_bin: "970422",
  bank_name: "MB Bank",
  bank_account_no: "0987654321",
  bank_account_name: "Cua Hang Xe May Ca Rem",
  qr_payload: "",
  expires_at: "2026-10-14T09:00:00Z",
  replace_available_at: "2026-10-14T08:31:00Z",
  server_now: "2026-10-14T08:30:00Z",
  monitoring_available: true,
  transfer_content: "CAREM GD00123 Khách mua xe thanh toán tiền xe",
  agreement_text: "",
  payer_name: "Khách mua xe",
  contract_reference: "HD-0001",
  vehicle_label: "CR-0417",
  bank_transaction_id: null,
  receipt_id: null,
  status: "PENDING",
  payment_id: null,
  created_by: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-10-14T08:30:00Z",
  updated_at: "2026-10-14T08:30:00Z",
};

const withTx = (status: VietQrPaymentRequest["status"]) => ({
  ...base,
  status,
  bank_transaction_id: "44444444-4444-4444-8444-444444444444",
});

describe("P1-c · tiêu chí xác minh chỉ dựa vào bằng chứng server", () => {
  it("PENDING chưa có giao dịch ngân hàng → chưa nhận tiền", () => {
    expect(isVerifiedReceipt(base)).toBe(false);
    expect(isVerifiedReceipt(null)).toBe(false);
    expect(isVerifiedReceipt(undefined)).toBe(false);
  });

  it("trạng thái RECEIVED/CONFIRMED nhưng thiếu bank_transaction_id → KHÔNG được tin", () => {
    // Cờ trạng thái đơn thuần không phải bằng chứng: server chỉ nối tiền khi
    // khớp đúng tài khoản, số tiền và nội dung chuyển khoản.
    for (const status of ["RECEIVED", "CONFIRMED"] as const) {
      expect(isVerifiedReceipt({ ...base, status })).toBe(false);
    }
  });

  it("có bank_transaction_id + RECEIVED/CONFIRMED → đã xác minh", () => {
    expect(isVerifiedReceipt(withTx("RECEIVED"))).toBe(true);
    expect(isVerifiedReceipt(withTx("CONFIRMED"))).toBe(true);
  });

  it("PENDING/EXPIRED/CANCELLED có giao dịch gắn nhầm vẫn không được tính là đã thu", () => {
    for (const status of ["PENDING", "EXPIRED", "CANCELLED"] as const) {
      expect(isVerifiedReceipt({ ...base, status, bank_transaction_id: withTx(status).bank_transaction_id })).toBe(
        false,
      );
    }
  });

  it("chỉ theo dõi khi còn cơ hội nhận tiền: PENDING mới đáng poll", () => {
    expect(isWatchableRequest(base)).toBe(true);
    expect(isWatchableRequest(withTx("RECEIVED"))).toBe(false);
    expect(isWatchableRequest({ ...base, status: "EXPIRED" })).toBe(false);
    expect(isWatchableRequest({ ...base, status: "CANCELLED" })).toBe(false);
    expect(isWatchableRequest(null)).toBe(false);
  });

  it("bản ghi chốt xong (đã thu hoặc đã hủy) dừng hẳn vòng kiểm tra", () => {
    expect(isSettledRequest(withTx("CONFIRMED"))).toBe(true);
    expect(isSettledRequest({ ...base, status: "CANCELLED" })).toBe(true);
    expect(isSettledRequest(base)).toBe(false);
  });

  it("modal và trang dùng chung MỘT mã cache để không nhân đôi gọi server", () => {
    expect(vietqrActiveQueryKey("vehicle-1", "sale-1")).toEqual([
      "vietqr-active",
      "vehicle-1",
      "sale-1",
    ]);
    expect(vietqrActiveQueryKey("vehicle-1")).toEqual(["vietqr-active", "vehicle-1", null]);
    expect(vietqrActiveQueryKey(undefined)).toEqual(["vietqr-active", null, null]);
  });
});

describe("P1-c · vòng xác minh dời lên cấp trang (source contract)", () => {
  const modal = readFileSync("src/features/sales/VietQrPaymentModal.tsx", "utf8");
  const watcher = readFileSync("src/features/sales/useVietQrPaymentWatcher.ts", "utf8");
  const detailPage = readFileSync("src/features/sales/SaleDetailPage.tsx", "utf8");
  const sellPage = readFileSync("src/features/sales/SellVehiclePage.tsx", "utf8");

  it("modal không còn tự bắn toast 'Đã nhận tiền' (đó là việc của trang)", () => {
    const code = modal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Modal vẫn được phép HIỂN THỊ trạng thái đã thu trong panel, nhưng không
    // còn là nơi owner của thông báo toàn cục — info đó phải tới kể cả khi modal
    // đã đóng.
    expect(code).not.toMatch(/toast\.success\(\s*"Đã nhận tiền vào tài khoản"/);
    expect(code).toContain("isVerifiedReceipt");
    expect(code).not.toContain("announcedReceipt");
  });

  it("toast xác minh nằm trong hook cấp trang", () => {
    expect(watcher).toContain("Đã nhận tiền vào tài khoản");
    expect(watcher).toContain("isVerifiedReceipt");
  });

  it("hook cấp trang tự tắt vòng lặp khi bản ghi không còn chờ tiền", () => {
    expect(watcher).toMatch(
      /refetchInterval:\s*\(state\)\s*=>\s*\(?\s*isWatchableRequest\(state\.state\.data\)/,
    );
    expect(watcher).toContain("vietqrActiveQueryKey");
    expect(watcher).toContain("network.online");
  });

  it("cả hai trang dựng modal đều mount watcher — không trang nào sót", () => {
    for (const page of [detailPage, sellPage]) {
      expect(page).toContain("useVietQrPaymentWatcher");
      expect(page).toMatch(/useVietQrPaymentWatcher\(\{[\s\S]*?vehicleId/);
    }
  });

  it("hook được gọi ở mức component trang, TRƯỚC mọi early-return và ngoài khối JSX modal", () => {
    // Đặt trong khối `{showVietQr && <Modal/>}` sẽ chết cùng modal — đúng lỗi gốc.
    const watcherAt = detailPage.indexOf("useVietQrPaymentWatcher({");
    const earlyReturn = detailPage.indexOf("if (query.isPending) return");
    expect(watcherAt).toBeGreaterThan(-1);
    expect(watcherAt).toBeLessThan(earlyReturn);

    const sellWatcherAt = sellPage.indexOf("useVietQrPaymentWatcher({");
    const sellModalAt = sellPage.indexOf("{showVietQrModal && (");
    expect(sellWatcherAt).toBeLessThan(sellModalAt);
  });

  it(" SellVehiclePage ghi nhận tiền bằng đúng một lối cho cả modal lẫn watcher", () => {
    expect(sellPage).toContain("applyVerifiedPayment");
    expect(sellPage).toMatch(/onVerified:\s*applyVerifiedPayment/);
    expect(sellPage).toMatch(/onPaymentConfirmed=\{\(confirmedRequest\)\s*=>\s*\{\s*applyVerifiedPayment\(confirmedRequest\)/s);
    // Không còn chỗ nào tự set receivedQr ngoài lối chung (khai báo useState
    // viết `[receivedQr, setReceivedQr] =` nên không rơi vào phép đếm này).
    const sets = sellPage.match(/setReceivedQr\(/g) ?? [];
    expect(sets.length).toBe(1); // đúng một lần, bên trong applyVerifiedPayment
  });
});

/**
 * Chủ cửa hàng chỉ dùng VietQR khi chính ông cấu hình webhook. Khi server báo
 * monitoring_available = false (webhook chưa bật / chưa chọn nhà cung cấp / tài
 * khoản nhận đã đổi khác mã đang hiện), giao diện KHÔNG được hứa hẹn gì về tiền
 * tự về — và cũng không được hỏi server nhịp 5 giây cho một điều không xảy ra.
 */
describe("Không có báo tiền tự động → tắt tự kiểm tra, bảo người dùng hỏi lại Cà Rem", () => {
  const modal = readFileSync("src/features/sales/VietQrPaymentModal.tsx", "utf8");
  const detailPage = readFileSync("src/features/sales/SaleDetailPage.tsx", "utf8");
  const sellPage = readFileSync("src/features/sales/SellVehiclePage.tsx", "utf8");
  const noMonitor: VietQrPaymentRequest = { ...base, monitoring_available: false };

  it("server nói monitoring_available = false → nhận diện đúng, kể cả khi chỉ một nguồn báo về", () => {
    expect(isMoneyMonitorUnavailable(noMonitor)).toBe(true);
    // Vòng tra trạng thái trả về false khi cấu hình vừa đổi, dù bản ghi modal
    // đang giữ vẫn là bản cũ báo true.
    expect(isMoneyMonitorUnavailable(base, false)).toBe(true);
    expect(isMoneyMonitorUnavailable(base)).toBe(false);
    expect(isMoneyMonitorUnavailable(null)).toBe(false);
  });

  it("nhịp hỏi tụt từ 5 giây xuống 60 giây, nhưng KHÔNG tắt hẳn", () => {
    expect(moneyPollMs(base)).toBe(QR_POLL_ACTIVE_MS);
    expect(moneyPollMs(noMonitor)).toBe(QR_POLL_IDLE_MS);
    expect(moneyPollMs(base, false)).toBe(QR_POLL_IDLE_MS);
    // 60s chứ không phải false: Chủ sửa xong cấu hình thì màn hình đang mở tự
    // nhận ra, khỏi bắt đóng/mở lại giữa lúc đứng trước mặt khách.
    expect(QR_POLL_IDLE_MS).toBeGreaterThan(QR_POLL_ACTIVE_MS);
    expect(moneyPollMs(noMonitor)).toBeGreaterThan(0);
  });

  it("cả hai vòng poll đều đi qua cùng một hàm nhịp", () => {
    const watcher = readFileSync("src/features/sales/useVietQrPaymentWatcher.ts", "utf8");
    expect(watcher).toContain("moneyPollMs");
    expect(modal).toContain("moneyPollMs");
    // Modal không còn giữ nhịp 5 giây cứng nào cho vòng tiền.
    expect(modal).not.toMatch(/refetchInterval:\s*5_000/);
  });

  it("lời hứa 'tự động kiểm tra' chỉ được nói khi thực sự có kênh báo tiền", () => {
    const code = modal
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const pendingBranch = /title: "Chưa nhận được tiền",\s*detail:\s*"Tự động kiểm tra thông báo từ ngân hàng\."/.test(code);
    expect(pendingBranch).toBe(true);
    // Nhánhmonitoring phải đứng TRƯỚC nhánh "tự động kiểm tra" trong chuỗi ternary,
    // nên không thể tới được lời hứa đó khi monitorUnavailable.
    expect(code.indexOf("monitorUnavailable")).toBeLessThan(
      code.indexOf('"Tự động kiểm tra thông báo từ ngân hàng."'),
    );
    // và cũng trước cả nhánh hết hạn, để "hết hạn + không webhook" cùng một thông điệp.
    expect(code.indexOf("monitorUnavailable")).toBeLessThan(
      code.indexOf("Mã QR đã hết hạn"),
    );
    expect(code).toContain("hỏi lại Cà Rem tiền đã về chưa");
  });

  it("nút 'Đã hoàn tất giao dịch' không tự đặt trạng thái đã thu tiền", () => {
    const code = modal
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("Đã hoàn tất giao dịch");
    expect(code).toContain("manualConfirmOffered");
    // Nút bị khóa khi bản ghi đã xác minh rồi — không có đường "bấm tay tự chốt".
    expect(code).toMatch(/manualConfirmOffered =\s*!!onManualConfirm &&\s*!verifiedReceipt/);
    // Phải xin xác nhận rõ rang trước khi mở form thu tiền.
    expect(code).toMatch(/askManualCompletion[\s\S]{0,600}confirmAction\(/);
    expect(code).toContain("KHÔNG trừ công nợ");
    // Modal tự nó không được gọi RPC ghi tiền nào.
    expect(code).not.toMatch(/api\.(confirmBankTransaction|addPayment)\(/);
  });

  it("nút chỉ hiện khi trang gọi thực sự có form thu tiền để mở", () => {
    // SaleDetailPage truyền onManualConfirm có điều kiện đơn COMPLETED còn công nợ.
    expect(detailPage).toContain("onManualConfirm");
    expect(detailPage).toMatch(/sale\.status === "COMPLETED" && sale\.remaining_amount > 0\s*\?\s*\(request\) =>/);
    // Số liệu từ mã được mang sang form, không bắt gõ lại.
    expect(detailPage).toContain("reference: request.qr_reference");
    expect(detailPage).toContain("evidenceScope: request.bank_account_no");
    // SellVehiclePage chưa có đơn → không truyền handler → không bày nút dẫn vào cụt.
    expect(sellPage).not.toContain("onManualConfirm");
  });

  it("STAFF không còn thấy nút chuyển khoản mà máy chủ chắc chắn từ chối", () => {
    // create_vietqr_payment_request đòi can_financials() (chỉ OWNER/MANAGER), nên
    // bày nút cho STAFF là mở đường cho một lỗi quyền ngay trước mặt khách.
    // So khớp đúng nút cần chặn — trang bán xe còn những chỗ khác dùng canFinance
    // (khối "Giá vốn hiện tại"), không thể đếm bừa.
    expect(sellPage).toMatch(
      /\{canFinance\(profile\) && \(\s*<Button[\s\S]{0,600}?className="full-width sale-aside-vietqr-btn"/,
    );
    expect(detailPage).toMatch(
      /\{canFinance\(profile\) && \(\s*<Button variant="ghost" onClick=\{\(\) => setShowVietQr\(true\)\}/,
    );
  });
});
