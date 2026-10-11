import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";
import { vehicleTitle } from "@/lib/vehicleDisplay";
import { duplicateReasonCopy, type FrameInputKind } from "@/lib/frameNumber";
import { decideDuplicateAction } from "@/lib/duplicateReviewDecision";
import type { DuplicateCheckResult } from "@/lib/vehicleDuplicateCheck";
import type { Role } from "@/types";

/**
 * Ô số khung CHỈ có một và hệ thống TỰ phân loại: FULL (VIN đầy đủ ≥ 11 ký tự,
 * giữ danh tính cứng UNIQUE) hay PARTIAL (mảnh 5 ký tự cuối, chỉ nghi trùng).
 * Nhân viên KHÔNG chọn tay nữa — server là nguồn quyết định duy nhất
 * (`private.frame_kind`), dòng chữ này chỉ để nhân viên hiểu mức cảnh báo sẽ ra.
 */
export function FrameKindHint({ kind }: { kind: FrameInputKind }) {
  return (
    <span className="frame-kind-detected muted small">
      Nhận diện:{" "}
      {kind === "FULL"
        ? "số khung đầy đủ (chặn trùng tuyệt đối)"
        : "5 ký tự cuối (rút gọn · chỉ báo nghi trùng)"}
    </span>
  );
}

type CandidateRow = DuplicateCheckResult["candidates"][number];

function CandidateList({ candidates }: { candidates: CandidateRow[] }) {
  return (
    <ul className="duplicate-candidate-list">
      {candidates.map((candidate) => (
        <li key={candidate.id} className="duplicate-candidate">
          <div className="duplicate-candidate-main">
            <strong>{vehicleTitle(candidate)}</strong>
            <span className="muted small">
              {candidate.internal_code} ·{" "}
              {candidate.frame_input_kind === "PARTIAL"
                ? "khung rút gọn"
                : "khung đầy đủ"}{" "}
              · {STATUS_LABEL[candidate.status] ?? candidate.status}
            </span>
          </div>
          <Link to={`/vehicles/${candidate.id}`} className="text-link">
            Mở hồ sơ
          </Link>
        </li>
      ))}
    </ul>
  );
}

const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "đang chờ bán",
  RESERVED: "đã giữ chỗ",
  SOLD: "đã bán",
  CANCELLED: "đã hủy",
};

/**
 * Khối phản hồi ba mức ngay dưới ô số khung. Đọc kết quả từ
 * `useVehicleDuplicateCheck`; server tái-kiểm tra khi nên đây chỉ là xem trước.
 */
export function DuplicateInspector({
  checking,
  error,
  result,
  hasSignal,
  acknowledged,
  role,
  onAcknowledge,
  onRetry,
}: {
  checking: boolean;
  error: boolean;
  result?: DuplicateCheckResult;
  hasSignal: boolean;
  acknowledged: boolean;
  role: Role;
  onAcknowledge: (value: boolean) => void;
  onRetry?: () => void;
}) {
  if (checking && hasSignal) {
    return (
      <span className="inline-check-feedback muted">
        <LoaderCircle size={13} className="spin" /> Đang kiểm tra nghi trùng…
      </span>
    );
  }
  if (error) {
    return (
      <span className="inline-check-feedback" role="status">
        Chưa kiểm tra nghi trùng được.
        {onRetry && (
          <button type="button" className="text-link" onClick={onRetry}>
            Thử lại
          </button>
        )}
      </span>
    );
  }
  if (!hasSignal || !result || result.level === "GREEN") {
    if (!hasSignal) return null;
    return (
      <span className="inline-check-feedback positive">
        <CheckCircle2 size={13} /> Chưa phát hiện xe trùng
      </span>
    );
  }

  if (result.level === "YELLOW") {
    return (
      <div className="notice warning duplicate-panel" role="status">
        <div className="duplicate-panel-head">
          <AlertTriangle size={16} aria-hidden="true" />
          <strong>Có thể xe này đã tồn tại</strong>
        </div>
        <p className="duplicate-panel-reason">{duplicateReasonCopy(result.reason)}</p>
        <CandidateList candidates={result.candidates} />
        <label className="duplicate-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledge(event.target.checked)}
          />
          <span>Đã kiểm tra danh sách trên, vẫn lưu xe này.</span>
        </label>
      </div>
    );
  }

  // RED: FULL_FRAME_MATCH là chặn tuyệt đối với mọi vai trò; PLATE_AND_LAST5 là
  // nghi trùng xử lý theo vai trò (Nhân viên gửi yêu cầu, Chủ/Quản lý lưu ngoại lệ).
  const action = decideDuplicateAction({
    level: "RED",
    reason: result.reason,
    role,
    acknowledged,
  });
  const redCopy =
    action.kind === "hard-block"
      ? {
          title: "Trùng số khung đầy đủ — không lưu được",
          hint: "Số khung trùng chính xác một xe đang quản lý. Kể cả Chủ cửa hàng cũng không thể lưu trùng; hãy mở hồ sơ hiện có để cập nhật.",
        }
      : action.kind === "request-review"
        ? {
            title: "Nghi trùng — cần Chủ/Quản lý xác minh",
            hint: "Xe chưa được lưu. Mở hồ sơ nghi trùng để đối chiếu, rồi bấm «Gửi yêu cầu xác minh» chuyển Chủ/Quản lý.",
          }
        : {
            title: "Nghi trùng — Chủ/Quản lý có thể lưu ngoại lệ",
            hint: "Mở hồ sơ nghi trùng, đối chiếu thực tế, rồi bấm Lưu để nhập lý do ngoại lệ (được ghi vào kiểm toán).",
          };
  return (
    <div className="notice danger duplicate-panel" role="alert">
      <div className="duplicate-panel-head">
        <ShieldAlert size={16} aria-hidden="true" />
        <strong>{redCopy.title}</strong>
      </div>
      <p className="duplicate-panel-reason">{duplicateReasonCopy(result.reason)}</p>
      <p className="muted small">{redCopy.hint}</p>
      <CandidateList candidates={result.candidates} />
    </div>
  );
}
