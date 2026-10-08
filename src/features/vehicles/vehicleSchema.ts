import { z } from "zod";
import { dateValue, moneyValue } from "@/lib/validation";
import { isValidMotorbikePlate, PLATE_INVALID_MESSAGE } from "@/lib/plate";

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
  // Danh mục loại xe (bảng vehicle_types): chỉ chọn, không gõ tay.
  vehicle_type_id: z.string().trim().min(1, "Chọn loại xe."),
  license_plate: z
    .string()
    .trim()
    .max(30)
    .refine(isValidMotorbikePlate, PLATE_INVALID_MESSAGE),
  year: z
    .number({ error: "Nhập năm sản xuất hợp lệ." })
    .int()
    .min(1950)
    .max(new Date().getFullYear() + 1)
    .optional(),
  color: z.string().trim().max(60),
  frame_number: z.string().trim().max(100),
  purchase_date: dateValue,
  purchase_price: moneyValue.optional(),
  supplier_name: z.string().trim().max(160),
  supplier_phone: z.string().trim().max(30),
  status: z.enum(["IN_STOCK", "RESERVED", "CANCELLED"]),
  notes: z.string().trim().max(5000),
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
  CREATE_PAYMENT: "Ghi nhận thanh toán",
  ADD_PAYMENT: "Ghi nhận thanh toán",
  VOID_PAYMENT: "Hoàn thanh toán",
  ADD_IMAGE: "Thêm ảnh xe",
  REMOVE_IMAGE: "Gỡ ảnh xe",
};
