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

// Default catalogs tuned for Cà Rem's frequent stock. OWNER can override the
// whole list from Cài đặt → "Chọn nhanh xe"; the forms read the shop's saved
// catalog through `useQuickPick` and fall back to these defaults on first run
// or when the settings row is missing.
export const BRAND_CHIPS: Array<{ value: string; label: string }> = [
  { value: "Honda", label: "Honda" },
  { value: "Piaggio", label: "Piaggio" },
  { value: "Suzuki", label: "Suzuki" },
  { value: "Yamaha", label: "Yamaha" },
];

// Colour quick-pick chips were replaced with an inline `<input type="color">`
// swatch rendered next to the "Màu sắc" field label (see
// `src/components/ui/ColorSwatchAction.tsx`). Staff now pick the paint tone
// visually and the app stores the nearest Vietnamese word via
// `src/lib/colorWords.ts`.

// Keys are lowercase brand names — always look up via
// `COMMON_MODELS_BY_BRAND[brand.trim().toLowerCase()]`.
export const COMMON_MODELS_BY_BRAND: Record<string, string[]> = {
  honda: [
    "SH 125i",
    "SH 150i",
    "SH 160i",
    "SH Mode",
    "Vision",
    "Air Blade",
    "Lead",
    "Wave",
    "Future",
    "Dax ST125",
  ],
  piaggio: ["Vespa Sprint", "Vespa Primavera"],
  suzuki: ["Satria", "Raider"],
  yamaha: ["Exciter"],
};

/** Canonical plain-text form used by the Settings editor and reset button.
 *  One brand per line: "<Brand>: <model>, <model>, …". */
export const DEFAULT_QUICKPICK_TEXT = [
  "Honda: SH 125i, SH 150i, SH 160i, SH Mode, Vision, Air Blade, Lead, Wave, Future, Dax ST125",
  "Piaggio: Vespa Sprint, Vespa Primavera",
  "Suzuki: Satria, Raider",
  "Yamaha: Exciter",
].join("\n");

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
