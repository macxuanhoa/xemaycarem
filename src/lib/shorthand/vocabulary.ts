/**
 * Vocabulary for the shorthand vehicle-intake notes parser.
 * All lookups happen on `normalizeKey` output: lowercase, no diacritics,
 * `đ` → `d`, so "SH", "sh", "Đen", "den" all match the same entry.
 *
 * Hãng / Dòng xe / Phiên bản / Số máy / Số km / Giá bán dự kiến đã bị xoá
 * vĩnh viễn khỏi hồ sơ xe, nên tốc ký cũng không còn nhận các token đó.
 * Tốc ký giờ chỉ định danh xe bằng Biển số · Số khung và phân loại bằng
 * danh mục `vehicle_types` (xem VEHICLE_TYPE_ALIASES).
 */

import { UNCLASSIFIED_VEHICLE_TYPE } from "@/lib/vehicleDisplay";

export function normalizeKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/**
 * Hàng đợi "chưa phân loại" — dùng lại đúng một hằng số với tầng hiển thị
 * (`@/lib/vehicleDisplay`) để tốc ký, danh mục và mọi màn hình khớp nhau.
 * Hàng đợi này không bao giờ được tốc ký tự gán vào.
 */
export const UNCLASSIFIED_TYPE_NAME = UNCLASSIFIED_VEHICLE_TYPE;

/**
 * Danh mục loại xe mặc định (đúng 6 hàng mà migration `20261008000300` seed).
 * Bộ thật luôn lấy từ `list_vehicle_types`; danh sách này chỉ là dự phòng để
 * parser và unit test chạy được khi chưa gọi server.
 */
export const DEFAULT_VEHICLE_TYPE_NAMES = [
  "Xe số",
  "Xe tay ga",
  "Xe côn tay",
  "Xe điện",
  "Ga 50cc",
  UNCLASSIFIED_TYPE_NAME,
];

/**
 * Normalized shorthand (không dấu, bỏ khoảng trắng) → gợi ý tên loại xe.
 * Giá trị chỉ là GỢI Ý: parser chỉ chấp nhận khi tên đó có trong danh mục
 * đang hoạt động, nên chủ quán thêm/đổi tên loại xe không cần sửa code.
 */
export const VEHICLE_TYPE_ALIASES: Record<string, string> = {
  so: "Xe số",
  xeso: "Xe số",
  xs: "Xe số",
  cub: "Xe số",
  ga: "Xe tay ga",
  tayga: "Xe tay ga",
  xega: "Xe tay ga",
  xetayga: "Xe tay ga",
  auto: "Xe tay ga",
  contay: "Xe côn tay",
  xecontay: "Xe côn tay",
  con: "Xe côn tay",
  pk: "Xe côn tay",
  sport: "Xe côn tay",
  dien: "Xe điện",
  xediaen: "Xe điện",
  xedien: "Xe điện",
  ev: "Xe điện",
  accu: "Xe điện",
  ga50: "Ga 50cc",
  ga50cc: "Ga 50cc",
  "50cc": "Ga 50cc",
};

/** Tên loại xe dạng so khớp: không dấu, không khoảng trắng/ký tự nối. */
export function vehicleTypeKey(name: string): string {
  return normalizeKey(name).replace(/[^a-z0-9]/g, "");
}

/**
 * Tra tên loại xe THẬT trong danh mục đang dùng cho một token tốc ký.
 * Trả chuỗi rỗng khi không khớp: token đó chỉ thành chip lạ + Ghi chú, parser
 * không bao giờ tự bịa ra một loại xe ngoài danh mục (nhân viên phải chọn).
 */
export function matchVehicleType(
  token: string,
  catalogue: readonly string[] = DEFAULT_VEHICLE_TYPE_NAMES,
): string {
  const key = vehicleTypeKey(token);
  if (!key) return "";
  const candidates = catalogue.filter(
    (name) => vehicleTypeKey(name) !== vehicleTypeKey(UNCLASSIFIED_TYPE_NAME),
  );
  const direct = candidates.find((name) => vehicleTypeKey(name) === key);
  if (direct) return direct;
  const suggested = VEHICLE_TYPE_ALIASES[key];
  if (suggested) {
    const named = candidates.find(
      (name) => vehicleTypeKey(name) === vehicleTypeKey(suggested),
    );
    if (named) return named;
  }
  if (key.length < 3) return "";
  // Danh mục tự đặt: "Ga 50cc thể thao" vẫn chứa "ga50cc".
  const fuzzy = candidates.find((name) => {
    const nameKey = vehicleTypeKey(name);
    return (
      (nameKey.length >= 3 && nameKey.includes(key)) ||
      (key.length >= 4 && key.includes(nameKey))
    );
  });
  return fuzzy ?? "";
}

/** Normalized alias → canonical color. */
export const COLOR_ALIASES: Record<string, string> = {
  den: "Đen",
  trang: "Trắng",
  do: "Đỏ",
  dodon: "Đỏ đô",
  xanh: "Xanh",
  xanhla: "Xanh lá",
  xanhduong: "Xanh dương",
  nau: "Nâu",
  bac: "Bạc",
  xam: "Xám",
  vang: "Vàng",
  cam: "Cam",
  hong: "Hồng",
  tim: "Tím",
  kem: "Kem",
};

/**
 * Normalized keyword → field the NEXT token belongs to.
 * `notes` swallows the rest of the line.
 * Không còn khoá nào cho Hãng/Dòng/Phiên bản/Số máy/Số km/Giá bán: các token
 * đó rơi vào hàng đợi chip lạ để nhân viên gán vào Ghi chú hoặc bỏ qua.
 */
export const KEYWORD_FIELDS: Record<string, string> = {
  fk: "frame_number",
  khung: "frame_number",
  chassi: "frame_number",
  bs: "license_plate",
  bien: "license_plate",
  bienso: "license_plate",
  loai: "vehicle_type",
  loaixe: "vehicle_type",
  type: "vehicle_type",
  sdt: "supplier_phone",
  dt: "supplier_phone",
  phone: "supplier_phone",
  dienthoai: "supplier_phone",
  tel: "supplier_phone",
  gia: "price",
  giathu: "price",
  thu: "price",
  nam: "year",
  yr: "year",
  ngay: "purchase_date",
  date: "purchase_date",
  ten: "supplier_name",
  chu: "supplier_name",
  cua: "supplier_name",
  anh: "supplier_name",
  chi: "supplier_name",
  em: "supplier_name",
  fn: "supplier_name",
  ghcn: "notes",
  ghichu: "notes",
  note: "notes",
  notes: "notes",
};

/** Tokens that carry no field meaning and can be dropped silently. */
export const STOP_TOKENS = new Set([
  "va",
  "voi",
  "cung",
  "them",
  "co",
  "khong",
  "dc",
  "ok",
  "aloo",
  "alo",
  "ca",
  "nua",
]);
