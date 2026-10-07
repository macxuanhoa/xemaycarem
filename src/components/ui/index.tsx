import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  ChevronDown,
  Inbox,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { Button } from "./button";
import { DatePicker } from "./DatePicker";
import { ColorSwatchAction } from "./ColorSwatchAction";
import { GroupedIntegerInput } from "./GroupedIntegerInput";
import { friendlyError } from "@/lib/errors";
import { datePreset } from "@/lib/format";
import type { DateFilter } from "@/types";
export { Button, DatePicker, ColorSwatchAction, GroupedIntegerInput };
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  // Title and primary action always live on one horizontal row (also on phones);
  // the description sits below that row so it can never push the action down.
  return (
    <div className="page-heading">
      <div className="heading-row">
        <h1>{title}</h1>
        {actions && <div className="heading-actions">{actions}</div>}
      </div>
      {description && <p>{description}</p>}
    </div>
  );
}
export function Card({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`card ${className}`} style={style}>
      {children}
    </section>
  );
}
export function Field({
  label,
  error,
  children,
  className = "",
  labelAction,
}: {
  label: string;
  error?: string;
  children: ReactNode;
  /** Extra hook for grid placement (e.g. a field that spans both columns). */
  className?: string;
  /** Optional widget rendered inline with the label (e.g. a colour swatch). */
  labelAction?: ReactNode;
}) {
  const generatedId = useId();
  const controlId = `field-${generatedId}`;
  const errorId = `${controlId}-error`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLLabelElement>(null);
  const hadError = useRef(false);
  let linked = false;
  const controls = Children.map(children, (child) => {
    if (linked || !isValidElement(child)) return child;
    const element = child as ReactElement<Record<string, unknown>>;
    const native = typeof element.type === "string" && ["input", "select", "textarea"].includes(element.type);
    const custom = typeof element.type !== "string" && "onChange" in element.props;
    if (!native && !custom) return child;
    linked = true;
    return cloneElement(element, {
      id: element.props.id ?? controlId,
      "aria-label": element.props["aria-label"] ?? (custom ? label : undefined),
      "aria-invalid": error ? true : element.props["aria-invalid"],
      "aria-describedby": [element.props["aria-describedby"], error ? errorId : undefined].filter(Boolean).join(" ") || undefined,
    });
  });
  useEffect(() => {
    // Older custom controls do not all forward input ARIA/id props. Link their
    // real control without nesting labels around calendars, shortcuts or buttons.
    const control = wrapperRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([aria-hidden="true"]), select:not([aria-hidden="true"]), textarea:not([aria-hidden="true"]), [role="combobox"]:not([aria-hidden="true"])');
    if (!control) return;
    if (!control.id) control.id = controlId;
    if (labelRef.current) labelRef.current.htmlFor = control.id;
    const descriptions = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== errorId);
    if (error) descriptions.push(errorId);
    if (descriptions.length) control.setAttribute("aria-describedby", descriptions.join(" "));
    else control.removeAttribute("aria-describedby");
    if (error) control.setAttribute("aria-invalid", "true");
    else if (hadError.current && !control.closest(".money-input-wrap")) control.removeAttribute("aria-invalid");
    hadError.current = !!error;
  }, [children, controlId, error, errorId]);
  return (
    <div ref={wrapperRef} className={`field ${className}`.trim()}>
      {labelAction ? (
        <span className="field-label-row">
          <label ref={labelRef} htmlFor={controlId} className="field-label-text">{label}</label>
          {labelAction}
        </span>
      ) : (
        <label ref={labelRef} htmlFor={controlId}>{label}</label>
      )}
      {controls}
      {error && (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="empty-state">
      <Inbox size={32} strokeWidth={1.3} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
    </div>
  );
}
export const statusLabels: Record<string, string> = {
  IN_STOCK: "Sẵn sàng bán",
  RESERVED: "Giữ chỗ",
  SOLD: "Đã bán",
  CANCELLED: "Đã hủy",
  COMPLETED: "Hoàn tất",
  ACTIVE: "Đang áp dụng",
  OWNER: "Chủ cửa hàng",
  MANAGER: "Quản lý",
  STAFF: "Nhân viên",
  PAID: "Đã thanh toán đủ",
  PARTIALLY_PAID: "Trả một phần",
  UNPAID: "Chưa thanh toán",
  OVERDUE: "Quá hạn",
  DEBT: "Còn nợ",
  QUEUED: "Đang chờ gửi",
  PROCESSING: "Đang gửi",
  SENT: "Đã gửi",
  DELIVERED: "Đã nhận",
  FAILED: "Gửi thất bại",
  SKIPPED: "Đã bỏ qua",
};
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${status.toLowerCase()}`}>
      <span />
      {statusLabels[status] ?? status}
    </span>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} /> Đang tải dữ liệu…
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error?: unknown;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <TriangleAlert size={24} />
      <p>{friendlyError(error)}</p>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          Thử lại
        </Button>
      )}
    </div>
  );
}
export function DateRange({
  value,
  onChange,
}: {
  value: DateFilter;
  onChange: (v: DateFilter) => void;
}) {
  const quickPresets = [
    { id: "today", label: "Hôm nay" },
    { id: "yesterday", label: "Hôm qua" },
    { id: "week", label: "Tuần này" },
    { id: "month", label: "Tháng này" },
    { id: "last-month", label: "Tháng trước" },
  ] as const;

  const findMatchingPreset = (fromVal?: string, toVal?: string): string => {
    if (!fromVal || !toVal) return "custom";
    const m = datePreset("month");
    if (fromVal === m.from && toVal === m.to) return "month";
    const t = datePreset("today");
    if (fromVal === t.from && toVal === t.to) return "today";
    const w = datePreset("week");
    if (fromVal === w.from && toVal === w.to) return "week";
    const lm = datePreset("last-month");
    if (fromVal === lm.from && toVal === lm.to) return "last-month";
    const y = datePreset("yesterday");
    if (fromVal === y.from && toVal === y.to) return "yesterday";
    return "custom";
  };

  // Sanitize initial value: guarantee start <= end
  const initialFrom =
    value.from && value.to && value.from > value.to ? value.to : value.from;
  const initialTo =
    value.from && value.to && value.from > value.to ? value.from : value.to;

  const [draft, setDraft] = useState({ from: initialFrom, to: initialTo });
  const [activePreset, setActivePreset] = useState<string>(() =>
    findMatchingPreset(initialFrom, initialTo),
  );
  const { from, to } = value;

  useEffect(() => {
    let safeFrom = from;
    let safeTo = to;
    if (safeFrom && safeTo && safeFrom > safeTo) {
      [safeFrom, safeTo] = [safeTo, safeFrom];
      onChange({ from: safeFrom, to: safeTo });
    }
    setDraft({ from: safeFrom, to: safeTo });

    setActivePreset((prev) => {
      if (prev !== "custom") {
        const current = datePreset(prev);
        if (current.from === safeFrom && current.to === safeTo) {
          return prev;
        }
      }
      return findMatchingPreset(safeFrom, safeTo);
    });
  }, [from, to, onChange]);

  const handlePresetChange = (presetKey: string) => {
    if (presetKey === "custom") {
      setActivePreset("custom");
      return;
    }
    setActivePreset(presetKey);
    const nextRange = datePreset(presetKey);
    setDraft(nextRange);
    onChange(nextRange);
  };

  const handleDateChange = (field: "from" | "to", newIso: string) => {
    setActivePreset("custom");
    if (newIso === "") {
      // An erased field must not leave a stale boundary behind in the draft.
      setDraft((d) => ({ ...d, [field]: "" }));
      return;
    }
    if (!newIso || !/^\d{4}-\d{2}-\d{2}$/.test(newIso)) return;
    const nextFrom = field === "from" ? newIso : draft.from;
    const nextTo = field === "to" ? newIso : draft.to;
    if (!nextFrom || !nextTo) {
      // Incomplete ranges stay local until both boundaries are provided.
      setDraft({ from: nextFrom, to: nextTo });
      return;
    }
    // Intelligently swap if user inputs/picks start > end
    const nextRange =
      nextFrom > nextTo ? { from: nextTo, to: nextFrom } : { from: nextFrom, to: nextTo };
    setDraft(nextRange);
    onChange(nextRange);
  };

  return (
    <div className="date-range-cluster">
      {/* 1-Click Segmented Time Chips */}
      <div
        className="date-segmented-bar"
        role="group"
        aria-label="Lọc thời gian"
      >
        {quickPresets.map((p) => {
          const isActive = activePreset === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className={`date-seg-btn ${isActive ? "active" : ""}`}
              aria-pressed={isActive}
              onClick={() => handlePresetChange(p.id)}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          className={`date-seg-btn date-seg-btn-custom ${activePreset === "custom" ? "active" : ""}`}
          aria-pressed={activePreset === "custom"}
          onClick={() => handlePresetChange("custom")}
        >
          <span>Tùy chọn ngày</span>
          <ChevronDown size={13} className="date-seg-icon" aria-hidden="true" />
        </button>
      </div>

      {activePreset === "custom" && (
        <div
          className="date-inputs-pill custom-active"
          role="region"
          aria-label="Khoảng ngày tùy chọn"
        >
          <Calendar size={13} className="date-input-icon" aria-hidden="true" />
          <DatePicker
            value={draft.from}
            onChange={(val) => handleDateChange("from", val)}
            aria-label="Từ ngày (DD/MM/YYYY)"
            className="date-range-picker"
          />
          <span className="date-sep" aria-hidden="true">
            →
          </span>
          <DatePicker
            value={draft.to}
            onChange={(val) => handleDateChange("to", val)}
            aria-label="Đến ngày (DD/MM/YYYY)"
            className="date-range-picker"
            align="right"
          />
        </div>
      )}
    </div>
  );
}
/** Builds the clickable page button list, collapsing long ranges with "…". */
function pageWindow(
  current: number,
  count: number,
): (number | "gap")[] {
  if (count <= 7) {
    return Array.from({ length: count }, (_, index) => index + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, "gap", count];
  }
  if (current >= count - 3) {
    return [1, "gap", count - 4, count - 3, count - 2, count - 1, count];
  }
  return [1, "gap", current - 1, current, current + 1, "gap", count];
}
export function Pagination({
  page,
  total,
  pageSize,
  onChange,
  view,
  onViewChange,
  showSizes = false,
  sizeOptions = [6, 12, 24],
  onPrefetchPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
  /** Current display mode: "ALL" shows every row, a number paginates. */
  view?: "ALL" | number;
  /** When provided, renders the segmented control (hidden by default). */
  onViewChange?: (view: "ALL" | number) => void;
  showSizes?: boolean;
  sizeOptions?: number[];
  /** Optional callback to prefetch page data on hover/focus */
  onPrefetchPage?: (page: number) => void;
}) {
  const size = view === "ALL" ? Math.max(total, 1) : pageSize;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(size, 1)));
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const pages = pageWindow(currentPage, pageCount);
  return (
    <div className="pagination">
      <span className="pagination-info">
        {total
          ? `Hiển thị ${Math.min((currentPage - 1) * size + 1, total)}–${Math.min(currentPage * size, total)} trong ${total} kết quả (Trang ${currentPage}/${pageCount})`
          : "0 kết quả"}
      </span>
      <div className="pagination-controls">
        {showSizes && onViewChange && (
          <div
            className="pagination-sizes"
            role="group"
            aria-label="Chế độ hiển thị kết quả"
          >
            {(["ALL", ...sizeOptions] as const).map((option) => (
              <button
                key={String(option)}
                type="button"
                className={`pagination-size${view === option ? " active" : ""}`}
                aria-pressed={view === option}
                onClick={() => onViewChange(option)}
              >
                {option === "ALL" ? "Tất cả" : option}
              </button>
            ))}
          </div>
        )}
        <div className="row pagination-buttons-row">
          <Button
            aria-label="Trang trước"
            variant="secondary"
            disabled={currentPage <= 1}
            onClick={() => onChange(currentPage - 1)}
            onMouseEnter={() => currentPage > 1 && onPrefetchPage?.(currentPage - 1)}
            onFocus={() => currentPage > 1 && onPrefetchPage?.(currentPage - 1)}
          >
            <ArrowLeft size={16} />
          </Button>
          {pages.map((entry, index) =>
            entry === "gap" ? (
              <span key={`gap-${index}`} className="pagination-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                className={`pagination-page${entry === currentPage ? " active" : ""}`}
                aria-current={entry === currentPage ? "page" : undefined}
                aria-label={`Xem trang ${entry}`}
                onClick={() => onChange(entry)}
                onMouseEnter={() => onPrefetchPage?.(entry)}
                onFocus={() => onPrefetchPage?.(entry)}
              >
                {entry}
              </button>
            ),
          )}
          <Button
            aria-label="Trang sau"
            variant="secondary"
            disabled={currentPage >= pageCount}
            onClick={() => onChange(currentPage + 1)}
            onMouseEnter={() => currentPage < pageCount && onPrefetchPage?.(currentPage + 1)}
            onFocus={() => currentPage < pageCount && onPrefetchPage?.(currentPage + 1)}
          >
            <ArrowRight size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
}
