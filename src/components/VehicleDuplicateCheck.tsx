import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";
import { vehicleTitle } from "@/lib/vehicleDisplay";
import { duplicateReasonCopy, type FrameInputKind } from "@/lib/frameNumber";
import type { DuplicateCheckResult } from "@/lib/vehicleDuplicateCheck";

/** Cách chọn loại dữ liệu số khung: "AUTO" để hệ thống tự nhận theo độ dài. */
export type FrameKindSelection = "AUTO" | FrameInputKind;

/**
 * Ô số khung CHỈ có một; hệ thống TỰ nhận FULL (VIN đầy đủ ≥ 11 ký tự, giữ
 * danh tính cứng UNIQUE) hay PARTIAL (mảnh 5 ký tự cuối, chỉ nghi trùng). Nút
 * chọn tay được ẩn vào "Nâng cao", dùng cho ngoại lệ — ví dụ số khung hợp lệ
 * nhưng ngắn hơn 11 ký tự mà nhân viên muốn ép về "Đầy đủ" để chặn trùng cứng.
 */
export function FrameKindAdvanced({
  kind,
  selection,
  onSelect,
  disabled,
}: {
  kind: FrameInputKind;
  selection: FrameKindSelection;
  onSelect: (value: FrameKindSelection) => void;
  disabled?: boolean;
}) {
  const options: { value: FrameKindSelection; label: string }[] = [
    { value: "AUTO", label: "Tự động" },
    { value: "FULL", label: "Đầy đủ" },
    { value: "PARTIAL", label: "Rút gọn" },
  ];
  return (
    <div className="frame-kind-advanced">
      <span className="frame-kind-detected muted small">
        Nhận diện:{" "}
        {kind === "FULL" ? "số khung đầy đủ" : "5 ký tự cuối (rút gọn)"}
        {selection !== "AUTO" ? " · chọn thủ công" : ""}
      </span>
      <details className="frame-kind-details">
        <summary>Loại số khung (nâng cao)</summary>
        <div
          className="frame-kind-segmented"
          role="radiogroup"
          aria-label="Loại dữ liệu số khung"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selection === option.value}
              disabled={disabled}
              className={`frame-kind-option${selection === option.value ? " active" : ""}`}
              onClick={() => onSelect(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="frame-kind-hint muted small">
          Hệ thống tự nhận số khung từ 11 ký tự là đầy đủ. Chọn "Đầy đủ" nếu đây
          là số khung hợp lệ nhưng ngắn hơn, để áp dụng chặn trùng tuyệt đối.
        </p>
      </details>
    </div>
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
  onAcknowledge,
  onRetry,
}: {
  checking: boolean;
  error: boolean;
  result?: DuplicateCheckResult;
  hasSignal: boolean;
  acknowledged: boolean;
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

  // RED — chặn cứng cho tới khi nhập số khung đầy đủ hoặc xử lý xong ở hồ sơ khác.
  return (
    <div className="notice danger duplicate-panel" role="alert">
      <div className="duplicate-panel-head">
        <ShieldAlert size={16} aria-hidden="true" />
        <strong>Nghi trùng xe đang quản lý — chưa cho lưu</strong>
      </div>
      <p className="duplicate-panel-reason">{duplicateReasonCopy(result.reason)}</p>
      <CandidateList candidates={result.candidates} />
    </div>
  );
}
