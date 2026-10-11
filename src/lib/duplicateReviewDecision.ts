import type { DuplicateLevel } from "./vehicleDuplicateCheck";
import type { Role } from "@/types";

/**
 * Mô-đun quyết định THUẦN (không React, không gọi mạng) cho hành động khi lưu/sửa
 * xe gặp tín hiệu nghi trùng. Ánh xạ đúng quy tắc server đã chốt ở migration
 * 20261011000400 để UI và RPC không bao giờ lệch nhau:
 *
 *  - GREEN                          → cho phép lưu bình thường.
 *  - YELLOW (chưa ack)              → bắt nhân viên tích xác nhận rồi mới lưu.
 *  - RED · FULL_FRAME_MATCH          → CHẶN TUYỆT ĐỐI với mọi vai trò (kể cả Chủ):
 *                                     đây là trùng danh tính số khung đầy đủ, không
 *                                     có đường vòng, không được gửi yêu cầu duyệt.
 *  - RED · PLATE_AND_LAST5           → nghi trùng theo biển số + 5 ký tự cuối:
 *                                       · STAFF   không lưu được, phải GỬI YÊU CẦU
 *                                         xác minh (không tạo xe trước khi duyệt);
 *                                       · OWNER/MANAGER được TRỰC TIẾP LƯU NGOẠI LỆ
 *                                         kèm lý do và đã mở hồ sơ đối chiếu.
 *
 * fail-closed: RED với lý do lạ (không phải hai mã trên) bị chặn cứng, không cho
 * gửi yêu cầu, để không bao giờ mở đường ghi ngoài ý muốn.
 */
export type DuplicateAction =
  | { kind: "allow-save" }
  | { kind: "require-ack" }
  | { kind: "hard-block" }
  | { kind: "request-review" }
  | { kind: "override-save" };

/** Chủ/Quản lý đặc quyền được lưu ngoại lệ; Nhân viên thì không. */
export const isPrivilegedRole = (role: Role): boolean =>
  role === "OWNER" || role === "MANAGER";

export type DuplicateActionInput = {
  level: DuplicateLevel;
  /** Chữ ký lý do từ engine: FULL_FRAME_MATCH | PLATE_AND_LAST5 |
   *  NEED_VERIFY_PARTIAL_FULL | PARTIAL_MATCH | "" (GREEN). */
  reason: string;
  role: Role;
  /** Nhân viên đã tích ô xác nhận cho mức YELLOW hay chưa. */
  acknowledged?: boolean;
};

export function decideDuplicateAction(input: DuplicateActionInput): DuplicateAction {
  const { level, reason, role, acknowledged = false } = input;

  if (level === "GREEN") return { kind: "allow-save" };

  if (level === "YELLOW") {
    return acknowledged ? { kind: "allow-save" } : { kind: "require-ack" };
  }

  // RED: chỉ hai lý do được server phát ra mới có đường xử lý.
  if (reason === "FULL_FRAME_MATCH") return { kind: "hard-block" };
  if (reason === "PLATE_AND_LAST5") {
    return isPrivilegedRole(role) ? { kind: "override-save" } : { kind: "request-review" };
  }

  // RED lý do không nhận diện được → chặn cứng (fail-closed).
  return { kind: "hard-block" };
}

/** True khi nút Lưu phải bị khóa ở trạng thái hiện tại (chưa ack / đang nghi trùng). */
export function isSaveBlocked(action: DuplicateAction): boolean {
  return (
    action.kind === "require-ack" ||
    action.kind === "hard-block" ||
    action.kind === "request-review"
  );
}
