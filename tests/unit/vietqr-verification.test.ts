import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isSettledRequest,
  isVerifiedReceipt,
  isWatchableRequest,
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
    // Kiến trúc Mac: tin tiền về chỉ khi server trả bằng chứng — modal không
    // tự đặt tiêu chí "đã thu" riêng, cũng không sở hữu thông báo toàn cục.
    expect(code).toMatch(/get_vietqr_matching_status|api\.getVietQrMatchingStatus/);
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
