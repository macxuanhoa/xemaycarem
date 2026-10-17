import { z } from "zod";

/**
 * Showroom lead contract (A2). Validation mirrors the DB checks in
 * migration 20261002003300 so users get friendly errors before the RPC
 * rejects with INVALID_PHONE / INVALID_NAME.
 */

/** Normalize Vietnamese phone: +84/84/foreign formats → bare digits, 0-prefixed. */
export function normalizeVietnamPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("84")) return `0${digits.slice(2)}`;
  if (/^0\d{9}$/.test(digits)) return digits;
  if (/^\d{9,10}$/.test(digits) && !digits.startsWith("0")) return `0${digits}`;
  return digits;
}

const VN_PHONE_PATTERN = /^0[35789][0-9]{8}$/;
const YEAR_PATTERN = /^(19|20)\d{2}$/;

export const buybackLeadSchema = z.object({
  customer_name: z
    .string()
    .trim()
    .min(2, "Cho em xin tên ngắn gọn (≥ 2 ký tự).")
    .max(120, "Tên tối đa 120 ký tự, hãy viết gọn lại."),
  phone: z
    .string()
    .transform((value) => normalizeVietnamPhone(value))
    .refine((value) => VN_PHONE_PATTERN.test(value), "Số điện thoại Việt Nam không hợp lệ (ví dụ 0901234567)."),
  vehicle_name: z
    .string()
    .trim()
    .min(2, "Nhập tên xe cần bán (ví dụ: Wave Alpha 2023).")
    .max(160, "Tên xe tối đa 160 ký tự, hãy viết gọn lại."),
  vehicle_year: z
    .string()
    .trim()
    .refine((value) => value === "" || YEAR_PATTERN.test(value), "Năm xe không hợp lệ (ví dụ 2023)."),
  expected_price: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d{1,13}$/.test(value), "Giá mong muốn phải là số nguyên (VND)."),
  message: z.string().trim().max(1000, "Ghi chú tối đa 1000 ký tự."),
});
export type BuybackLeadValues = z.infer<typeof buybackLeadSchema>;

export const inquiryLeadSchema = buybackLeadSchema
  .omit({ vehicle_name: true, vehicle_year: true, expected_price: true })
  .extend({ vehicle_id: z.string().min(1) });
export type InquiryLeadValues = z.infer<typeof inquiryLeadSchema>;

/** Store constants — single source for hotline/Zalo links used by new code. */
export const SHOWROOM_HOTLINE = "0914929292";
export const zaloConsultLink = (message: string) =>
  `https://zalo.me/${SHOWROOM_HOTLINE}?text=${encodeURIComponent(message)}`;
