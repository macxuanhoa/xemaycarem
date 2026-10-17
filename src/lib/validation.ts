import { z } from "zod";

/**
 * Giới hạn độ dài ký tự — nguồn duy nhất cho toàn dự án.
 * Schema zod dùng các con số này để chặn, còn input trên form dùng
 * `maxLength` đúng giá trị tương ứng: nhân viên được phép viết tới sát
 * giới hạn rồi dừng lại nhẹ nhàng, thay vì nhập tràn trề rồi nhận lỗi
 * tiếng Anh và làm hỏng form (đặc biệt là bước xác nhận thu/bán xe).
 * Số do máy chủ đặt chặt hơn kiểm tra trong DB để chừa khoảng đệm an toàn.
 */
export const CHAR_LIMITS = {
  /** Tên riêng (người bán, khách hàng, nhà cung cấp). */
  name: 160,
  /** Số điện thoại. */
  phone: 30,
  /** Biển số xe. */
  plate: 30,
  /** Số khung / số máy. */
  frame: 100,
  /** Tên loại xe (mẫu xe). */
  vehicleType: 60,
  /** Màu sắc. */
  color: 60,
  /** Nhãn ngắn (loại chi phí, danh mục). */
  shortLabel: 80,
  /** Mô tả ngắn (nội dung chi phí). */
  description: 250,
  /** Tài khoản nhận / mã chứng từ. */
  reference: 160,
  /** Ghi chú dài trên các phiếu chính. */
  notes: 5000,
  /** Ghi chú thanh toán. */
  paymentNotes: 2000,
} as const;

/**
 * Chuỗi văn bản có giới hạn độ dài kèm thông báo tiếng Việt tinh gọn.
 * Dùng chung để mọi cảnh báo quá ký tự trên toàn dự án nhất quán một câu:
 * “<Nhãn> tối đa <n> ký tự.”
 */
export function cappedString(label: string, max: number) {
  return z
    .string()
    .trim()
    .max(max, `${label} tối đa ${max} ký tự, hãy viết gọn lại.`);
}

export const moneyValue = z
  .number({ error: "Nhập số tiền hợp lệ." })
  .int("Số tiền phải là số nguyên đồng.")
  .min(0, "Số tiền không được âm.")
  .max(1_000_000_000_000, "Số tiền vượt giới hạn cho phép.");

export const dateValue = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Chọn ngày hợp lệ.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Ngày không hợp lệ.");
