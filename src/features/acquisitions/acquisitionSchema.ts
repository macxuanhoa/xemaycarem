import { z } from "zod";
import { dateValue, moneyValue } from "@/lib/validation";
import { isValidMotorbikePlate, PLATE_INVALID_MESSAGE } from "@/lib/plate";

export const acquisitionSchema = z.object({
  frame_number: z
    .string()
    .trim()
    .max(100, "Số khung tối đa 100 ký tự."),
  license_plate: z
    .string()
    .trim()
    .max(30)
    .refine(isValidMotorbikePlate, PLATE_INVALID_MESSAGE),
  // Danh mục loại xe: nhân viên chỉ chọn, không gõ tên hãng/tên xe.
  vehicle_type_id: z.string().trim().min(1, "Chọn loại xe."),
  year: z
    .number({ error: "Nhập năm sản xuất hợp lệ." })
    .int("Năm sản xuất phải là số nguyên.")
    .min(1950, "Năm sản xuất từ 1950 trở lại đây.")
    .max(new Date().getFullYear() + 1, "Năm sản xuất không được vượt quá năm tới.")
    .optional(),
  color: z.string().trim().max(60),
  acquisition_date: dateValue,
  purchase_price: moneyValue.optional(),
  seller_name: z.string().trim().max(160),
  seller_phone: z.string().trim().max(30),
  notes: z.string().trim().max(5000),
});

export type AcquisitionFormValues = z.infer<typeof acquisitionSchema>;
