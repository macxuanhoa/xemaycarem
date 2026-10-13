import { Star } from "lucide-react";
import { vehicleTitle } from "@/lib/vehicleDisplay";
import { useToggleVehicleFavorite } from "@/lib/useVehicleFavorite";
import type { Vehicle } from "@/types";

/**
 * Dấu sao "Xe yêu thích" dùng chung cho Kho (bảng, thẻ mobile, sheet 3 chấm)
 * và hồ sơ xe. Trạng thái đến thẳng từ projection của server (`is_favorite`
 * gắn theo JWT người đọc), nên không cần query phụ; bấm là đổi ngay nhờ
 * optimistic cache trong useToggleVehicleFavorite.
 */
export function VehicleFavoriteButton({
  vehicle,
  className,
  withLabel = false,
  size = 17,
}: {
  vehicle: Vehicle;
  className?: string;
  /** Sheet/hồ sơ cần chữ rõ nghĩa; thẻ danh sách chỉ cần icon. */
  withLabel?: boolean;
  size?: number;
}) {
  const toggle = useToggleVehicleFavorite();
  const favorite = !!vehicle.is_favorite;
  const label = vehicleTitle(vehicle);
  return (
    <button
      type="button"
      className={`fav-toggle${withLabel ? " fav-toggle-labeled" : ""}${
        favorite ? " is-favorite" : ""
      }${className ? ` ${className}` : ""}`}
      aria-pressed={favorite}
      aria-label={favorite ? `Bỏ yêu thích xe ${label}` : `Yêu thích xe ${label}`}
      title={favorite ? "Bỏ yêu thích" : "Yêu thích"}
      onClick={(event) => {
        // Sao nằm trong link/thẻ: chặn trình duyệt điều hướng khi bấm.
        event.preventDefault();
        event.stopPropagation();
        toggle.mutate(vehicle.id);
      }}
    >
      <Star size={size} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
      {withLabel && (
        <span className="fav-toggle-text">
          {favorite ? "Đang yêu thích" : "Yêu thích"}
        </span>
      )}
    </button>
  );
}
