import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bike,
  CheckCircle2,
  ExternalLink,
  Eye,
  LoaderCircle,
  ShieldAlert,
  ShoppingBag,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useDialog } from "@/lib/useDialog";
import { dateLabel } from "@/lib/format";
import { vehicleTitle } from "@/lib/vehicleDisplay";
import { duplicateReasonCopy, type FrameInputKind } from "@/lib/frameNumber";
import { decideDuplicateAction } from "@/lib/duplicateReviewDecision";
import { Button, Loading, ErrorState } from "@/components/ui";
import type { DuplicateCheckResult } from "@/lib/vehicleDuplicateCheck";
import type { Role, Vehicle } from "@/types";

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

const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "đang chờ bán",
  RESERVED: "đã giữ chỗ",
  SOLD: "đã bán",
  CANCELLED: "đã hủy",
};

export function isVehicleInStock(status?: string): boolean {
  return status === "IN_STOCK" || status === "RESERVED";
}

export function isVehicleSold(status?: string): boolean {
  return status === "SOLD";
}

export function summarizeCandidates(candidates: CandidateRow[]) {
  const inStock = candidates.filter((c) => isVehicleInStock(c.status));
  const sold = candidates.filter((c) => isVehicleSold(c.status));
  const other = candidates.filter(
    (c) => !isVehicleInStock(c.status) && !isVehicleSold(c.status),
  );

  return {
    inStock,
    sold,
    other,
    hasInStock: inStock.length > 0,
    hasSold: sold.length > 0,
    hasBoth: inStock.length > 0 && sold.length > 0,
  };
}

function statusBadgeClass(status?: string) {
  switch (status) {
    case "IN_STOCK":
      return "status-in-stock";
    case "RESERVED":
      return "status-reserved";
    case "SOLD":
      return "status-sold";
    case "CANCELLED":
      return "status-cancelled";
    default:
      return "status-in-stock";
  }
}

/**
 * Banner hướng dẫn nghiệp vụ: phân biệt rạch ròi giữa
 * 1) Xe đang có trong kho (nguy cơ tạo trùng xe đang tồn)
 * 2) Xe đã bán trong quá khứ (khách mang xe cũ quay lại bán lại / thu xe cũ)
 */
function DuplicateInventorySummaryBanner({
  candidates,
}: {
  candidates: CandidateRow[];
}) {
  const { inStock, sold, hasInStock, hasSold, hasBoth } =
    summarizeCandidates(candidates);

  if (hasBoth) {
    return (
      <div className="duplicate-inventory-summary has-instock">
        <div>
          <strong>Phát hiện 2 nhóm xe khác nhau:</strong> Có{" "}
          <strong>{inStock.length} xe ĐANG TRONG KHO</strong> và{" "}
          <strong>{sold.length} xe ĐÃ BÁN TRƯỚC ĐÂY</strong>.
        </div>
        <div style={{ fontSize: "12px", opacity: 0.9 }}>
          • <strong>Xe trong kho:</strong> Kiểm tra kỹ để tránh tạo trùng 2 lần chiếc xe đang có tại cửa hàng.
          <br />
          • <strong>Xe đã bán:</strong> Có thể là khách mang xe cũ từng mua quay lại bán lại (thu lại xe).
        </div>
      </div>
    );
  }

  if (hasInStock) {
    return (
      <div className="duplicate-inventory-summary has-instock">
        <div>
          ⚠️ <strong>Xe nghi trùng hiện ĐANG CÓ TRONG KHO ({inStock.length} xe):</strong>
        </div>
        <div style={{ fontSize: "12px", opacity: 0.9 }}>
          Chiếc xe này đang nằm trong kho tại cửa hàng (chưa bán). Hãy kiểm tra thực tế kho xe để tránh tạo trùng lặp xe đang quản lý!
        </div>
      </div>
    );
  }

  if (hasSold) {
    return (
      <div className="duplicate-inventory-summary only-sold">
        <div>
          ℹ️ <strong>Xe nghi trùng với hồ sơ ĐÃ BÁN TRƯỚC ĐÂY ({sold.length} xe):</strong>
        </div>
        <div style={{ fontSize: "12px", opacity: 0.9 }}>
          Xe này đã được cửa hàng bán ra trong quá khứ. Nếu đây là trường hợp khách mang xe cũ quay lại bán lại (thu lại xe cũ), bạn có thể mở hồ sơ cũ để đối chiếu lịch sử và xác nhận để tiếp tục lưu.
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Hộp thoại xem nhanh chi tiết xe nghi trùng ngay trên màn hình thu xe
 * mà không phải chuyển trang hay tải lại form.
 */
function DuplicateQuickViewModal({
  candidate,
  onClose,
}: {
  candidate: CandidateRow;
  onClose: () => void;
}) {
  const panelRef = useDialog(true, onClose, false);
  const { data: vehicle, isLoading, error } = useQuery({
    queryKey: ["duplicate-quick-view", candidate.id],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: candidate.id }),
  });

  const photoPath = vehicle?.images?.[0]?.storage_path;
  const { data: photoUrl } = useQuery({
    queryKey: ["vehicle-image", photoPath],
    queryFn: () => (photoPath ? api.imageUrl(photoPath) : null),
    enabled: !!photoPath,
    staleTime: 4 * 60 * 1000,
  });

  const inStock = isVehicleInStock(vehicle?.status ?? candidate.status);
  const sold = isVehicleSold(vehicle?.status ?? candidate.status);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className="modal-card duplicate-quick-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dup-quick-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="duplicate-quick-header-title">
            <Bike size={18} aria-hidden="true" />
            <h3 id="dup-quick-title">Chi tiết xe nghi trùng</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Đóng"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body stack">
          {isLoading && <Loading />}
          {error && <ErrorState error={error} />}
          {vehicle && (
            <div className="duplicate-quick-content">
              {inStock ? (
                <div className="duplicate-inventory-summary has-instock">
                  ⚠️ <strong>Xe này hiện ĐANG TRONG KHO (Chưa bán):</strong>
                  <span> Vui lòng kiểm tra xe thực tế tại cửa hàng để tránh tạo trùng 2 lần.</span>
                </div>
              ) : sold ? (
                <div className="duplicate-inventory-summary only-sold">
                  ℹ️ <strong>Xe này ĐÃ BÁN RA trước đây:</strong>
                  <span> Nếu khách mang xe cũ quay lại bán lại cho cửa hàng (thu xe cũ), dùng thông tin dưới đây để đối chiếu.</span>
                </div>
              ) : null}

              {photoUrl && (
                <div className="duplicate-quick-photo-wrap">
                  <img
                    src={photoUrl}
                    alt={vehicleTitle(vehicle)}
                    className="duplicate-quick-photo"
                  />
                </div>
              )}

              <div className="duplicate-quick-top-badges">
                <span className="duplicate-plate-badge">
                  {vehicle.license_plate || "Chưa có biển số"}
                </span>
                <span className={`duplicate-status-badge ${statusBadgeClass(vehicle.status)}`}>
                  {STATUS_LABEL[vehicle.status] ?? vehicle.status}
                </span>
              </div>

              <div>
                <h4 style={{ margin: "0 0 4px", fontSize: "16px" }}>
                  {vehicleTitle(vehicle)}
                </h4>
                {vehicle.vehicle_subtitle && (
                  <p className="muted small" style={{ margin: 0 }}>
                    {vehicle.vehicle_subtitle}
                  </p>
                )}
              </div>

              <div className="duplicate-quick-grid">
                <div className="duplicate-quick-field">
                  <span className="duplicate-quick-label">Mã xe</span>
                  <span className="duplicate-quick-value">{vehicle.internal_code}</span>
                </div>
                <div className="duplicate-quick-field">
                  <span className="duplicate-quick-label">Tình trạng kho</span>
                  <span className="duplicate-quick-value">
                    {inStock
                      ? "Đang ở cửa hàng (Tồn kho)"
                      : sold
                        ? "Đã bán trong quá khứ"
                        : STATUS_LABEL[vehicle.status] ?? vehicle.status}
                  </span>
                </div>
                <div className="duplicate-quick-field">
                  <span className="duplicate-quick-label">Loại xe</span>
                  <span className="duplicate-quick-value">{vehicle.vehicle_type || "Chưa rõ"}</span>
                </div>
                <div className="duplicate-quick-field">
                  <span className="duplicate-quick-label">Năm sản xuất</span>
                  <span className="duplicate-quick-value">{vehicle.year || "Chưa rõ"}</span>
                </div>
                <div className="duplicate-quick-field">
                  <span className="duplicate-quick-label">Màu sắc</span>
                  <span className="duplicate-quick-value">{vehicle.color || "Chưa rõ"}</span>
                </div>
                <div className="duplicate-quick-field" style={{ gridColumn: "span 2" }}>
                  <span className="duplicate-quick-label">Số khung</span>
                  <span className="duplicate-quick-value font-mono">
                    {vehicle.frame_number || "Chưa có"}
                  </span>
                </div>
                <div className="duplicate-quick-field">
                  <span className="duplicate-quick-label">Ngày thu xe</span>
                  <span className="duplicate-quick-value">
                    {vehicle.purchase_date ? dateLabel(vehicle.purchase_date) : "Chưa rõ"}
                  </span>
                </div>
                <div className="duplicate-quick-field">
                  <span className="duplicate-quick-label">Người bán</span>
                  <span className="duplicate-quick-value">
                    {vehicle.supplier_name || "—"}{" "}
                    {vehicle.supplier_phone ? `(${vehicle.supplier_phone})` : ""}
                  </span>
                </div>
                {vehicle.notes && (
                  <div className="duplicate-quick-field" style={{ gridColumn: "span 2" }}>
                    <span className="duplicate-quick-label">Ghi chú</span>
                    <span className="duplicate-quick-value">{vehicle.notes}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <a
            href={`/vehicles/${candidate.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="button button-primary duplicate-quick-open-link"
          >
            <ExternalLink size={15} aria-hidden="true" />
            <span>Mở toàn bộ hồ sơ (tab mới)</span>
          </a>
        </div>
      </div>
    </div>
  );
}

function CandidateList({
  candidates,
  onPreview,
}: {
  candidates: CandidateRow[];
  onPreview: (candidate: CandidateRow) => void;
}) {
  return (
    <ul className="duplicate-candidate-list">
      {candidates.map((candidate) => {
        const inStock = isVehicleInStock(candidate.status);
        const sold = isVehicleSold(candidate.status);
        const cardClass = inStock ? "is-instock" : sold ? "is-sold" : "";

        return (
          <li
            key={candidate.id}
            className={`duplicate-candidate-card ${cardClass}`.trim()}
          >
            {inStock ? (
              <div className="duplicate-candidate-status-strip instock">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>XE ĐANG TRONG KHO (Chưa bán · Kiểm tra tránh tạo trùng)</span>
              </div>
            ) : sold ? (
              <div className="duplicate-candidate-status-strip sold">
                <ShoppingBag size={13} aria-hidden="true" />
                <span>XE ĐÃ BÁN TRONG QUÁ KHỨ (Có thể là xe khách bán lại)</span>
              </div>
            ) : (
              <div className="duplicate-candidate-status-strip cancelled">
                <span>HỒ SƠ ĐÃ HỦY</span>
              </div>
            )}

            <div className="duplicate-candidate-top">
              <span className="duplicate-plate-badge">
                {candidate.license_plate || "Chưa có biển số"}
              </span>
              <span className={`duplicate-status-badge ${statusBadgeClass(candidate.status)}`}>
                {STATUS_LABEL[candidate.status] ?? candidate.status}
              </span>
            </div>

            <div className="duplicate-candidate-main">
              <strong className="duplicate-candidate-title">
                {vehicleTitle(candidate)}
              </strong>
              <div className="duplicate-candidate-meta">
                <span>
                  Mã: <strong>{candidate.internal_code}</strong>
                </span>
                <span>·</span>
                <span>
                  Số khung: <strong>{candidate.frame_number || "Chưa có"}</strong>{" "}
                  ({candidate.frame_input_kind === "PARTIAL"
                    ? "khung rút gọn"
                    : "khung đầy đủ"})
                </span>
              </div>
            </div>

            <div className="duplicate-candidate-actions">
              <button
                type="button"
                className="duplicate-btn duplicate-btn-preview"
                onClick={() => onPreview(candidate)}
                title="Xem nhanh thông tin xe"
              >
                <Eye size={14} aria-hidden="true" />
                <span>Xem nhanh</span>
              </button>
              <Link
                to={`/vehicles/${candidate.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="duplicate-btn duplicate-btn-open"
                aria-label="Mở hồ sơ"
                title="Mở hồ sơ xe trong tab mới"
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>Mở hồ sơ</span>
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Khối phản hồi ba mức ngay dưới ô số khung. Đọc kết quả từ
 * `useVehicleDuplicateCheck`; server tái-kiểm tra khi lưu nên đây chỉ là xem trước.
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
  const [previewCandidate, setPreviewCandidate] = useState<CandidateRow | null>(null);

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

  const { hasInStock, hasSold, hasBoth } = summarizeCandidates(result.candidates);
  const countBadgeClass = hasBoth
    ? ""
    : hasInStock
      ? "warning-count"
      : hasSold
        ? "sold-count"
        : "";

  const countBadgeLabel = hasBoth
    ? `${result.candidates.length} xe (kho & đã bán)`
    : hasInStock
      ? `${result.candidates.length} xe trong kho`
      : hasSold
        ? `${result.candidates.length} xe đã bán`
        : `${result.candidates.length} xe nghi trùng`;

  if (result.level === "YELLOW") {
    return (
      <>
        <div className="notice warning duplicate-panel" role="status">
          <div className="duplicate-panel-head">
            <div className="duplicate-panel-title-wrap">
              <span className="duplicate-panel-icon">
                <AlertTriangle size={16} aria-hidden="true" />
              </span>
              <strong>Có thể xe này đã tồn tại</strong>
            </div>
            <span className={`duplicate-count-badge ${countBadgeClass}`.trim()}>
              {countBadgeLabel}
            </span>
          </div>

          <p className="duplicate-panel-reason">{duplicateReasonCopy(result.reason)}</p>

          <DuplicateInventorySummaryBanner candidates={result.candidates} />

          <CandidateList
            candidates={result.candidates}
            onPreview={setPreviewCandidate}
          />

          <label className="duplicate-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => onAcknowledge(event.target.checked)}
            />
            <span>Đã kiểm tra danh sách trên, vẫn lưu xe này.</span>
          </label>
        </div>

        {previewCandidate && (
          <DuplicateQuickViewModal
            candidate={previewCandidate}
            onClose={() => setPreviewCandidate(null)}
          />
        )}
      </>
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
    <>
      <div className="notice danger duplicate-panel" role="alert">
        <div className="duplicate-panel-head">
          <div className="duplicate-panel-title-wrap">
            <span className="duplicate-panel-icon">
              <ShieldAlert size={16} aria-hidden="true" />
            </span>
            <strong>{redCopy.title}</strong>
          </div>
          <span className={`duplicate-count-badge ${countBadgeClass}`.trim()}>
            {countBadgeLabel}
          </span>
        </div>

        <p className="duplicate-panel-reason">{duplicateReasonCopy(result.reason)}</p>
        <p className="muted small" style={{ margin: 0 }}>
          {redCopy.hint}
        </p>

        <DuplicateInventorySummaryBanner candidates={result.candidates} />

        <CandidateList
          candidates={result.candidates}
          onPreview={setPreviewCandidate}
        />
      </div>

      {previewCandidate && (
        <DuplicateQuickViewModal
          candidate={previewCandidate}
          onClose={() => setPreviewCandidate(null)}
        />
      )}
    </>
  );
}
