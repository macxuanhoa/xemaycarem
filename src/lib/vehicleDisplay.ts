/**
 * Định danh xe — NGUỒN DUY NHẤT cho mọi màn hình, phiếu in, alt ảnh và
 * aria-label (kế hoạch "Xoá vĩnh viễn trường xe", giai đoạn 2).
 *
 * Quy ước đã chốt với chủ quán:
 *   • Tiêu đề   = Biển số · Số khung
 *   • Dòng phụ  = Loại xe · Đời xe · Màu sắc
 *
 * Không còn bất kỳ trường nào sau đây: Hãng, Dòng xe, Phiên bản, Số máy,
 * Số km đã đi, Giá bán dự kiến. Client không được tự nối chuỗi thô cho tên xe —
 * luôn gọi helper này để bản in, thông báo và tìm kiếm khớp nhau tuyệt đối.
 *
 * Các RPC đã trả sẵn `vehicle_title`/`vehicle_subtitle` (tính trong database bằng
 * private.vehicle_label_text / private.vehicle_subtitle_text). Khi có sẵn thì dùng
 * nguyên văn để không lệch một ký tự nào với server; chỉ tính lại khi màn hình
 * chỉ nắm dữ liệu thô (form đang soạn, bản nháp tốc ký, danh sách xe gần đây).
 */

import { displayFrame } from "@/lib/frameNumber";

/** Mọi object mô tả một xe đều khớp hình dạng này (Vehicle, Acquisition, Sale…). */
export type VehicleIdentity = {
  vehicle_title?: string | null;
  vehicle_subtitle?: string | null;
  license_plate?: string | null;
  frame_number?: string | null;
  internal_code?: string | null;
  vehicle_type?: string | null;
  year?: number | null;
  color?: string | null;
};

const SEPARATOR = " · ";

/** Cụm từ dự phòng khớp từng chữ với private.vehicle_label_text trong database. */
export const NO_FRAME_LABEL = "chưa có khung";
export const NO_PLATE_LABEL = "chưa có biển";
export const UNIDENTIFIED_LABEL = "xe không rõ danh tính";
/** Tên hàng đợi trong danh mục `vehicle_types` — nơi hiển thị thiếu loại xe dùng lại. */
export const UNCLASSIFIED_VEHICLE_TYPE = "Chưa phân loại";

const clean = (value?: string | null) => value?.trim() ?? "";

/** "Biển số · Số khung", có dự phòng khi thiếu một trong hai. */
export function vehicleTitle(vehicle?: VehicleIdentity | null): string {
  if (!vehicle) return UNIDENTIFIED_LABEL;
  const provided = clean(vehicle.vehicle_title);
  if (provided) return provided;
  const plate = clean(vehicle.license_plate);
  // Placeholder GEN-<uuid> server tự sinh khi thiếu khung KHÔNG được lộ ra —
  // hiển thị "chưa có khung" đúng như private.vehicle_label_text (migration 20261011000200).
  const frame = displayFrame(vehicle.frame_number);
  if (plate && frame) return `${plate}${SEPARATOR}${frame}`;
  if (plate) return `${plate}${SEPARATOR}${NO_FRAME_LABEL}`;
  if (frame) return `${NO_PLATE_LABEL}${SEPARATOR}${frame}`;
  return clean(vehicle.internal_code) || UNIDENTIFIED_LABEL;
}

/** "Loại xe · Đời xe · Màu sắc", bỏ qua phần trống. */
export function vehicleSubtitle(vehicle?: VehicleIdentity | null): string {
  if (!vehicle) return "";
  const provided = clean(vehicle.vehicle_subtitle);
  if (provided) return provided;
  return [
    clean(vehicle.vehicle_type),
    vehicle.year ? String(vehicle.year) : "",
    clean(vehicle.color),
  ]
    .filter(Boolean)
    .join(SEPARATOR);
}

/**
 * Chuyển một bản ghi chưa có kiểu (facts trả về từ copilot/ai-assist, dòng
 * global_search…) về đúng hình dạng danh tính xe. Chỉ lấy các khoá được phép,
 * nên dữ liệu thừa không thể lọt vào tiêu đề/dòng phụ.
 */
export function identityFromRecord(
  row: Record<string, unknown> | null | undefined,
): VehicleIdentity {
  const text = (key: string) =>
    typeof row?.[key] === "string" ? (row[key] as string) : undefined;
  return {
    vehicle_title: text("vehicle_title"),
    vehicle_subtitle: text("vehicle_subtitle"),
    license_plate: text("license_plate"),
    frame_number: text("frame_number"),
    internal_code: text("internal_code"),
    vehicle_type: text("vehicle_type"),
    year: typeof row?.year === "number" ? (row.year as number) : null,
    color: text("color"),
  };
}

/** Văn bản đọc được cho công nghệ hỗ trợ: tiêu đề, rồi dòng phụ nếu có. */
export function vehicleAriaLabel(vehicle?: VehicleIdentity | null): string {
  const title = vehicleTitle(vehicle);
  const subtitle = vehicleSubtitle(vehicle);
  return subtitle ? `${title} — ${subtitle}` : title;
}

/** So khớp mờ theo danh tính mới (biển · khung · mã xe · loại · đời · màu). */
export function matchesVehicleIdentity(
  vehicle: VehicleIdentity | null | undefined,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (!vehicle) return false;
  return [
    vehicleTitle(vehicle),
    vehicleSubtitle(vehicle),
    clean(vehicle.internal_code),
    vehicle.year ? String(vehicle.year) : "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
