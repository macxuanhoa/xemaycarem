import { Link } from "react-router-dom";
import { CirclePlus, ShoppingBag, X } from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate } from "@/lib/permissions";
import { useDialog } from "@/lib/useDialog";
import type { Vehicle } from "@/types";

export function VehicleActionsSheet({
  vehicle,
  onClose,
  onExpense,
  returnTo,
}: {
  vehicle: Vehicle;
  onClose: () => void;
  onExpense: () => void;
  returnTo?: string;
}) {
  const { profile } = useAuth();
  const panelRef = useDialog(true, onClose);
  const available = ["IN_STOCK", "RESERVED"].includes(vehicle.status);
  const state = { fromInventory: returnTo };
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        tabIndex={-1}
        className="modal-card vehicle-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Thao tác với ${vehicle.brand} ${vehicle.model}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3>
              {vehicle.brand} {vehicle.model}
            </h3>
            <p className="muted">
              {vehicle.license_plate ||
                vehicle.frame_number ||
                vehicle.internal_code}
            </p>
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
          {canManage(profile) && available && (
            <button
              type="button"
              className="button secondary"
              onClick={onExpense}
            >
              <CirclePlus size={17} /> + Chi phí
            </button>
          )}
          {canOperate(profile) && available && !vehicle.cost_pending && (
            <Link
              className="button primary"
              to={`/vehicles/${vehicle.id}/sell`}
              state={state}
            >
              <ShoppingBag size={17} /> Bán xe
            </Link>
          )}
          {canOperate(profile) && (
            <Link
              className="button secondary"
              to={`/capture?vehicle=${vehicle.id}`}
            >
              Thêm ảnh
            </Link>
          )}
          <Link
            className="button ghost"
            to={`/vehicles/${vehicle.id}#vehicle-history`}
            state={state}
          >
            Lịch sử
          </Link>
        </div>
      </div>
    </div>
  );
}
