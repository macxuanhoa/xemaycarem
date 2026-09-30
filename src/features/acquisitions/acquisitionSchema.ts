import { z } from "zod";
import { dateValue, moneyValue } from "@/lib/validation";

export const acquisitionSchema = z.object({
  frame_number: z
    .string()
    .trim()
    .min(1, "Nhập số khung xe.")
    .max(100, "Số khung tối đa 100 ký tự."),
  engine_number: z.string().trim().max(100),
  license_plate: z.string().trim().max(30),
  brand: z.string().trim().min(1, "Nhập hãng xe.").max(80),
  model: z.string().trim().min(1, "Nhập dòng xe.").max(120),
  variant: z.string().trim().max(120),
  year: z
    .number({ error: "Nhập năm sản xuất hợp lệ." })
    .int()
    .min(1950)
    .max(new Date().getFullYear() + 1)
    .optional(),
  color: z.string().trim().max(60),
  odometer: z
    .number({ error: "Nhập số km hợp lệ." })
    .int()
    .min(0)
    .max(10_000_000),
  acquisition_date: dateValue,
  purchase_price: moneyValue.optional(),
  asking_price: moneyValue,
  seller_name: z.string().trim().max(160),
  seller_phone: z.string().trim().max(30),
  notes: z.string().trim().max(5000),
});

export type AcquisitionFormValues = z.infer<typeof acquisitionSchema>;
