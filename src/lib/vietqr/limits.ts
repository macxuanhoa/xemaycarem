/**
 * Giới hạn một lệnh chuyển khoản nhanh 24/7 (Napas) — nền tảng mã VietQR của Cà Rem.
 *
 * Đây KHÔNG phải trần kỹ thuật của hệ thống: server vẫn ACCEPT một mã có số tiền lớn
 * hơn nhiều (money_input cho tới 1.000.000.000.000 ₫). Trần dưới đây là mốc THỰC TẾ mà
 * nhiều ngân hàng áp cho MỖI lệnh Napas 247. Vượt mốc, khách quét mã vẫn có thể bị app
 * ngân hàng từ chối ("vượt hạn mức chuyển nhanh") — giao dịch không về, nhân viên đứng
 * nhìn biểu mẫu. Vì hạn mức khác nhau theo từng ngân hàng/hạng tài khoản, ta chỉ NHẮC
 * (không chặn): mã vẫn tạo được, chỉ kèm hướng dẫn chia nhỏ hoặc chuyển thường.
 *
 * Owner chốt mức 300.000.000 ₫ ngày 17/10/2026 (mốc phổ biến, thiên về an toàn).
 */
export const NAPAS_SINGLE_TRANSFER_LIMIT = 300_000_000;

/** Số tiền có vượt mốc một lệnh chuyển nhanh 24/7 thường thấy hay không. */
export function isAboveNapasSingleTransfer(
  amount: number | null | undefined,
): boolean {
  return (
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount > NAPAS_SINGLE_TRANSFER_LIMIT
  );
}

/**
 * Nội dung nhắc người dùng khi vượt mốc. Tách riêng để UI và test dùng chung một
 * chuỗi, không tái dựng văn bản rời rạc ở nhiều nơi.
 */
export function napasOverLimitHint(): string {
  const formatted = new Intl.NumberFormat("vi-VN").format(
    NAPAS_SINGLE_TRANSFER_LIMIT,
  );
  return `Số tiền này vượt ${formatted} ₫ — nhiều ngân hàng giới hạn mỗi lệnh chuyển nhanh 24/7 ở mức thấp hơn. Khách có thể cần chuyển khoản thường, ra quầy, hoặc tách thành nhiều lệnh nhỏ. Mã này vẫn tạo và quét được.`;
}
