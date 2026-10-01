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

// Predefined high-frequency catalogs for Vietnam motorcycle shops
export const BRAND_CHIPS = [
  { value: "Honda", label: "Honda" },
  { value: "Yamaha", label: "Yamaha" },
  { value: "Suzuki", label: "Suzuki" },
  { value: "SYM", label: "SYM" },
  { value: "Piaggio", label: "Piaggio / Vespa" },
];

export const COLOR_CHIPS = [
  { value: "Trắng", label: "Trắng" },
  { value: "Đen", label: "Đen" },
  { value: "Đỏ", label: "Đỏ" },
  { value: "Xám", label: "Xám" },
  { value: "Xanh", label: "Xanh" },
  { value: "Bạc", label: "Bạc" },
];

export const COMMON_MODELS_BY_BRAND: Record<string, string[]> = {
  honda: [
    "SH 160i",
    "SH 125i",
    "SH Mode",
    "Vision",
    "Air Blade 125",
    "Air Blade 160",
    "Wave Alpha",
    "Wave RSX",
    "Future 125",
    "Lead",
    "Winner X",
    "Vario 160",
  ],
  yamaha: [
    "Exciter 155",
    "Grande",
    "Janus",
    "NVX 155",
    "Sirius",
    "Jupiter",
    "Latte",
  ],
  piaggio: [
    "Vespa Sprint",
    "Vespa Primavera",
    "Vespa GTS",
    "Liberty 125",
    "Medley",
  ],
  suzuki: ["Raider 150", "Satria 150", "Burgman Street"],
  sym: ["Attila", "Galaxy 50", "Elegant 50"],
};

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
