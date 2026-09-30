import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bike,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  Scale,
  Search,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate } from "@/lib/permissions";

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
      className="search-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Thao tác nhanh"
    >
      <div
        className="quick-actions-modal"
        ref={panel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="quick-modal-header">
          <div className="row" style={{ gap: "8px", alignItems: "center" }}>
            <Zap size={20} style={{ color: "#eab308" }} />
            <h2 style={{ fontSize: "16px", margin: 0 }}>Thao tác nhanh</h2>
          </div>
          <button
            className="icon-button small"
            onClick={onClose}
            aria-label="Đóng"
          >
            <X size={18} />
          </button>
        </div>

        <div className="quick-modal-grid">
          <button
            type="button"
            className="quick-action-tile"
            onClick={() => handleAction("/assist")}
          >
            <div className="tile-icon">
              <Search size={22} />
            </div>
            <div className="tile-text">
              <strong>Hỏi Xe CRM</strong>
              <span>Tra cứu hoặc chuẩn bị bản nháp</span>
            </div>
          </button>
          <button
            type="button"
            className="quick-action-tile"
            onClick={() => handleAction("/capture")}
          >
            <div className="tile-icon">
              <Search size={22} />
            </div>
            <div className="tile-text">
              <strong>Quét / Chụp</strong>
              <span>Quét QR hoặc chụp ảnh xe</span>
            </div>
          </button>
          {canOperate(profile) && (
            <>
              <button
                type="button"
                className="quick-action-tile tile-primary"
                onClick={() => handleAction("/acquisitions/new")}
              >
                <div className="tile-icon">
                  <ArrowDownLeft size={22} />
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
              >
                <div className="tile-icon">
                  <ArrowUpRight size={22} />
                </div>
                <div className="tile-text">
                  <strong>Bán xe cho khách</strong>
                  <span>Chọn xe trong kho và lập giao dịch bán hàng</span>
                </div>
              </button>

              <button
                type="button"
                className="quick-action-tile"
                onClick={() => handleAction("/receivables")}
              >
                <div className="tile-icon">
                  <CreditCard size={22} />
                </div>
                <div className="tile-text">
                  <strong>Quản lý công nợ</strong>
                  <span>Xem nợ phải thu, nợ quá hạn và thu nợ</span>
                </div>
              </button>

              <button
                type="button"
                className="quick-action-tile"
                onClick={() => handleAction("/import-vehicles")}
              >
                <div className="tile-icon">
                  <FileSpreadsheet size={22} />
                </div>
                <div className="tile-text">
                  <strong>Nhập xe từ file Excel/CSV</strong>
                  <span>Tải lên danh sách xe hàng loạt</span>
                </div>
              </button>
            </>
          )}

          {canManage(profile) && (
            <>
              <button
                type="button"
                className="quick-action-tile"
                onClick={() => handleAction("/reconciliation")}
              >
                <div className="tile-icon">
                  <Scale size={22} />
                </div>
                <div className="tile-text">
                  <strong>Đối soát cuối ngày</strong>
                  <span>Kiểm tra doanh thu, tiền mặt và tiền gửi</span>
                </div>
              </button>

              <button
                type="button"
                className="quick-action-tile"
                onClick={() => handleAction("/expenses")}
              >
                <div className="tile-icon">
                  <ClipboardList size={22} />
                </div>
                <div className="tile-text">
                  <strong>Thêm chi phí</strong>
                  <span>Ghi nhận chi phí sửa chữa hoặc chi phí cửa hàng</span>
                </div>
              </button>
            </>
          )}

          <button
            type="button"
            className="quick-action-tile"
            onClick={() => handleAction(undefined, onOpenSearch)}
          >
            <div className="tile-icon">
              <Search size={22} />
            </div>
            <div className="tile-text">
              <strong>Tìm kiếm nhanh</strong>
              <span>Tìm số khung, biển số, xe, khách hàng (Ctrl+K)</span>
            </div>
          </button>

          <button
            type="button"
            className="quick-action-tile"
            onClick={() => handleAction("/customers")}
          >
            <div className="tile-icon">
              <Users size={22} />
            </div>
            <div className="tile-text">
              <strong>Lịch sử khách hàng</strong>
              <span>Tra cứu lịch sử mua hàng theo số điện thoại</span>
            </div>
          </button>

          <button
            type="button"
            className="quick-action-tile"
            onClick={() => handleAction("/vehicles")}
          >
            <div className="tile-icon">
              <Bike size={22} />
            </div>
            <div className="tile-text">
              <strong>Mở kho xe</strong>
              <span>Xem danh sách tồn kho, lọc theo giá và trạng thái</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
