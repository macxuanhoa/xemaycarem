import { Highlight } from "@/components/search/Highlight";
import { displayFrame } from "@/lib/frameNumber";
import {
  NO_FRAME_LABEL,
  NO_PLATE_LABEL,
  vehicleTitle,
  type VehicleIdentity,
} from "@/lib/vehicleDisplay";

/**
 * Bộ chip nhận diện xe — ưu tiên thị giác "Biển số" và "Số khung" như phiếu
 * "Danh tính xe" trong trang chi tiết (vehicle-id-tile), thu gọn thành pill
 * nhỏ vừa hàng cho danh sách: thu vào, tồn kho, đơn bán.
 *
 * Biển số lấy nguyên từ đối tượng; số khung ưu tiên cột thô, nếu danh sách chỉ
 * projection `vehicle_title` ("Biển số · Số khung") thì tách vế còn lại từ
 * chuỗi đó — luôn qua src/lib/vehicleDisplay để không lệch ký tự nào với server.
 */

/** Tách phần khung khỏi chuỗi danh tính chuẩn "Biển · Khung" (hoặc ngược lại). */
function pullFromTitle(title: string | null | undefined, keep: "frame" | "plate"): string {
  const parts = (title ?? "").split(" · ").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  // Vế đầu là biển số nếu khớp dạng biển; vế còn lại là số khung.
  const [first, second] = parts;
  return keep === "frame" ? second : first;
}

export function VehicleIdentityChips({
  vehicle,
  query,
}: {
  vehicle: VehicleIdentity | null | undefined;
  query?: string;
}) {
  const plate = (vehicle?.license_plate ?? "").trim()
    || (vehicle?.vehicle_title && !vehicle.vehicle_title.includes(NO_PLATE_LABEL)
      ? pullFromTitle(vehicle.vehicle_title, "plate")
      : "");
  // Placeholder GEN-… không phải số khung thật — chip hiện "chưa có khung".
  const frame = displayFrame(vehicle?.frame_number)
    || (vehicle?.vehicle_title && !vehicle.vehicle_title.includes(NO_FRAME_LABEL)
      ? pullFromTitle(vehicle.vehicle_title, "frame")
      : "");
  return (
    <div className="vehicle-title-chips">
      <span
        className={plate ? "title-chip title-chip-plate" : "title-chip title-chip-empty"}
        data-testid="plate-chip"
        title={`Biển số: ${plate || "chưa có"}`}
      >
        <span className="title-chip-label">Biển số</span>
        {plate ? <Highlight text={plate} query={query} /> : NO_PLATE_LABEL}
      </span>
      <span
        className={frame ? "title-chip title-chip-frame" : "title-chip title-chip-empty"}
        data-testid="frame-chip"
        title={`Số khung: ${frame || "chưa có"}`}
      >
        <span className="title-chip-label">Số khung</span>
        {frame ? <Highlight text={frame} query={query} /> : NO_FRAME_LABEL}
      </span>
    </div>
  );
}

/** Tên loại xe đứng đầu thẻ — chữ đậm, fallback biển số/số khung khi thiếu hoặc chưa phân loại. */
export function vehicleTypeName(vehicle: VehicleIdentity | null | undefined): string {
  const name = (vehicle?.vehicle_type ?? "").trim();
  if (name && name.toLowerCase() !== "chưa phân loại") {
    return name;
  }
  return vehicleTitle(vehicle);
}
