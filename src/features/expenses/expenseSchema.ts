import { z } from "zod";
import { cappedString, CHAR_LIMITS, dateValue, moneyValue } from "@/lib/validation";

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

export const expenseSchema = z.object({
  vehicle_id: z.string().uuid("Chọn xe hợp lệ.").optional().or(z.literal("")),
  expense_type: cappedString("Loại chi phí", CHAR_LIMITS.shortLabel).optional(),
  category: cappedString("Danh mục", CHAR_LIMITS.shortLabel).optional(),
  description: z
    .string()
    .trim()
    .min(1, "Nhập nội dung chi phí.")
    .max(CHAR_LIMITS.description, `Nội dung chi phí tối đa ${CHAR_LIMITS.description} ký tự, hãy viết gọn lại.`),
  amount: moneyValue.refine((val) => val > 0, "Số tiền phải lớn hơn 0."),
  expense_date: dateValue,
});

export type ExpenseFormValues = z.infer<typeof expenseSchema>;
