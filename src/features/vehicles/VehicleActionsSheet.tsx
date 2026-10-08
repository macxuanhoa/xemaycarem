import { Link } from "react-router-dom";
import {
  CirclePlus,
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
  const canDirectDelete =
    !!onDelete && canDeleteVehicle(profile) && available && !pending;
  const canRequestDelete =
    !!onRequestDelete && canRequestVehicleDelete(profile) && available && !pending;
  const state = { fromInventory: returnTo };
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        tabIndex={-1}
        className="modal-card vehicle-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Thao tác với ${vehicleAriaLabel(vehicle)}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3>{vehicleTitle(vehicle)}</h3>
            <p className="muted">{vehicleSubtitle(vehicle)}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Đóng thao tác xe"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body stack">
          <Link
            className="button secondary"
            to={`/vehicles/${vehicle.id}`}
            state={state}
          >
            Xem chi tiết
          </Link>
          {canOperate(profile) && available && !pending && (
            <button
              type="button"
              className="button secondary"
              onClick={onExpense}
            >
              <CirclePlus size={17} /> Chi phí
            </button>
          )}
          {canOperate(profile) && available && !vehicle.cost_pending && !pending && (
            <Link
              className="button primary"
              to={`/vehicles/${vehicle.id}/sell`}
              state={state}
            >
              <ShoppingBag size={17} /> Bán xe
            </Link>
          )}
          {canOperate(profile) && !pending && (
            <Link
              className="button secondary"
              to={`/capture?vehicle=${vehicle.id}`}
            >
              Thêm ảnh
            </Link>
          )}
          {canDirectDelete && (
            <button
              type="button"
              className="button danger"
              onClick={onDelete}
            >
              <Trash2 size={17} /> Xóa xe khỏi kho
            </button>
          )}
          {canRequestDelete && (
            <button
              type="button"
              className="button danger"
              onClick={onRequestDelete}
            >
              <SendHorizontal size={17} /> Gửi yêu cầu xóa
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
