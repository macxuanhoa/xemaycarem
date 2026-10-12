/**
 * Converts reviewed shorthand entries into the exact payload shape that
 * `import_vehicles` expects, with the same checks mirrored client-side so
 * the user sees problems per card before anything is sent to the server.
 *
 * Hãng / Dòng xe / Phiên bản / Số máy / Số km / Giá bán dự kiến không còn trong
 * hợp đồng nữa. "Loại xe" nay là TÊN MẪU XE nhập tự do: mọi dòng chỉ cần có
 * `vehicle_type` (tên thô); server chuẩn hoá và get-or-create khi lưu.
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
import { compactFrame, frameKindFromCompact } from "@/lib/frameNumber";

const MAX_PLATE = 30;
const MAX_FRAME = 100;

function moneyOf(entry: IntakeEntry, field: IntakeFieldKey): number | null | "invalid" {
  const raw = entry.fields[field];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = parseShorthandMoney(raw);
  return parsed === null ? "invalid" : parsed;
}

/**
 * Vietnamese error message theo từng trường của một entry; rỗng nghĩa là
 * sẵn sàng nhập kho. Trang tốc ký gắn thẳng message vào ô nhập tương ứng
 * thay vì dồn danh sách cảnh báo cuối thẻ. Chỉ Loại xe và Giá thu bắt buộc.
 */
export function validateIntakeEntry(
  entry: IntakeEntry,
): Partial<Record<IntakeFieldKey, string>> {
  const errors: Partial<Record<IntakeFieldKey, string>> = {};
  const fail = (field: IntakeFieldKey, message: string) => {
    errors[field] ??= message;
  };
  const f = entry.fields;
  // Loại xe là tên tự do, bắt buộc có; server sẽ tạo loại mới khi lưu nên
  // không còn đối chiếu danh mục ở bước validate tốc ký.
  if (!(f.vehicle_type ?? "").trim()) fail("vehicle_type", "Nhập loại / dòng xe.");
  // Số khung không còn bắt buộc — server sinh placeholder "GEN-…" khi trống.
  if (f.frame_number && f.frame_number.trim().length > MAX_FRAME)
    fail("frame_number", `Số khung tối đa ${MAX_FRAME} ký tự.`);
  // Mảnh rút gọn (dưới 11 ký tự chữ+số) phải đủ 5 ký tự để còn so khớp nghi trùng.
  const frameCompact = compactFrame(f.frame_number ?? "");
  if (
    frameCompact &&
    frameKindFromCompact(frameCompact) === "PARTIAL" &&
    frameCompact.length < 5
  )
    fail("frame_number", "Số khung rút gọn cần đủ 5 ký tự (chữ hoặc số).");
  // Biển số không bắt buộc, nhưng nếu có thì phải đúng format xe máy VN —
  // tránh nhập bậy vẫn được nhận. Rỗng/whitespace luôn hợp lệ.
  const plate = (f.license_plate ?? "").trim();
  if (plate.length > MAX_PLATE) fail("license_plate", `Biển số tối đa ${MAX_PLATE} ký tự.`);
  else if (!isValidMotorbikePlate(plate)) fail("license_plate", PLATE_INVALID_MESSAGE);
  if (f.year) {
    const year = normalizeVehicleYear(f.year);
    if (year == null || year < 1900 || year > 2100)
      fail("year", "Năm sản xuất phải từ 1900 đến 2100.");
  }
  if (f.purchase_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.purchase_date))
      fail("purchase_date", "Ngày thu không hợp lệ (định dạng dd/mm/yyyy).");
    else if (f.purchase_date > today())
      fail("purchase_date", "Ngày thu không được ở tương lai.");
  }
  // Giá thu bắt buộc với MỌI role ngay khi đưa xe vào kho (server cũng chặn
  // PURCHASE_PRICE_REQUIRED), nhờ đó hồ sơ xe luôn có giá vốn từ đầu.
  const purchase = moneyOf(entry, "purchase_price");
  if (purchase === null) fail("purchase_price", "Nhập giá thu xe (vd: 18tr5).");
  else if (purchase === "invalid") fail("purchase_price", "Giá thu không hợp lệ (vd: 18tr5).");
  else if (purchase <= 0) fail("purchase_price", "Giá thu phải lớn hơn 0.");
  if ((f.supplier_name ?? "").length > 200) fail("supplier_name", "Tên người bán quá dài.");
  if ((f.supplier_phone ?? "").length > 40) fail("supplier_phone", "SĐT người bán quá dài.");
  return errors;
}

/**
 * Payload row for `import_vehicles`; field names follow the RPC contract.
 * Không có `brand`/`model`/`variant`/`engine_number`/`odometer`/`asking_price`
 * — các key đó đã bị server từ chối lẫn cột DB đã bị xoá.
 */
export function entryToImportRow(entry: IntakeEntry): Record<string, unknown> {
  const f = entry.fields;
  const frame = (f.frame_number ?? "").trim().toUpperCase();
  const row: Record<string, unknown> = {
    frame_number: frame,
    license_plate: canonicalizePlate(f.license_plate ?? ""),
    vehicle_type: (f.vehicle_type ?? "").trim(),
    color: (f.color ?? "").trim(),
    notes: (f.notes ?? "").trim(),
    supplier_name: (f.supplier_name ?? "").trim(),
    supplier_phone: (f.supplier_phone ?? "").trim(),
  };
  if (f.year) row.year = normalizeVehicleYear(f.year) ?? Number(f.year);
  if (f.purchase_date) row.purchase_date = f.purchase_date;
  // Giá thu luôn được gửi cùng hồ sơ thu xe — mọi role đều nhập được giá này.
  const purchase = moneyOf(entry, "purchase_price");
  if (typeof purchase === "number") row.purchase_price = purchase;
  return row;
}
