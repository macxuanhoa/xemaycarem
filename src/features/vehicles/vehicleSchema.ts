import { z } from "zod";

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
export const vehicleSchema = z.object({
  brand: z.string().trim().min(1, "Nhập hãng xe.").max(80),
  model: z.string().trim().min(1, "Nhập dòng xe.").max(120),
  variant: z.string().trim().max(120),
  license_plate: z.string().trim().max(30),
  year: z
    .number({ error: "Nhập năm sản xuất hợp lệ." })
    .int()
    .min(1950)
    .max(new Date().getFullYear() + 1)
    .optional(),
  color: z.string().trim().max(60),
  frame_number: z.string().trim().max(100),
  engine_number: z.string().trim().max(100),
  odometer: z
    .number({ error: "Nhập số km hợp lệ." })
    .int()
    .min(0)
    .max(10_000_000),
  purchase_date: dateValue,
  purchase_price: moneyValue.optional(),
  asking_price: moneyValue,
  supplier_name: z.string().trim().max(160),
  supplier_phone: z.string().trim().max(30),
  status: z.enum(["IN_STOCK", "RESERVED", "CANCELLED"]),
  notes: z.string().trim().max(5000),
});
export type VehicleFormValues = z.infer<typeof vehicleSchema>;

export const vehicleExpenseLabels: Record<string, string> = {
  REPAIR: "Sửa chữa",
  TRANSPORT: "Vận chuyển",
  PAPERWORK: "Giấy tờ",
  PARTS: "Phụ tùng",
  CLEANING: "Vệ sinh",
  INSPECTION: "Kiểm định",
  OTHER: "Khác",
};
export const businessExpenseLabels: Record<string, string> = {
  RENT: "Mặt bằng",
  ELECTRICITY: "Điện nước",
  SALARY: "Lương",
  MARKETING: "Quảng cáo",
  OFFICE: "Văn phòng",
  TRANSPORT: "Vận chuyển",
  OTHER: "Khác",
};
export const paymentLabels: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  OTHER: "Khác",
};
export const actionLabels: Record<string, string> = {
  CREATE_VEHICLE: "Nhập xe vào kho",
  UPDATE_VEHICLE: "Cập nhật thông tin xe",
  ADD_EXPENSE: "Thêm chi phí",
  CREATE_EXPENSE: "Thêm chi phí",
  UPDATE_EXPENSE: "Cập nhật chi phí",
  CANCEL_EXPENSE: "Hủy chi phí",
  CREATE_SALE: "Bán xe",
  CANCEL_SALE: "Hủy giao dịch bán",
  CREATE_PAYMENT: "Ghi nhận thanh toán",
  ADD_PAYMENT: "Ghi nhận thanh toán",
  ADD_IMAGE: "Thêm ảnh xe",
  REMOVE_IMAGE: "Gỡ ảnh xe",
};
