import { Link } from "react-router-dom";
import {
  Bike,
  ChevronRight,
  CirclePlus,
  Eye,
  SendHorizontal,
  ShoppingBag,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { VehicleIdentityChips } from "@/components/ui/VehicleIdentityChips";
import {
  canDeleteVehicle,
  canOperate,
  canRequestVehicleDelete,
} from "@/lib/permissions";
import { colorWordToHex } from "@/lib/colorWords";
import { useDialog } from "@/lib/useDialog";
import { vehicleAriaLabel } from "@/lib/vehicleDisplay";
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
  // Tên xe to dẫn đầu, chi tiết phụ (biển số, số khung) xuống dòng dưới thành
  // chip — dựng lại đúng bộ chip của thẻ danh sách cho hai mặt liền nhau.
  const nameParts = [
    vehicle.vehicle_type?.trim() || "Chưa phân loại",
    vehicle.year ? String(vehicle.year) : "",
    vehicle.color?.trim() || "",
  ].filter(Boolean);
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
          <div className="vas-headline">
            <span
              className="vas-avatar"
              style={{
                background: `radial-gradient(circle at 30% 26%, rgba(255,255,255,0.42), rgba(255,255,255,0) 62%), ${dotHex}`,
              }}
              aria-hidden="true"
            >
              <Bike size={18} strokeWidth={1.7} />
            </span>
            <div className="vas-heading">
              <h3>{nameParts.join(" · ")}</h3>
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
          <VehicleIdentityChips vehicle={vehicle} />
        </div>
        <div className="vas-list">
          <Link
            className={rowClass("neutral")}
            to={`/vehicles/${vehicle.id}`}
            state={state}
          >
            <span className="vas-tile vas-tile-neutral"><Eye size={15} /></span>
            <span className="vas-label">Xem chi tiết</span>
            <ChevronRight className="vas-chevron" size={16} />
          </Link>
          {canOperate(profile) && available && !pending && (
            <button
              type="button"
              className={rowClass("neutral")}
              onClick={onExpense}
            >
              <span className="vas-tile vas-tile-neutral"><CirclePlus size={15} /></span>
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
                {pendingSale ? <SendHorizontal size={15} /> : <ShoppingBag size={15} />}
              </span>
              <span className="vas-label">
                {pendingSale ? "Chờ chủ duyệt bán" : "Bán xe"}
              </span>
              <ChevronRight className="vas-chevron" size={16} />
            </Link>
          )}
          {(canDirectDelete || canRequestDelete) && (
            <div className="vas-group-label">Vùng nguy hiểm</div>
          )}
          {canDirectDelete && (
            <button
              type="button"
              className={rowClass("danger")}
              onClick={onDelete}
            >
              <span className="vas-tile vas-tile-danger"><Trash2 size={15} /></span>
              <span className="vas-label">Xóa xe khỏi kho</span>
            </button>
          )}
          {canRequestDelete && (
            <button
              type="button"
              className={rowClass("danger")}
              onClick={onRequestDelete}
            >
              <span className="vas-tile vas-tile-danger"><SendHorizontal size={15} /></span>
              <span className="vas-label">Gửi yêu cầu xóa</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
