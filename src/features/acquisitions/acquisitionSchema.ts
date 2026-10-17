import { z } from "zod";
import { cappedString, CHAR_LIMITS, dateValue, moneyValue } from "@/lib/validation";
import { isValidMotorbikePlate, PLATE_INVALID_MESSAGE } from "@/lib/plate";
import { compactFrame } from "@/lib/frameNumber";

export const acquisitionSchema = z
  .object({
    // Số khung: máy chủ TỰ suy loại theo độ dài chuỗi nén (`private.frame_kind`):
    // rỗng hoặc ≥ 11 ký tự = FULL (VIN đầy đủ, có thể để trống → server sinh GEN
    // placeholder); 5–10 ký tự = PARTIAL (mảnh rút gọn, chỉ báo nghi trùng).
    frame_number: cappedString("Số khung", CHAR_LIMITS.frame),
    // Bật khi nhân viên đã đối chiếu danh sách xe tương tự ở mức YELLOW.
    duplicate_ack: z.boolean().optional(),
    license_plate: cappedString("Biển số", CHAR_LIMITS.plate).refine(
      isValidMotorbikePlate,
      PLATE_INVALID_MESSAGE,
    ),
    // Tên loại xe (mẫu xe) nhập tự do; gợi ý học từ xe đã lưu, server get-or-create.
    vehicle_type: z
      .string()
      .trim()
      .min(2, "Nhập loại / dòng xe (tối thiểu 2 ký tự).")
      .max(CHAR_LIMITS.vehicleType, `Tên xe tối đa ${CHAR_LIMITS.vehicleType} ký tự, hãy viết gọn lại.`),
    year: z
      .number({ error: "Nhập năm sản xuất hợp lệ." })
      .int("Năm sản xuất phải là số nguyên.")
      .min(1950, "Năm sản xuất từ 1950 trở lại đây.")
      .max(new Date().getFullYear() + 1, "Năm sản xuất không được vượt quá năm tới.")
      .optional(),
    color: cappedString("Màu sắc", CHAR_LIMITS.color),
    acquisition_date: dateValue,
    // Giá thu là thông tin bắt buộc khi đưa xe vào kho, với mọi role đang thao
    // tác xe (server chặn PURCHASE_PRICE_REQUIRED). Ô tiền để trống = NaN.
    purchase_price: moneyValue.optional(),
    seller_name: cappedString("Tên người bán", CHAR_LIMITS.name),
    seller_phone: cappedString("Số điện thoại người bán", CHAR_LIMITS.phone),
    notes: cappedString("Ghi chú", CHAR_LIMITS.notes),
  })
  .superRefine((values, ctx) => {
    if (
      values.purchase_price == null ||
      !Number.isFinite(values.purchase_price) ||
      values.purchase_price <= 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purchase_price"],
        message: "Nhập giá thu xe (lớn hơn 0) để hồ sơ xe có giá vốn ngay từ đầu.",
      });
    }
    const compact = compactFrame(values.frame_number);
    // Mảnh dưới 5 ký tự quá mơ hồ để đối chiếu (server coi 1–10 ký tự là PARTIAL);
    // chặn ngay ở form thay vì để nhân viên lưu một mẩu dễ gây nghi trùng giả.
    if (compact.length > 0 && compact.length < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frame_number"],
        message: "Số khung rút gọn cần đủ 5 ký tự (chữ hoặc số).",
      });
    }
  });

export type AcquisitionFormValues = z.infer<typeof acquisitionSchema>;
