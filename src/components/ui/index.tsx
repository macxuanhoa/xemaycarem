import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Inbox,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { Button } from "./button";
import { friendlyError } from "@/lib/errors";
import { datePreset } from "@/lib/format";
import type { DateFilter } from "@/types";
export { Button };
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
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
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
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
  IN_STOCK: "Trong kho",
  RESERVED: "Giữ chỗ",
  SOLD: "Đã bán",
  CANCELLED: "Đã hủy",
  COMPLETED: "Hoàn tất",
  ACTIVE: "Đang áp dụng",
  OWNER: "Chủ cửa hàng",
  MANAGER: "Quản lý",
  STAFF: "Nhân viên",
  VIEWER: "Chỉ xem",
  PAID: "Đã thanh toán đủ",
  PARTIALLY_PAID: "Trả một phần",
  UNPAID: "Chưa thanh toán",
  OVERDUE: "Quá hạn",
  DEBT: "Còn nợ",
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
  const presets = ["today", "yesterday", "week", "month", "last-month"] as const;
  const [draft, setDraft] = useState(value);
  const [isCustom, setIsCustom] = useState(false);
  const { from, to } = value;

  useEffect(() => {
    setDraft({ from, to });
  }, [from, to]);

  const matchedPreset = presets.find((key) => {
    const range = datePreset(key);
    return range.from === draft.from && range.to === draft.to;
  });

  const selected = isCustom || !matchedPreset ? "custom" : matchedPreset;

  const handlePresetChange = (presetKey: string) => {
    if (presetKey === "custom") {
      setIsCustom(true);
      return;
    }
    setIsCustom(false);
    const nextRange = datePreset(presetKey);
    setDraft(nextRange);
    onChange(nextRange);
  };

  const handleInputChange = (field: "from" | "to", nextVal: string) => {
    setIsCustom(true);
    const nextDraft = { ...draft, [field]: nextVal };
    setDraft(nextDraft);
    if (
      nextDraft.from &&
      nextDraft.to &&
      nextDraft.from <= nextDraft.to &&
      (nextDraft.from !== value.from || nextDraft.to !== value.to)
    ) {
      onChange(nextDraft);
    }
  };

  return (
    <div className="date-range">
      <select
        aria-label="Khoảng thời gian"
        value={selected}
        onChange={(e) => handlePresetChange(e.target.value)}
      >
        <option value="today">Hôm nay</option>
        <option value="yesterday">Hôm qua</option>
        <option value="week">Tuần này</option>
        <option value="month">Tháng này</option>
        <option value="last-month">Tháng trước</option>
        <option value="custom">Tùy chọn</option>
      </select>
      <input
        aria-label="Từ ngày"
        type="date"
        value={draft.from}
        onChange={(e) => handleInputChange("from", e.target.value)}
      />
      <span>—</span>
      <input
        aria-label="Đến ngày"
        type="date"
        value={draft.to}
        onChange={(e) => handleInputChange("to", e.target.value)}
      />
    </div>
  );
}
export function Pagination({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total
          ? `${Math.min((page - 1) * pageSize + 1, total)}–${Math.min(page * pageSize, total)} / ${total} kết quả`
          : "0 kết quả"}
      </span>
      <div className="row">
        <Button
          aria-label="Trang trước"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ArrowLeft size={16} />
        </Button>
        <span>Trang {page}</span>
        <Button
          aria-label="Trang sau"
          variant="secondary"
          disabled={page * pageSize >= total}
          onClick={() => onChange(page + 1)}
        >
          <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}
