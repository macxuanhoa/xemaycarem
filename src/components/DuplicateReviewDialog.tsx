import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { Button, ErrorState, Field } from "@/components/ui";
import { useDialog } from "@/lib/useDialog";
import { vehicleTitle } from "@/lib/vehicleDisplay";
import { duplicateReasonCopy } from "@/lib/frameNumber";
import type { DuplicateCandidate } from "@/lib/vehicleDuplicateCheck";

/**
 * Hai hộp thoại chia sẻ cho luồng xác minh nghi trùng PLATE_AND_LAST5
 * (migration 20261011000400). Cả hai đều liệt kê đúng hồ sơ đang nghi trùng để
 * người xem MỞ đối chiếu trước khi quyết định — không tự gộp/ghi đè xe cũ.
 *
 *  · RequestReviewDialog — Nhân viên (STAFF): không lưu được xe, chỉ gửi toàn bộ
 *    dữ liệu đang soạn sang hàng đợi của Chủ/Quản lý. Không tạo xe trước duyệt.
 *  · OverrideSaveDialog — Chủ/Quản lý (OWNER/MANAGER): buộc chọn đúng hồ sơ đã
 *    mở đối chiếu (khớp candidate_ids server kiểm lại) và nhập lý do ngoại lệ ≥ 5
 *    ký tự rồi mới trực tiếp lưu.
 *
 * Không hiển thị giá vốn riêng tư của hồ sơ đối chiếu — chỉ chữ ký nhận diện.
 */

const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "đang chờ bán",
  RESERVED: "đã giữ chỗ",
  SOLD: "đã bán",
  CANCELLED: "đã hủy",
};

function CandidateLine({ candidate }: { candidate: DuplicateCandidate }) {
  return (
    <div className="duplicate-candidate-main">
      <strong>{vehicleTitle(candidate)}</strong>
      <span className="muted small">
        {candidate.internal_code} · biển {candidate.license_plate || "chưa có"} ·
        khung {candidate.frame_number || "chưa có"} ·{" "}
        {STATUS_LABEL[candidate.status] ?? candidate.status}
      </span>
    </div>
  );
}

function SuspectHeader({ reason }: { reason: string }) {
  return (
    <div className="notice danger duplicate-panel" role="alert">
      <div className="duplicate-panel-head">
        <ShieldAlert size={16} aria-hidden="true" />
        <strong>Hồ sơ nghi trùng — cùng biển số &amp; 5 ký tự cuối số khung</strong>
      </div>
      <p className="duplicate-panel-reason">{duplicateReasonCopy(reason)}</p>
    </div>
  );
}

function DialogShell({
  open,
  busy,
  onClose,
  title,
  titleId,
  children,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  children: ReactNode;
}) {
  const panelRef = useDialog(open, onClose, busy);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => { if (!busy) onClose(); }}>
      <div
        ref={panelRef}
        className="modal-card duplicate-review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Đóng"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function RequestReviewDialog({
  open,
  candidates,
  reason,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  candidates: DuplicateCandidate[];
  reason: string;
  submitting: boolean;
  error?: unknown;
  onClose: () => void;
  onSubmit: (staffNote: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <DialogShell
      open={open}
      busy={submitting}
      onClose={onClose}
      title="Gửi yêu cầu xác minh xe nghi trùng"
      titleId="dup-request-title"
    >
      <div className="stack">
        <SuspectHeader reason={reason} />
        <p className="muted small">
          Xe chưa được lưu vào kho. Gửi toàn bộ thông tin đang nhập cho Chủ/Quản lý
          xác minh; khi được duyệt, hệ thống lưu đúng bản bạn đã soạn. Mở hồ sơ nghi
          trùng để kiểm tra trước khi gửi:
        </p>
        <ul className="duplicate-candidate-list">
          {candidates.map((candidate) => (
            <li key={candidate.id} className="duplicate-candidate">
              <CandidateLine candidate={candidate} />
              <Link to={`/vehicles/${candidate.id}`} className="text-link">
                Mở hồ sơ
              </Link>
            </li>
          ))}
        </ul>
        <Field label="Ghi chú cho Chủ/Quản lý (không bắt buộc)">
          <textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="VD: Khách mang xe tới thu, biển và 5 số cuối giống xe cũ trong kho…"
          />
        </Field>
        {error ? <ErrorState error={error} /> : null}
        <div className="modal-footer-actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Quay lại chỉnh sửa
          </Button>
          <Button
            type="button"
            onClick={() => onSubmit(note.trim())}
            disabled={submitting || candidates.length === 0}
          >
            {submitting ? "Đang gửi…" : "Gửi yêu cầu xác minh"}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

export function OverrideSaveDialog({
  open,
  candidates,
  reason,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  candidates: DuplicateCandidate[];
  reason: string;
  submitting: boolean;
  error?: unknown;
  onClose: () => void;
  onSubmit: (args: { reason: string; reviewedVehicleId: string }) => void;
}) {
  const [reviewedId, setReviewedId] = useState<string>("");
  const [note, setNote] = useState("");
  const reasonReady = note.trim().length >= 5;
  const canSubmit = !!reviewedId && reasonReady && !submitting;
  return (
    <DialogShell
      open={open}
      busy={submitting}
      onClose={onClose}
      title="Lưu ngoại lệ hồ sơ nghi trùng"
      titleId="dup-override-title"
    >
      <div className="stack">
        <SuspectHeader reason={reason} />
        <p className="muted small">
          Bạn đang lưu với tư cách Chủ/Quản lý. Chọn đúng hồ sơ bạn ĐÃ mở và đối
          chiếu, rồi nhập lý do ngoại lệ (≥ 5 ký tự). Server sẽ kiểm lại dữ liệu,
          trạng thái đối chiếu và trùng lặp trong cùng giao dịch trước khi ghi.
        </p>
        <fieldset className="plain-fieldset">
          <legend className="field-label-text">Hồ sơ đã mở và đối chiếu *</legend>
          <ul className="duplicate-candidate-list">
            {candidates.map((candidate) => (
              <li key={candidate.id} className="duplicate-candidate">
                <label className="duplicate-review-choice">
                  <input
                    type="radio"
                    name="dup-reviewed-candidate"
                    value={candidate.id}
                    checked={reviewedId === candidate.id}
                    onChange={() => setReviewedId(candidate.id)}
                  />
                  <CandidateLine candidate={candidate} />
                </label>
                <Link to={`/vehicles/${candidate.id}`} className="text-link">
                  Mở hồ sơ
                </Link>
              </li>
            ))}
          </ul>
        </fieldset>
        <Field
          label="Lý do ngoại lệ *"
          error={note.length > 0 && !reasonReady ? "Ít nhất 5 ký tự." : undefined}
        >
          <textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="VD: Đã xem trực tiếp hai xe, biển này là biển mới đổi, 5 số cuối trùng do khách ghi nhầm…"
          />
        </Field>
        {error ? <ErrorState error={error} /> : null}
        <div className="modal-footer-actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Quay lại chỉnh sửa
          </Button>
          <Button
            type="button"
            onClick={() => onSubmit({ reason: note.trim(), reviewedVehicleId: reviewedId })}
            disabled={!canSubmit}
          >
            {submitting ? "Đang lưu…" : "Lưu ngoại lệ"}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
