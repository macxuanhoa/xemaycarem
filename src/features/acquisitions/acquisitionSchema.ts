import { z } from "zod";
import { dateValue, moneyValue } from "@/lib/validation";
import { isValidMotorbikePlate, PLATE_INVALID_MESSAGE } from "@/lib/plate";

export const acquisitionSchema = z.object({
  frame_number: z
    .string()
    .trim()
    .max(100, "Số khung tối đa 100 ký tự."),
  engine_number: z.string().trim().max(100),
  license_plate: z
    .string()
    .trim()
    .max(30)
    .refine(isValidMotorbikePlate, PLATE_INVALID_MESSAGE),
  brand: z.string().trim().max(80),
  model: z.string().trim().min(1, "Nhập dòng xe.").max(120),
  variant: z.string().trim().max(120),
  year: z
    .number({ error: "Nhập năm sản xuất hợp lệ." })
    .int("Năm sản xuất phải là số nguyên.")
    .min(1950, "Năm sản xuất từ 1950 trở lại đây.")
    .max(new Date().getFullYear() + 1, "Năm sản xuất không được vượt quá năm tới.")
    .optional(),
  color: z.string().trim().max(60),
  odometer: z
    .number({ error: "Nhập số km hợp lệ." })
    .int("Số km phải là số nguyên.")
    .min(0, "Số km không được âm.")
    .max(10_000_000, "Số km vượt giới hạn cho phép.")
    .optional(),
  acquisition_date: dateValue,
  purchase_price: moneyValue.optional(),
  asking_price: moneyValue.optional(),
  seller_name: z.string().trim().max(160),
  seller_phone: z.string().trim().max(30),
  notes: z.string().trim().max(5000),
});

export type AcquisitionFormValues = z.infer<typeof acquisitionSchema>;
