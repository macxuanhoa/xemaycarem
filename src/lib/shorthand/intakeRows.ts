/**
 * Converts reviewed shorthand entries into the exact payload shape that
 * `import_vehicles` expects, with the same checks mirrored client-side so
 * the user sees problems per card before anything is sent to the server.
 *
 * Hãng / Dòng xe / Phiên bản / Số máy / Số km / Giá bán dự kiến không còn trong
 * hợp đồng nữa; đổi lại mọi dòng phải có `vehicle_type_id` — một phần tử của
 * danh mục `vehicle_types`, không phải tên tự gõ.
 */
import type { IntakeEntry, IntakeFieldKey } from "./parseIntakeNotes";
import { parseShorthandMoney } from "./parseIntakeNotes";
import { today } from "@/lib/format";
import {
  canonicalizePlate,
  isValidMotorbikePlate,
  PLATE_INVALID_MESSAGE,
} from "@/lib/plate";
import { normalizeVehicleYear } from "@/lib/vehicleInputFormatting";
import { vehicleTypeKey } from "@/lib/shorthand/vocabulary";
import { compactFrame, frameKindFromCompact } from "@/lib/frameNumber";
import type { VehicleTypeItem } from "@/types";

const MAX_PLATE = 30;
const MAX_FRAME = 100;

/** Tên loại xe (do tốc ký nhận ra) → id trong danh mục đang dùng. */
export function vehicleTypeIdFor(
  name: string | undefined,
  vehicleTypes: readonly VehicleTypeItem[],
): string {
  const key = vehicleTypeKey(name ?? "");
  if (!key) return "";
  return vehicleTypes.find((item) => vehicleTypeKey(item.name) === key)?.id ?? "";
}

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
  vehicleTypes: readonly VehicleTypeItem[] = [],
): string[] {
  const errors: string[] = [];
  const f = entry.fields;
  // Loại xe là bắt buộc khi tạo hồ sơ (server cũng chặn VEHICLE_TYPE_REQUIRED),
  // nên nhân viên phải chọn từ danh mục ngay trên thẻ tốc ký.
  if (!vehicleTypeIdFor(f.vehicle_type, vehicleTypes))
    errors.push("Chọn loại xe từ danh mục.");
  // Số khung không còn bắt buộc — server sinh placeholder "GEN-…" khi trống.
  if (f.frame_number && f.frame_number.trim().length > MAX_FRAME)
    errors.push(`Số khung tối đa ${MAX_FRAME} ký tự.`);
  // Mảnh rút gọn (dưới 11 ký tự chữ+số) phải đủ 5 ký tự để còn so khớp nghi trùng.
  const frameCompact = compactFrame(f.frame_number ?? "");
  if (
    frameCompact &&
    frameKindFromCompact(frameCompact) === "PARTIAL" &&
    frameCompact.length < 5
  )
    errors.push("Số khung rút gọn cần đủ 5 ký tự (chữ hoặc số).");
  // Biển số không bắt buộc, nhưng nếu có thì phải đúng format xe máy VN —
  // tránh nhập bậy vẫn được nhận. Rỗng/whitespace luôn hợp lệ.
  const plate = (f.license_plate ?? "").trim();
  if (plate.length > MAX_PLATE) errors.push(`Biển số tối đa ${MAX_PLATE} ký tự.`);
  else if (!isValidMotorbikePlate(plate)) errors.push(PLATE_INVALID_MESSAGE);
  if (f.year) {
    const year = normalizeVehicleYear(f.year);
    if (year == null || year < 1900 || year > 2100)
      errors.push("Năm sản xuất phải từ 1900 đến 2100.");
  }
  if (f.purchase_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.purchase_date))
      errors.push("Ngày thu không hợp lệ (định dạng dd/mm/yyyy).");
    else if (f.purchase_date > today())
      errors.push("Ngày thu không được ở tương lai.");
  }
  const purchase = moneyOf(entry, "purchase_price");
  if (financial && purchase === "invalid")
    errors.push("Giá thu không hợp lệ (vd: 18tr5).");
  if ((f.supplier_name ?? "").length > 200) errors.push("Tên người bán quá dài.");
  if ((f.supplier_phone ?? "").length > 40) errors.push("SĐT người bán quá dài.");
  if ((f.notes ?? "").length > 10_000) errors.push("Ghi chú quá dài.");
  return errors;
}

/**
 * Payload row for `import_vehicles`; field names follow the RPC contract.
 * Không có `brand`/`model`/`variant`/`engine_number`/`odometer`/`asking_price`
 * — các key đó đã bị server từ chối lẫn cột DB đã bị xoá.
 */
export function entryToImportRow(
  entry: IntakeEntry,
  financial: boolean,
  vehicleTypes: readonly VehicleTypeItem[] = [],
): Record<string, unknown> {
  const f = entry.fields;
  const frame = (f.frame_number ?? "").trim().toUpperCase();
  const row: Record<string, unknown> = {
    frame_number: frame,
    frame_input_kind: frameKindFromCompact(compactFrame(frame)),
    license_plate: canonicalizePlate(f.license_plate ?? ""),
    vehicle_type_id: vehicleTypeIdFor(f.vehicle_type, vehicleTypes),
    color: (f.color ?? "").trim(),
    notes: (f.notes ?? "").trim(),
    supplier_name: (f.supplier_name ?? "").trim(),
    supplier_phone: (f.supplier_phone ?? "").trim(),
  };
  if (f.year) row.year = normalizeVehicleYear(f.year) ?? Number(f.year);
  if (f.purchase_date) row.purchase_date = f.purchase_date;
  // The server rejects any row that carries purchase_price for a user without
  // financial rights, so the key is only present when it is allowed and filled.
  if (financial) {
    const purchase = moneyOf(entry, "purchase_price");
    if (typeof purchase === "number") row.purchase_price = purchase;
  }
  return row;
}

/** Draft for /acquisitions/new (single-vehicle form uses seller_* field names). */
export function entryToAcquisitionDraft(
  entry: IntakeEntry,
  vehicleTypes: readonly VehicleTypeItem[] = [],
): Record<string, unknown> {
  const f = entry.fields;
  const frame = (f.frame_number ?? "").trim().toUpperCase();
  const draft: Record<string, unknown> = {
    frame_number: frame,
    frame_input_kind: frameKindFromCompact(compactFrame(frame)),
    license_plate: canonicalizePlate(f.license_plate ?? ""),
    vehicle_type_id: vehicleTypeIdFor(f.vehicle_type, vehicleTypes),
    color: (f.color ?? "").trim(),
    seller_name: (f.supplier_name ?? "").trim(),
    seller_phone: (f.supplier_phone ?? "").trim(),
    notes: (f.notes ?? "").trim(),
  };
  if (f.year) draft.year = normalizeVehicleYear(f.year) ?? Number(f.year);
  if (f.purchase_date) draft.acquisition_date = f.purchase_date;
  return draft;
}
