import { z } from "zod";
import { cappedString, CHAR_LIMITS, dateValue, moneyValue } from "@/lib/validation";
import { isValidMotorbikePlate, PLATE_INVALID_MESSAGE } from "@/lib/plate";
import { compactFrame } from "@/lib/frameNumber";

// Re-export validation primitives
export { moneyValue, dateValue };

// Re-export acquisition schema for backward compatibility
export {
  acquisitionSchema,
  type AcquisitionFormValues,
} from "@/features/acquisitions/acquisitionSchema";

// Re-export expense labels for backward compatibility
export {
  vehicleExpenseLabels,
  businessExpenseLabels,
} from "@/features/expenses/expenseSchema";

export const vehicleSchema = z.object({
  // Tên loại xe (mẫu xe) nhập tự do; server chuẩn hoá + get-or-create khi lưu.
  vehicle_type: z
    .string()
    .trim()
    .min(2, "Nhập loại / dòng xe (tối thiểu 2 ký tự).")
    .max(CHAR_LIMITS.vehicleType, `Tên xe tối đa ${CHAR_LIMITS.vehicleType} ký tự, hãy viết gọn lại.`),
  license_plate: cappedString("Biển số", CHAR_LIMITS.plate).refine(
    isValidMotorbikePlate,
    PLATE_INVALID_MESSAGE,
  ),
  year: z
    .number({ error: "Nhập năm sản xuất hợp lệ." })
    .int("Năm sản xuất phải là số nguyên.")
    .min(1950, "Năm sản xuất từ 1950 trở lại đây.")
    .max(new Date().getFullYear() + 1, "Năm sản xuất không được vượt quá năm tới.")
    .optional(),
  color: cappedString("Màu sắc", CHAR_LIMITS.color),
  // Số khung: máy chủ TỰ suy loại theo độ dài chuỗi nén (`private.frame_kind`):
  // rỗng hoặc ≥ 11 ký tự = FULL (VIN đầy đủ, chặn trùng tuyệt đối); 5–10 ký tự
  // = PARTIAL (mảnh rút gọn, chỉ báo nghi trùng). Nhân viên không chọn tay nữa.
  frame_number: cappedString("Số khung", CHAR_LIMITS.frame),
  // Bật khi nhân viên đã đối chiếu danh sách xe tương tự ở mức YELLOW.
  duplicate_ack: z.boolean().optional(),
  purchase_date: dateValue,
  purchase_price: moneyValue.optional(),
  supplier_name: cappedString("Tên nhà cung cấp", CHAR_LIMITS.name),
  supplier_phone: cappedString("Số điện thoại nhà cung cấp", CHAR_LIMITS.phone),
  status: z.enum(["IN_STOCK", "RESERVED", "CANCELLED"]),
  notes: cappedString("Ghi chú", CHAR_LIMITS.notes),
});

vehicleSchema.superRefine((values, ctx) => {
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

export type VehicleFormValues = z.infer<typeof vehicleSchema>;

export const paymentLabels: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  OTHER: "Khác",
};

export const actionLabels: Record<string, string> = {
  CREATE_ACQUISITION: "Thu xe vào kho",
  CANCEL_ACQUISITION: "Hủy thu xe",
  CREATE_VEHICLE: "Nhập xe vào kho",
  UPDATE_VEHICLE: "Cập nhật thông tin xe",
  ADD_EXPENSE: "Thêm chi phí",
  CREATE_EXPENSE: "Thêm chi phí",
  UPDATE_EXPENSE: "Cập nhật chi phí",
  CANCEL_EXPENSE: "Hủy chi phí",
  CREATE_SALE: "Bán xe",
  CANCEL_SALE: "Hủy giao dịch bán",
  REQUEST_DELETE_VEHICLE: "Gửi yêu cầu xóa xe",
  APPROVE_VEHICLE_DELETION: "Duyệt xóa xe",
  RESTORE_VEHICLE_DELETION: "Khôi phục xe sau yêu cầu xóa",
  REQUEST_SALE_BELOW_COST: "Gửi yêu cầu bán dưới giá thu",
  APPROVE_SALE_BELOW_COST: "Chủ duyệt bán dưới giá thu",
  REJECT_SALE_BELOW_COST: "Chủ từ chối bán dưới giá thu",
  CANCEL_SALE_BELOW_COST: "Rút yêu cầu bán dưới giá thu",
  CREATE_PAYMENT: "Ghi nhận thanh toán",
  ADD_PAYMENT: "Ghi nhận thanh toán",
  VOID_PAYMENT: "Hoàn thanh toán",
  ADD_IMAGE: "Thêm ảnh xe",
  REMOVE_IMAGE: "Gỡ ảnh xe",
};
