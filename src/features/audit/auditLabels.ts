/**
 * Human-readable rendering helpers for the operation history (audit log).
 *
 * The raw `audit_logs` rows store machine snapshots: DB column names, enum
 * tokens (IN_STOCK), booleans, ISO timestamps and UUIDs. Staff reading this
 * page are not developers, so every value is translated into plain Vietnamese
 * — "Cà Rem đã tạo thông báo mới · Tiêu đề: Lịch nghỉ lễ" instead of a JSON
 * blob. The untouched snapshots stay available behind a collapsed "raw" panel
 * for forensic use.
 */
import { dateLabel, money } from "@/lib/format";
import { identityFromRecord, vehicleTitle } from "@/lib/vehicleDisplay";

/** Columns that are noise to a human reader (UUIDs, bookkeeping timestamps). */
const SKIP_KEYS = new Set([
  "id",
  "entity_id",
  "user_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "deleted_at",
]);
/** Storage paths / linked UUID columns that read as gibberish. */
const SKIP_SUFFIXES = ["_id", "_path", "_paths", "_url", "_token"];

/** Fields whose numeric value is an amount of Vietnamese đồng. */
const MONEY_KEYS = new Set([
  "purchase_price",
  "amount",
  "paid_amount",
  "remaining_amount",
  "sale_price",
  "total_cost",
  "expense_total",
  "gross_profit",
]);

/** Fields whose value is an enum token that should be looked up / de-cased. */
const ENUM_KEYS = new Set([
  "status",
  "type",
  "audience",
  "display_mode",
  "role",
  "payment_method",
  "method",
  "expense_type",
  "document_type",
  "side",
]);

export const entityTypeLabels: Record<string, string> = {
  vehicles: "xe",
  sales: "giao dịch bán",
  payments: "khoản thu tiền",
  expenses: "chi phí",
  acquisitions: "phiếu thu xe",
  system_announcements: "thông báo",
  message_outbox: "tin nhắn tự động",
  system_settings: "cài đặt hệ thống",
  identity_documents: "hồ sơ CCCD",
  profiles: "tài khoản nhân sự",
  showroom_leads: "khách tham quan",
  vehicle_types: "loại xe",
};

/** Short noun shown on the coloured chip in the collapsed header. */
export const auditActionChips: Record<string, string> = {
  CREATE_ACQUISITION: "Thu xe vào kho",
  CANCEL_ACQUISITION: "Hủy thu xe",
  CREATE_VEHICLE: "Nhập xe vào kho",
  UPDATE_VEHICLE: "Cập nhật xe",
  ADD_EXPENSE: "Thêm chi phí",
  CREATE_EXPENSE: "Thêm chi phí",
  UPDATE_EXPENSE: "Cập nhật chi phí",
  CANCEL_EXPENSE: "Hủy chi phí",
  CREATE_SALE: "Bán xe",
  CANCEL_SALE: "Hủy giao dịch bán",
  REQUEST_SALE_BELOW_COST: "Xin bán dưới giá thu",
  APPROVE_SALE_BELOW_COST: "Duyệt bán dưới giá thu",
  REJECT_SALE_BELOW_COST: "Từ chối bán dưới giá thu",
  CANCEL_SALE_BELOW_COST: "Rút yêu cầu bán dưới giá thu",
  CREATE_PAYMENT: "Ghi nhận thanh toán",
  ADD_PAYMENT: "Ghi nhận thanh toán",
  VOID_PAYMENT: "Hoàn thanh toán",
  ADD_IMAGE: "Thêm ảnh xe",
  REMOVE_IMAGE: "Gỡ ảnh xe",
  ANNOUNCEMENT_CREATE: "Tạo thông báo",
  ANNOUNCEMENT_UPDATE: "Cập nhật thông báo",
  ANNOUNCEMENT_DELETE: "Xóa thông báo",
  MESSAGE_SENT: "Gửi tin nhắn",
  MESSAGE_SKIPPED: "Bỏ qua tin nhắn",
  MESSAGE_MANUALLY_RETRIED: "Gửi lại tin nhắn",
  MESSAGE_SETTING_CHANGED: "Đổi cài đặt tin nhắn",
  SAVE_IDENTITY_DOCUMENT: "Lưu hồ sơ CCCD",
  ADD_IDENTITY_DOCUMENT_IMAGE: "Thêm ảnh CCCD",
  REMOVE_IDENTITY_DOCUMENT_IMAGE: "Xóa ảnh CCCD",
  COMPLETE_PASSWORD_CHANGE: "Đổi mật khẩu",
  FORCE_PASSWORD_CHANGE: "Yêu cầu đổi mật khẩu",
  TRANSFER_OWNER: "Chuyển quyền chủ cửa hàng",
  UPDATE_SHOWROOM_LEAD_STATUS: "Cập nhật khách tham quan",
  CREATE_VEHICLE_TYPE: "Thêm loại xe",
  UPDATE_VEHICLE_TYPE: "Đổi tên loại xe",
  DELETE_VEHICLE_TYPE: "Xóa loại xe",
};

/** Verb phrase used in the plain-language sentence "{actor} đã ...". */
export const auditActionPhrases: Record<string, string> = {
  CREATE_ACQUISITION: "đã thu một xe vào kho",
  CANCEL_ACQUISITION: "đã hủy phiếu thu xe",
  CREATE_VEHICLE: "đã nhập một xe vào kho",
  UPDATE_VEHICLE: "đã cập nhật thông tin xe",
  ADD_EXPENSE: "đã thêm chi phí",
  CREATE_EXPENSE: "đã thêm chi phí",
  UPDATE_EXPENSE: "đã cập nhật chi phí",
  CANCEL_EXPENSE: "đã hủy chi phí",
  CREATE_SALE: "đã bán xe",
  CANCEL_SALE: "đã hủy một giao dịch bán",
  REQUEST_SALE_BELOW_COST: "đã gửi yêu cầu bán xe dưới giá thu",
  APPROVE_SALE_BELOW_COST: "đã phê duyệt bán xe dưới giá thu",
  REJECT_SALE_BELOW_COST: "đã từ chối yêu cầu bán xe dưới giá thu",
  CANCEL_SALE_BELOW_COST: "đã rút yêu cầu bán xe dưới giá thu",
  CREATE_PAYMENT: "đã ghi nhận một khoản thu",
  ADD_PAYMENT: "đã ghi nhận một khoản thu",
  VOID_PAYMENT: "đã hoàn lại một khoản thu",
  ADD_IMAGE: "đã thêm ảnh cho xe",
  REMOVE_IMAGE: "đã gỡ ảnh khỏi xe",
  ANNOUNCEMENT_CREATE: "đã tạo thông báo mới",
  ANNOUNCEMENT_UPDATE: "đã cập nhật thông báo",
  ANNOUNCEMENT_DELETE: "đã xóa thông báo",
  MESSAGE_SENT: "đã gửi tin nhắn cho khách",
  MESSAGE_SKIPPED: "đã bỏ qua một tin nhắn",
  MESSAGE_MANUALLY_RETRIED: "đã gửi lại tin nhắn cho khách",
  MESSAGE_SETTING_CHANGED: "đã thay đổi cài đặt tin nhắn",
  SAVE_IDENTITY_DOCUMENT: "đã lưu hồ sơ CCCD",
  ADD_IDENTITY_DOCUMENT_IMAGE: "đã thêm ảnh CCCD",
  REMOVE_IDENTITY_DOCUMENT_IMAGE: "đã xóa ảnh CCCD",
  COMPLETE_PASSWORD_CHANGE: "đã đổi mật khẩu tài khoản",
  FORCE_PASSWORD_CHANGE: "đã yêu cầu đổi mật khẩu",
  TRANSFER_OWNER: "đã chuyển quyền chủ cửa hàng",
  UPDATE_SHOWROOM_LEAD_STATUS: "đã cập nhật trạng thái khách tham quan",
  CREATE_VEHICLE_TYPE: "đã thêm một loại xe vào danh mục",
  UPDATE_VEHICLE_TYPE: "đã đổi tên một loại xe trong danh mục",
  DELETE_VEHICLE_TYPE: "đã xóa một loại xe khỏi danh mục",
};

export const auditFieldLabels: Record<string, string> = {
  // Vehicle / acquisition. Hãng, Dòng, Phiên bản, Số máy, Số km và Giá bán dự
  // kiến đã bị gỡ vĩnh viễn khỏi hồ sơ xe nên không còn nhãn tương ứng.
  vehicle_type: "Loại xe",
  year: "Năm sản xuất",
  color: "Màu sắc",
  license_plate: "Biển số",
  frame_number: "Số khung",
  purchase_date: "Ngày thu",
  purchase_price: "Giá thu",
  supplier_name: "Người bán",
  supplier_phone: "SĐT người bán",
  notes: "Ghi chú",
  status: "Trạng thái",
  internal_code: "Mã nội bộ",
  total_cost: "Tổng giá vốn",
  expense_total: "Tổng chi phí",
  cost_pending: "Chờ bổ sung giá nhập",
  // Sale / payment
  sale_code: "Mã giao dịch",
  sale_date: "Ngày bán",
  sale_price: "Giá bán",
  customer_name: "Khách hàng",
  customer_phone: "SĐT khách hàng",
  paid_amount: "Đã thu",
  remaining_amount: "Còn phải thu",
  payment_method: "Hình thức thanh toán",
  gross_profit: "Lợi nhuận gộp",
  // Expense
  amount: "Số tiền",
  expense_type: "Loại chi phí",
  category: "Nhóm chi phí",
  description: "Nội dung",
  expense_date: "Ngày chi",
  // Announcement / message
  title: "Tiêu đề",
  message: "Nội dung",
  type: "Loại",
  audience: "Đối tượng nhận",
  is_active: "Đang bật",
  display_mode: "Kiểu hiển thị",
  dismissible: "Cho phép ẩn",
  starts_at: "Hiển thị từ",
  ends_at: "Hiển thị đến",
  provider: "Nhà cung cấp",
  error_code: "Mã lỗi",
  last_error_code: "Mã lỗi gần nhất",
  // Profile / staff
  role: "Phân quyền",
  full_name: "Họ tên",
  username: "Tên đăng nhập",
  active: "Đang hoạt động",
  can_view_financials: "Được xem số liệu",
  must_change_password: "Buộc đổi mật khẩu",
  disabled_until: "Tạm khóa đến",
  allowed_from: "Cho phép từ",
  allowed_until: "Cho phép đến",
  working_days: "Ngày làm việc",
  // Identity documents
  document_type: "Loại giấy tờ",
  side: "Mặt giấy tờ",
};

/** Enum tokens rendered as natural Vietnamese. */
export const auditValueLabels: Record<string, string> = {
  IN_STOCK: "Còn trong kho",
  RESERVED: "Đã giữ chỗ",
  SOLD: "Đã bán",
  CANCELLED: "Đã hủy",
  ACTIVE: "Đang hoạt động",
  COMPLETED: "Hoàn tất",
  PENDING: "Đang chờ",
  PAID: "Đã thu đủ",
  PARTIAL: "Thu một phần",
  UNPAID: "Chưa thu",
  OVERDUE: "Quá hạn",
  INFO: "Thông tin",
  WARNING: "Cảnh báo",
  SUCCESS: "Thành công",
  ERROR: "Lỗi",
  ALL: "Tất cả mọi người",
  STAFF: "Nhân viên",
  MANAGER: "Quản lý",
  OWNER: "Chủ cửa hàng",
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  OTHER: "Khác",
  STATIC: "Cố định",
  MARQUEE: "Chạy chữ",
  REPAIR: "Sửa chữa",
  TRANSPORT: "Vận chuyển",
  PAPERWORK: "Giấy tờ",
  PARTS: "Phụ tùng",
  CLEANING: "Vệ sinh",
  INSPECTION: "Kiểm định",
  RENT: "Mặt bằng",
  ELECTRICITY: "Điện nước",
  SALARY: "Lương",
  MARKETING: "Quảng cáo",
  OFFICE: "Văn phòng",
  FRONT: "Mặt trước",
  BACK: "Mặt sau",
  CCCD: "Căn cước công dân",
  SENT: "Đã gửi",
  SKIPPED: "Đã bỏ qua",
  FAILED: "Thất bại",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  return (
    dateLabel(value) +
    " " +
    date.toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh",
    })
  );
}

function isSkipped(key: string): boolean {
  if (SKIP_KEYS.has(key)) return true;
  return SKIP_SUFFIXES.some((s) => key.endsWith(s));
}

/** Turn any stored value into plain Vietnamese. */
export function formatAuditValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "trống";
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (typeof value === "number") {
    if (MONEY_KEYS.has(key)) return money(value);
    return new Intl.NumberFormat("vi-VN").format(value);
  }
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) return dateLabel(value);
    if (ISO_DATETIME.test(value)) return formatDateTime(value);
    if (ENUM_KEYS.has(key) || /^[A-Z][A-Z0-9_]*$/.test(value)) {
      return auditValueLabels[value] ?? humanizeKey(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.length) return "trống";
    return value.map((item) => formatAuditValue(key, item)).join(", ");
  }
  if (typeof value === "object") {
    // Nested objects are rare; fall back to a compact single-line form.
    return JSON.stringify(value);
  }
  return String(value);
}

export function fieldLabel(key: string): string {
  return auditFieldLabels[key] ?? humanizeKey(key);
}

export function entityLabel(type?: string): string {
  if (!type) return "bản ghi";
  return entityTypeLabels[type] ?? humanizeKey(type).toLowerCase();
}

export function actionChip(action: string): string {
  return auditActionChips[action] ?? humanizeKey(action);
}

/** The plain-language sentence describing who did what. The mapped phrases
 *  already name the object (…một xe vào kho, …thông báo mới), so the entity
 *  type is intentionally not appended — the summary line shows it separately. */
export function describeAction(action: string, actor: string): string {
  const phrase =
    auditActionPhrases[action] ??
    "đã " + humanizeKey(action).toLowerCase();
  return `${actor} ${phrase}`;
}

/** Keys worth surfacing when a record is created or removed (no diff to show). */
export function summarizeFields(
  data: Record<string, unknown> | null | undefined,
  limit = 6,
): { key: string; value: string }[] {
  if (!data || typeof data !== "object") return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (isSkipped(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    out.push({ key: fieldLabel(key), value: formatAuditValue(key, value) });
    if (out.length >= limit) break;
  }
  return out;
}

/** The fields that actually changed between two snapshots. */
export function changedFields(
  oldData: Record<string, unknown> | null | undefined,
  newData: Record<string, unknown> | null | undefined,
): { label: string; old: string; next: string }[] {
  if (!oldData || !newData) return [];
  const keys = Array.from(
    new Set([...Object.keys(oldData), ...Object.keys(newData)]),
  ).filter((k) => !isSkipped(k));
  return keys
    .filter((k) => JSON.stringify(oldData[k]) !== JSON.stringify(newData[k]))
    .map((k) => ({
      label: fieldLabel(k),
      old: formatAuditValue(k, oldData[k] ?? null),
      next: formatAuditValue(k, newData[k] ?? null),
    }));
}

/** A short human identifier for the record (title, name, plate, code…). */
export function recordSubject(
  data: Record<string, unknown> | null | undefined,
): string {
  if (!data || typeof data !== "object") return "";
  const prefer = [
    "title",
    "description",
    "full_name",
    "customer_name",
    "supplier_name",
    "license_plate",
    "frame_number",
    "vehicle_type",
    "sale_code",
    "internal_code",
    "name",
  ];
  for (const key of prefer) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) {
      // Biển số luôn đi kèm số khung: xe được đọc bằng đúng danh tính
      // biển · khung dùng ở mọi màn hình, không còn Hãng + Dòng như trước.
      if (key === "license_plate" || key === "frame_number") {
        return vehicleTitle(identityFromRecord(data));
      }
      return v.trim();
    }
  }
  return "";
}
