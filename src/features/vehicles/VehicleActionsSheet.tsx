import { Link } from "react-router-dom";
import {
  Camera,
  ChevronRight,
  CirclePlus,
  Eye,
  SendHorizontal,
  ShoppingBag,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  canDeleteVehicle,
  canOperate,
  canRequestVehicleDelete,
} from "@/lib/permissions";
import { colorWordToHex } from "@/lib/colorWords";
import { useDialog } from "@/lib/useDialog";
import {
  vehicleAriaLabel,
  vehicleSubtitle,
  vehicleTitle,
} from "@/lib/vehicleDisplay";
import type { Vehicle } from "@/types";

export function VehicleActionsSheet({
  vehicle,
  onClose,
  onExpense,
  onDelete,
  onRequestDelete,
  returnTo,
}: {
  vehicle: Vehicle;
  onClose: () => void;
  onExpense: () => void;
  onDelete?: () => void;
  onRequestDelete?: () => void;
  returnTo?: string;
}) {
  const { profile } = useAuth();
  const panelRef = useDialog(true, onClose);
  const available = ["IN_STOCK", "RESERVED"].includes(vehicle.status);
  const pending = !!vehicle.pending_deletion;
  // Đơn bán dưới giá thu đang chờ chủ duyệt: vẫn mở form bán để nhân viên
  // xem chênh lệch và rút yêu cầu, nhưng không được bán trùng.
  const pendingSale = !!vehicle.pending_sale_approval;
  const canDirectDelete =
    !!onDelete && canDeleteVehicle(profile) && available && !pending;
  const canRequestDelete =
    !!onRequestDelete && canRequestVehicleDelete(profile) && available && !pending;
  const state = { fromInventory: returnTo };
  const dotHex = colorWordToHex(vehicle.color);
  const rowClass = (tone: "neutral" | "primary" | "danger") =>
    `vas-row vas-row-${tone}`;
  return (
    <div className="modal-backdrop vas-backdrop" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        tabIndex={-1}
        className="modal-card vehicle-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Thao tác với ${vehicleAriaLabel(vehicle)}`}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="vas-handle" aria-hidden="true" />
        <div className="vas-header">
          <span className="vas-dot" style={{ background: dotHex }} aria-hidden="true" />
          <div className="vas-heading">
            <h3>{vehicleTitle(vehicle)}</h3>
            {vehicleSubtitle(vehicle) && (
              <p className="vas-subtitle">{vehicleSubtitle(vehicle)}</p>
            )}
          </div>
          <button
            className="icon-button vas-close"
            type="button"
            aria-label="Đóng thao tác xe"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="vas-list">
          <Link
            className={rowClass("neutral")}
            to={`/vehicles/${vehicle.id}`}
            state={state}
          >
            <span className="vas-tile vas-tile-neutral"><Eye size={17} /></span>
            <span className="vas-label">Xem chi tiết</span>
            <ChevronRight className="vas-chevron" size={16} />
          </Link>
          {canOperate(profile) && available && !pending && (
            <button
              type="button"
              className={rowClass("neutral")}
              onClick={onExpense}
            >
              <span className="vas-tile vas-tile-neutral"><CirclePlus size={17} /></span>
              <span className="vas-label">Chi phí</span>
            </button>
          )}
          {canOperate(profile) && available && !vehicle.cost_pending && !pending && (
            <Link
              className={rowClass(pendingSale ? "neutral" : "primary")}
              to={`/vehicles/${vehicle.id}/sell`}
              state={state}
            >
              <span
                className={
                  pendingSale ? "vas-tile vas-tile-neutral" : "vas-tile vas-tile-primary"
                }
              >
                {pendingSale ? <SendHorizontal size={17} /> : <ShoppingBag size={17} />}
              </span>
              <span className="vas-label">
                {pendingSale ? "Chờ chủ duyệt bán" : "Bán xe"}
              </span>
              <ChevronRight className="vas-chevron" size={16} />
            </Link>
          )}
          {canOperate(profile) && !pending && (
            <Link
              className={rowClass("neutral")}
              to={`/capture?vehicle=${vehicle.id}`}
            >
              <span className="vas-tile vas-tile-neutral"><Camera size={17} /></span>
              <span className="vas-label">Thêm ảnh</span>
              <ChevronRight className="vas-chevron" size={16} />
            </Link>
          )}
          {(canDirectDelete || canRequestDelete) && (
            <div className="vas-sep" role="presentation" />
          )}
          {canDirectDelete && (
            <button
              type="button"
              className={rowClass("danger")}
              onClick={onDelete}
            >
              <span className="vas-tile vas-tile-danger"><Trash2 size={17} /></span>
              <span className="vas-label">Xóa xe khỏi kho</span>
            </button>
          )}
          {canRequestDelete && (
            <button
              type="button"
              className={rowClass("danger")}
              onClick={onRequestDelete}
            >
              <span className="vas-tile vas-tile-danger"><SendHorizontal size={17} /></span>
              <span className="vas-label">Gửi yêu cầu xóa</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
