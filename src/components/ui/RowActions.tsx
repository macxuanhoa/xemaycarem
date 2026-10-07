import type { MouseEvent } from "react";
import { Link, type To } from "react-router-dom";
import { Eye, Trash2 } from "lucide-react";
import { preloadRoute } from "@/lib/routePreload";

/**
 * The two row affordances shared by the "Thu vào" (acquisitions) and "Tồn kho"
 * (inventory) tables. Keeping them in one component guarantees the detail and
 * delete actions look and behave identically across both lists — the old bare
 * `ArrowRight` / raw `Trash2` icon-buttons read as unfinished. Each is a soft
 * labelled pill (icon + word) rather than an ambiguous glyph.
 */

type ViewActionProps = {
  to: To;
  /** Plain-language object name for screen readers, e.g. "xe Honda SH 160i". */
  label: string;
  state?: unknown;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onMouseEnter?: () => void;
  onFocus?: () => void;
};

export function RowViewAction({
  to,
  label,
  state,
  onClick,
  onMouseEnter,
  onFocus,
}: ViewActionProps) {
  const handleMouseEnter = () => {
    if (typeof to === "string") preloadRoute(to);
    onMouseEnter?.();
  };
  const handleFocus = () => {
    if (typeof to === "string") preloadRoute(to);
    onFocus?.();
  };

  return (
    <Link
      className="row-action row-view"
      to={to}
      state={state}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onFocus={handleFocus}
      aria-label={`Xem chi tiết ${label}`}
      title={`Xem chi tiết ${label}`}
    >
      <Eye size={15} aria-hidden="true" />
      <span>Chi tiết</span>
    </Link>
  );
}

type DeleteActionProps = {
  /** Plain-language object name for the accessible label, e.g. "phiếu thu xe …". */
  label: string;
  title?: string;
  onClick: () => void;
};

export function RowDeleteAction({ label, title, onClick }: DeleteActionProps) {
  return (
    <button
      type="button"
      className="row-action row-danger"
      onClick={onClick}
      aria-label={`Xóa ${label}`}
      title={title ?? `Xóa ${label}`}
    >
      <Trash2 size={15} aria-hidden="true" />
      <span>Xóa</span>
    </button>
  );
}
