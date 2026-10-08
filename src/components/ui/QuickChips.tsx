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

export const VEHICLE_EXPENSE_CHIPS = [
  { type: "REPAIR", label: "Sửa chữa", defaultDesc: "Sửa chữa kỹ thuật" },
  { type: "PARTS", label: "Lốp xe", defaultDesc: "Thay lốp xe" },
  {
    type: "PARTS",
    label: "Thay nhớt",
    defaultDesc: "Thay nhớt máy / nhớt láp",
  },
  {
    type: "CLEANING",
    label: "Rửa / Vệ sinh",
    defaultDesc: "Rửa xe & vệ sinh chi tiết",
  },
  {
    type: "TRANSPORT",
    label: "Vận chuyển",
    defaultDesc: "Phí vận chuyển xe về kho",
  },
  {
    type: "PAPERWORK",
    label: "Giấy tờ",
    defaultDesc: "Phí sang tên / giấy tờ xe",
  },
  { type: "OTHER", label: "Khác", defaultDesc: "Chi phí phát sinh khác" },
];
