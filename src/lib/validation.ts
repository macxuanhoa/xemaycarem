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
