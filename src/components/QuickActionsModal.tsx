import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bike,
  CreditCard,
  ClipboardList,
  ScanLine,
  Search,
  Sparkles,
  Store,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate } from "@/lib/permissions";
import { preloadRoute } from "@/lib/routePreload";

export function QuickActionsModal({
  open,
  onClose,
  onOpenSearch,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSearch: () => void;
}) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        panel.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      const first = buttons[0],
        last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleAction = (path?: string, customFn?: () => void) => {
    onClose();
    if (customFn) {
      customFn();
    } else if (path) {
      navigate(path);
    }
  };

  return (
    <div
      className="search-modal-backdrop quick-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Bảng thao tác nhanh Cà Rem"
    >
      <div
        className="quick-actions-modal"
        ref={panel}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="quick-modal-header">
          <div className="row" style={{ gap: "10px", alignItems: "center" }}>
            <div className="quick-modal-icon-badge">
              <Zap size={18} />
            </div>
            <div>
              <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0 }}>
                  Thao tác nhanh Cà Rem
                </h2>
                <span className="carem-shortcut-hint">Phím tắt Q</span>
              </div>
              <p className="muted small" style={{ margin: "2px 0 0" }}>
                Chọn tác vụ bạn muốn thực hiện ngay
              </p>
            </div>
          </div>
          <button
            className="icon-button small quick-modal-close"
            onClick={onClose}
            aria-label="Đóng bảng thao tác"
            title="Đóng (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* Section 1: Giao dịch chính */}
        {canOperate(profile) && (
          <div className="quick-group">
            <span className="quick-group-caption">GIAO DỊCH CỬA HÀNG</span>
            <div className="quick-modal-grid">
              <button
                type="button"
                className="quick-action-tile tile-primary"
                onClick={() => handleAction("/acquisitions/new")}
                onMouseEnter={() => preloadRoute("/acquisitions/new")}
                onFocus={() => preloadRoute("/acquisitions/new")}
              >
                <div className="tile-icon">
                  <ArrowDownLeft size={20} />
                </div>
                <div className="tile-text">
                  <strong>Thu xe vào kho</strong>
                  <span>Tạo phiếu thu mua xe mới vào tồn kho</span>
                </div>
              </button>

              <button
                type="button"
                className="quick-action-tile tile-accent"
                onClick={() => handleAction("/sell")}
                onMouseEnter={() => preloadRoute("/sell")}
                onFocus={() => preloadRoute("/sell")}
              >
                <div className="tile-icon">
                  <ArrowUpRight size={20} />
                </div>
                <div className="tile-text">
                  <strong>Bán xe cho khách</strong>
                  <span>Chọn xe trong kho và lập giao dịch bán hàng</span>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Section 2: Tra cứu & AI */}
        <div className="quick-group">
          <span className="quick-group-caption">TRA CỨU &amp; CÔNG CỤ</span>
          <div className="quick-modal-grid">
            <button
              type="button"
              className="quick-action-tile"
              onClick={() => handleAction("/vehicles")}
              onMouseEnter={() => preloadRoute("/vehicles")}
              onFocus={() => preloadRoute("/vehicles")}
            >
              <div className="tile-icon">
                <Bike size={20} />
              </div>
              <div className="tile-text">
                <strong>Mở kho xe</strong>
                <span>Xem danh sách tồn kho, lọc theo giá và trạng thái</span>
              </div>
            </button>

            <button
              type="button"
              className="quick-action-tile"
              onClick={() => handleAction(undefined, onOpenSearch)}
            >
              <div className="tile-icon">
                <Search size={20} />
              </div>
              <div className="tile-text">
                <div className="row between" style={{ alignItems: "center" }}>
                  <strong>Tìm kiếm nhanh</strong>
                  <kbd className="tile-kbd">Ctrl+K</kbd>
                </div>
                <span>Số khung, biển số, xe, khách hàng</span>
              </div>
            </button>

            <button
              type="button"
              className="quick-action-tile tile-ai"
              onClick={() => handleAction("/assist")}
              onMouseEnter={() => preloadRoute("/assist")}
              onFocus={() => preloadRoute("/assist")}
            >
              <div className="tile-icon">
                <Sparkles size={20} />
              </div>
              <div className="tile-text">
                <strong>Hỏi Cà Rem AI</strong>
                <span>Tra cứu dữ liệu hoặc chuẩn bị bản nháp tự động</span>
              </div>
            </button>

            <button
              type="button"
              className="quick-action-tile"
              onClick={() => handleAction("/capture")}
              onMouseEnter={() => preloadRoute("/capture")}
              onFocus={() => preloadRoute("/capture")}
            >
              <div className="tile-icon">
                <ScanLine size={20} />
              </div>
              <div className="tile-text">
                <strong>Quét / Chụp</strong>
                <span>Quét mã QR xe hoặc chụp ảnh căn cước / giấy tờ</span>
              </div>
            </button>
          </div>
        </div>

        {/* Section 3: Tài chính & Vận hành - SIMPLIFIED */}
        <div className="quick-group">
          <span className="quick-group-caption">TÀI CHÍNH &amp; QUẢN TRỊ</span>
          <div className="quick-modal-grid">
            {canOperate(profile) && (
              <button
                type="button"
                className="quick-action-tile"
                onClick={() => handleAction("/receivables")}
                onMouseEnter={() => preloadRoute("/receivables")}
                onFocus={() => preloadRoute("/receivables")}
              >
                <div className="tile-icon">
                  <CreditCard size={20} />
                </div>
                <div className="tile-text">
                  <strong>Quản lý công nợ</strong>
                  <span>Xem nợ phải thu, nợ quá hạn và thu nợ</span>
                </div>
              </button>
            )}

            {canManage(profile) && (
              <button
                type="button"
                className="quick-action-tile"
                onClick={() => handleAction("/expenses")}
                onMouseEnter={() => preloadRoute("/expenses")}
                onFocus={() => preloadRoute("/expenses")}
              >
                <div className="tile-icon">
                  <ClipboardList size={20} />
                </div>
                <div className="tile-text">
                  <strong>Quản lý chi phí</strong>
                  <span>Ghi nhận chi phí xe và chi phí cửa hàng</span>
                </div>
              </button>
            )}

            <button
              type="button"
              className="quick-action-tile"
              onClick={() => handleAction("/customers")}
              onMouseEnter={() => preloadRoute("/customers")}
              onFocus={() => preloadRoute("/customers")}
            >
              <div className="tile-icon">
                <Users size={20} />
              </div>
              <div className="tile-text">
                <strong>Lịch sử khách hàng</strong>
                <span>Tra cứu lịch sử mua bán theo số điện thoại</span>
              </div>
            </button>

            <button
              type="button"
              className="quick-action-tile tile-showroom"
              onClick={() => {
                onClose();
                window.open("/showroom", "_blank");
              }}
            >
              <div className="tile-icon">
                <Store size={20} />
              </div>
              <div className="tile-text">
                <div className="row between" style={{ alignItems: "center" }}>
                  <strong>Xem Showroom Khách</strong>
                  <span className="tile-badge-live">Trực tuyến</span>
                </div>
                <span>Mở trang web bán xe Cà Rem Hội An</span>
              </div>
            </button>
          </div>
        </div>

        {/* Footer info */}
        <div className="quick-modal-footer">
          <span>Nhấn <kbd>Esc</kbd> để đóng · Nhấn <kbd>Q</kbd> bất kỳ lúc nào để mở lại</span>
        </div>
      </div>
    </div>
  );
}
