import { z } from "zod";
import { dateValue, moneyValue } from "@/lib/validation";

export const saleSchema = z
  .object({
    customer_name: z
      .string()
      .trim()
      .max(160, "Tên khách hàng tối đa 160 ký tự.")
      .transform((val) => val || "Khách lẻ"),
    customer_phone: z.string().trim().max(30),
    sale_price: moneyValue,
    sale_date: dateValue,
    due_date: z.string().optional().or(z.literal("")),
    initial_payment: moneyValue,
    payment_method: z.enum(["CASH", "BANK_TRANSFER", "OTHER"]),
    notes: z.string().trim().max(5000),
  })
  .refine((values) => values.initial_payment <= values.sale_price, {
    path: ["initial_payment"],
    message: "Số tiền khách trả trước không được vượt quá giá bán.",
  })
  .refine(
    (values) => {
      if (!values.due_date) return true;
      return values.due_date >= values.sale_date;
    },
    {
      path: ["due_date"],
      message: "Hạn thanh toán phải từ ngày bán trở đi.",
    },
  );
export type SaleFormValues = z.infer<typeof saleSchema>;

export const paymentSchema = z.object({
  amount: moneyValue.refine(
    (amount) => amount > 0,
    "Số tiền thanh toán phải lớn hơn 0.",
  ),
  payment_method: z.enum(["CASH", "BANK_TRANSFER", "OTHER"]),
  payment_date: dateValue,
  reference: z.string().trim().max(160),
  notes: z.string().trim().max(2000),
});
export type PaymentFormValues = z.infer<typeof paymentSchema>;
