import { z } from "zod";
import { cappedString, CHAR_LIMITS, dateValue, moneyValue } from "@/lib/validation";

export const saleSchema = z
  .object({
    customer_name: cappedString("Tên khách hàng", CHAR_LIMITS.name).transform(
      (val) => val || "Khách lẻ",
    ),
    customer_phone: cappedString("Số điện thoại khách hàng", CHAR_LIMITS.phone),
    sale_price: moneyValue,
    sale_date: dateValue,
    due_date: z.string().optional().or(z.literal("")),
    initial_payment: moneyValue,
    payment_method: z.enum(["CASH", "BANK_TRANSFER", "OTHER"]),
    notes: cappedString("Ghi chú", CHAR_LIMITS.notes),
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
  reference: cappedString("Tài khoản nhận / mã chứng từ", CHAR_LIMITS.reference),
  notes: cappedString("Ghi chú", CHAR_LIMITS.paymentNotes),
});
export type PaymentFormValues = z.infer<typeof paymentSchema>;
