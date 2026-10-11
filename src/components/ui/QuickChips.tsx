interface QuickChipsProps {
  options: Array<{ value: string; label: string }>;
  selected?: string;
  onSelect: (value: string) => void;
  label?: string;
  className?: string;
}

export function QuickChips({
  options,
  selected,
  onSelect,
  label,
  className = "",
}: QuickChipsProps) {
  return (
    <div className={`quick-chips-wrap ${className}`}>
      {label && <span className="quick-chips-label">{label}:</span>}
      <div
        className="quick-chips-list"
        role="group"
        aria-label={label || "Chọn nhanh"}
      >
        {options.map((opt) => {
          const isSelected =
            selected != null &&
            selected.trim().toLowerCase() === opt.value.trim().toLowerCase();
          return (
            <button
              key={opt.value}
              type="button"
              className={`chip-item ${isSelected ? "active" : ""}`}
              aria-pressed={isSelected}
              onClick={() => onSelect(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Màu sắc dùng bộ chọn màu trực tiếp bên nhãn "Màu sắc" (xem
// `src/components/ui/ColorSwatchAction.tsx`); app lưu từ tiếng Việt gần nhất
// qua `src/lib/colorWords.ts`.
// Hãng xe / Dòng xe / Phiên bản đã xoá vĩnh viễn. Bộ chọn "Loại xe" dùng chung
// thành phần chip này nhưng lấy dữ liệu từ danh mục `vehicle_types`
// (`src/lib/useVehicleTypes.ts`), giá trị là id loại xe.

// Chip chỉ chọn phân loại chi phí (type) — nội dung luôn do người dùng tự ghi,
// nên không còn defaultDesc. `id` định danh từng chip vì hai chip có cùng type
// (Lốp xe và Thay nhớt đều là PARTS).
export const VEHICLE_EXPENSE_CHIPS = [
  { id: "REPAIR", type: "REPAIR", label: "Sửa chữa" },
  { id: "TIRE", type: "PARTS", label: "Lốp xe" },
  { id: "OIL", type: "PARTS", label: "Thay nhớt" },
  { id: "CLEANING", type: "CLEANING", label: "Rửa / Vệ sinh" },
  { id: "TRANSPORT", type: "TRANSPORT", label: "Vận chuyển" },
  { id: "PAPERWORK", type: "PAPERWORK", label: "Giấy tờ" },
  { id: "OTHER", type: "OTHER", label: "Khác" },
];
