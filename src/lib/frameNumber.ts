/**
 * Số khung — quy ước chuẩn hoá ĐỒNG NHẤT với database
 * (migration 20261009000200_smart_vehicle_duplicate_detection.sql).
 *
 * Máy chủ nén bằng `regexp_replace(upper(btrim(frame_number)), '[^A-Z0-9]', '', 'g')`
 * rồi lấy 5 ký tự cuối. Client phải mô phỏng đúng từng bước để:
 *   • suy ra loại dữ liệu (FULL = VIN đầy đủ ≥ 11 ký tự chữ+số, PARTIAL = mảnh rút gọn);
 *   • giữ nguyên số 0 đầu khi so khớp (so sánh kiểu text, KHÔNG ép thành số);
 *   * hiển thị cùng một chữ ký nghi trùng mà server sẽ thấy khi lưu.
 */

export type FrameInputKind = "FULL" | "PARTIAL";

/** Bỏ mọi ký tự không phải chữ/số, đổi hoa. Trả chuỗi rỗng khi trống. */
export function compactFrame(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 5 ký tự cuối của số khung đã nén (giữ số 0 đầu vì là text). Rỗng → null. */
export function frameLast5(raw: string | null | undefined): string | null {
  const compact = compactFrame(raw);
  return compact ? compact.slice(-5) : null;
}

/**
 * Suy ra loại dữ liệu từ chính chuỗi đã nén, khớp `private.frame_kind`:
 * rỗng hoặc ≥ 11 ký tự (chuẩn VIN) → FULL; ngắn hơn → PARTIAL.
 */
export function frameKindFromCompact(compact: string): FrameInputKind {
  if (!compact) return "FULL";
  return compact.length >= 11 ? "FULL" : "PARTIAL";
}

/** Suy ra loại dữ liệu trực tiếp từ số khung thô. */
export function frameKindFromFrame(raw: string | null | undefined): FrameInputKind {
  return frameKindFromCompact(compactFrame(raw));
}

/**
 * Lời giải tiếng Việt cho từng lý do máy chủ trả về
 * (private.detect_vehicle_duplicates). Giữ sát văn phong errors.ts để
 * nhân viên thấy cùng một thông điệp dù đọc từ card hay từ toast lỗi.
 */
export const DUPLICATE_REASON_COPY: Record<string, string> = {
  FULL_FRAME_MATCH:
    "Số khung đầy đủ này đã có trên một xe đang quản lý. Hãy mở hồ sơ hiện có thay vì tạo trùng.",
  PLATE_AND_LAST5:
    "Biển số và 5 ký tự cuối số khung trùng khớp một xe đang quản lý. Đây nhiều khả năng là cùng một xe.",
  NEED_VERIFY_PARTIAL_FULL:
    "Biển số trùng và 5 ký tự cuối khớp nhau, nhưng một bên lưu số khung đầy đủ, một bên chỉ lưu rút gọn. Hãy nhập đủ số khung hoặc mở hồ sơ để đối chiếu.",
  PARTIAL_MATCH:
    "Có xe tương tự (trùng biển số hoặc 5 ký tự cuối số khung). Kiểm tra danh sách trước khi lưu.",
};

export function duplicateReasonCopy(reason: string | null | undefined): string {
  if (!reason) return DUPLICATE_REASON_COPY.PARTIAL_MATCH;
  return DUPLICATE_REASON_COPY[reason] ?? DUPLICATE_REASON_COPY.PARTIAL_MATCH;
}
