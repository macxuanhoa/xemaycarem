import { z } from "zod";
import { dateValue, moneyValue } from "@/lib/validation";

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
  expense_type: z.string().trim().max(80).optional(),
  category: z.string().trim().max(80).optional(),
  description: z.string().trim().min(1, "Nhập nội dung chi phí.").max(250),
  amount: moneyValue.refine((val) => val > 0, "Số tiền phải lớn hơn 0."),
  expense_date: dateValue,
});

export type ExpenseFormValues = z.infer<typeof expenseSchema>;
