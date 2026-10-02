/**
 * Converts reviewed shorthand entries into the exact payload shape that
 * `import_vehicles` expects, with the same checks mirrored client-side so
 * the user sees problems per card before anything is sent to the server.
 */
import type { IntakeEntry, IntakeFieldKey } from "./parseIntakeNotes";
import { parseShorthandMoney } from "./parseIntakeNotes";
import { today } from "@/lib/format";

const MAX_PLATE = 30;
const MAX_FRAME = 100;

function moneyOf(entry: IntakeEntry, field: IntakeFieldKey): number | null | "invalid" {
  const raw = entry.fields[field];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = parseShorthandMoney(raw);
  return parsed === null ? "invalid" : parsed;
}

/** Returns Vietnamese error messages for one entry; empty means ready to import. */
export function validateIntakeEntry(
  entry: IntakeEntry,
  financial: boolean,
): string[] {
  const errors: string[] = [];
  const f = entry.fields;
  if (!f.frame_number?.trim()) errors.push("Thiếu số khung.");
  else if (f.frame_number.trim().length > MAX_FRAME)
    errors.push(`Số khung tối đa ${MAX_FRAME} ký tự.`);
  if (!f.brand?.trim()) errors.push("Thiếu hãng xe.");
  else if (f.brand.trim().length > 80) errors.push("Hãng xe tối đa 80 ký tự.");
  if (!f.model?.trim()) errors.push("Thiếu dòng xe.");
  else if (f.model.trim().length > 120) errors.push("Dòng xe tối đa 120 ký tự.");
  if ((f.license_plate ?? "").length > MAX_PLATE)
    errors.push(`Biển số tối đa ${MAX_PLATE} ký tự.`);
  if (f.year) {
    const year = Number(f.year);
    if (!/^\d{4}$/.test(f.year.trim()) || year < 1900 || year > 2100)
      errors.push("Năm sản xuất phải từ 1900 đến 2100.");
  }
  if (f.odometer) {
    const km = Number(f.odometer);
    if (!/^\d+$/.test(f.odometer.trim()) || km < 0 || km > 10_000_000)
      errors.push("Số km phải từ 0 đến 10.000.000.");
  }
  if (f.purchase_date && f.purchase_date > today())
    errors.push("Ngày thu không được ở tương lai.");
  const purchase = moneyOf(entry, "purchase_price");
  if (purchase === "invalid") errors.push("Giá thu không hợp lệ (vd: 18tr5).");
  if (financial && purchase === null) errors.push("Cần nhập giá thu xe.");
  const asking = moneyOf(entry, "asking_price");
  if (asking === "invalid") errors.push("Giá niêm yết không hợp lệ (vd: 22tr).");
  if ((f.supplier_name ?? "").length > 200) errors.push("Tên người bán quá dài.");
  if ((f.supplier_phone ?? "").length > 40) errors.push("SĐT người bán quá dài.");
  if ((f.notes ?? "").length > 10_000) errors.push("Ghi chú quá dài.");
  return errors;
}

/** Payload row for `import_vehicles`; field names follow the RPC contract. */
export function entryToImportRow(
  entry: IntakeEntry,
  financial: boolean,
): Record<string, unknown> {
  const f = entry.fields;
  const row: Record<string, unknown> = {
    frame_number: (f.frame_number ?? "").trim().toUpperCase(),
    engine_number: (f.engine_number ?? "").trim().toUpperCase(),
    license_plate: (f.license_plate ?? "").trim().toUpperCase(),
    brand: (f.brand ?? "").trim(),
    model: (f.model ?? "").trim(),
    variant: (f.variant ?? "").trim(),
    color: (f.color ?? "").trim(),
    notes: (f.notes ?? "").trim(),
    supplier_name: (f.supplier_name ?? "").trim(),
    supplier_phone: (f.supplier_phone ?? "").trim(),
  };
  if (f.year) row.year = Number(f.year);
  if (f.odometer) row.odometer = Number(f.odometer);
  if (f.purchase_date) row.purchase_date = f.purchase_date;
  const asking = moneyOf(entry, "asking_price");
  if (typeof asking === "number") row.asking_price = asking;
  // The server rejects any row that carries purchase_price for a user without
  // financial rights, so the key is only present when it is allowed and filled.
  if (financial) {
    const purchase = moneyOf(entry, "purchase_price");
    if (typeof purchase === "number") row.purchase_price = purchase;
  }
  return row;
}

/** Draft for /acquisitions/new (single-vehicle form uses seller_* field names). */
export function entryToAcquisitionDraft(entry: IntakeEntry): Record<string, unknown> {
  const f = entry.fields;
  const draft: Record<string, unknown> = {
    frame_number: (f.frame_number ?? "").trim().toUpperCase(),
    engine_number: (f.engine_number ?? "").trim().toUpperCase(),
    license_plate: (f.license_plate ?? "").trim().toUpperCase(),
    brand: (f.brand ?? "").trim(),
    model: (f.model ?? "").trim(),
    variant: (f.variant ?? "").trim(),
    color: (f.color ?? "").trim(),
    seller_name: (f.supplier_name ?? "").trim(),
    seller_phone: (f.supplier_phone ?? "").trim(),
    notes: (f.notes ?? "").trim(),
  };
  if (f.year) draft.year = Number(f.year);
  if (f.odometer) draft.odometer = Number(f.odometer);
  if (f.purchase_date) draft.acquisition_date = f.purchase_date;
  return draft;
}
