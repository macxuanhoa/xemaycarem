import type { VietQrPaymentRequest } from "@/types";

/**
 * Nghiệp vụ đối soát VietQR tập trung một chỗ.
 *
 * Tiền chỉ được coi là ĐÃ VỀ khi server gắn bằng chứng ngân hàng
 * (`bank_transaction_id`) và chuyển trạng thái bản ghi — không có đường nào cho
 * trạng thái phía máy khách tự xưng đã thanh toán. Đây là nguồn chân lý duy nhất
 * cho cả modal lẫn vòng theo dõi ở cấp trang, để hai nơi không tự đặt tiêu chí
 * khác nhau rồi báo cáo sai đã thu tiền.
 */

/** Một mã tra cứu duy nhất: modal và trang cùng nhìn vào một ô cache. */
export const vietqrActiveQueryKey = (
  vehicleId: string | null | undefined,
  saleId?: string | null,
) => ["vietqr-active", vehicleId ?? null, saleId ?? null] as const;

/** Bản ghi có bằng chứng ngân hàng và trạng thái xác nhận từ server. */
export function isVerifiedReceipt(
  request: VietQrPaymentRequest | null | undefined,
): boolean {
  return (
    !!request?.bank_transaction_id &&
    (request.status === "RECEIVED" || request.status === "CONFIRMED")
  );
}

/**
 * Có nên tiếp tục hỏi server nữa không?
 *   * PENDING: khách có thể chuyển bất cứ lúc nào → phải theo dõi;
 *   * CANCELLED / EXPIRED / đã xác minh: hết chuyện theo dõi. EXPIRED không còn
 *     đường tự khớp vì server chỉ nối tiền vào yêu cầu PENDING (tiền về muộn rơi
 *     vào MANUAL_REVIEW cho người xử lý), nên tiếp tục poll chỉ tổ tốn request.
 */
export function isWatchableRequest(
  request: VietQrPaymentRequest | null | undefined,
): boolean {
  if (!request) return false;
  if (isVerifiedReceipt(request)) return false;
  return request.status === "PENDING";
}

/** Bản ghi đã chốt xong ở server (thành công hoặc hủy) — không chờ gì thêm. */
export function isSettledRequest(
  request: VietQrPaymentRequest | null | undefined,
): boolean {
  if (!request) return false;
  return isVerifiedReceipt(request) || request.status === "CANCELLED";
}
