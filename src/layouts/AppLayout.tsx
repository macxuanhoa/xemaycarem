import { Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  NavLink,
  Outlet,
  Link,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import {
  ArrowDownLeft,
  ChartNoAxesCombined,
  ClipboardList,
  CreditCard,
  House,
  LogOut,
  Menu,
  Bike,
  Package,
  Plus,
  Receipt,
  Scale,
  Settings,
  ShieldCheck,
  Users,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate, isOwner, roleLabels } from "@/lib/permissions";
import { Loading } from "@/components/ui";
import { useMobileDrawer } from "@/lib/useMobileDrawer";
import { GlobalSearchPalette } from "@/components/search/GlobalSearchPalette";
import { QuickActionsModal } from "@/components/QuickActionsModal";

const mainNav = [
  { to: "/", label: "Dashboard", icon: House },
  { to: "/acquisitions", label: "Thu vào", icon: ArrowDownLeft },
  { to: "/vehicles", label: "Tồn kho", icon: Bike },
  { to: "/sales", label: "Bán ra", icon: Receipt },
  { to: "/receivables", label: "Công nợ", icon: CreditCard },
  { to: "/customers", label: "Khách hàng", icon: Users },
  { to: "/reconciliation", label: "Đối soát", icon: Scale },
  { to: "/expenses", label: "Chi phí", icon: ClipboardList },
  { to: "/reports", label: "Báo cáo", icon: ChartNoAxesCombined },
];
export default function AppLayout() {
  const { profile, signOut } = useAuth();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<{ store_name: string }>("get_settings"),
  });
  const drawer = useMobileDrawer();
  const [online, setOnline] = useState(navigator.onLine);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const { pathname, state } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (
      pathname === "/vehicles" &&
      (navigationType === "POP" || state?.restoreInventory)
    )
      return;
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname, navigationType, state]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const visibleNav = mainNav.filter(
    (n) =>
      !["/reports", "/expenses", "/reconciliation"].includes(n.to) ||
      canManage(profile),
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" inert={drawer.active}>
        Đến nội dung chính
      </a>
      {drawer.active && (
        <button
          className="sidebar-overlay"
          onClick={drawer.close}
          tabIndex={-1}
          aria-hidden="true"
        />
      )}
      <aside
        id="main-navigation"
        ref={drawer.panelRef}
        className={`sidebar ${drawer.active ? "open" : ""}`}
        inert={drawer.mobile && !drawer.active}
        aria-hidden={drawer.mobile && !drawer.active ? true : undefined}
        role={drawer.active ? "dialog" : undefined}
        aria-modal={drawer.active ? true : undefined}
        aria-label="Điều hướng cửa hàng"
      >
        <Link to="/" className="brand" onClick={drawer.close}>
          <span className="brand-icon">
            <img src="/logo.jpg" alt="Logo Cà Rém" className="brand-logo-img" />
          </span>
          <span>
            Xe CRM<small>QUẢN LÝ CỬA HÀNG XE</small>
          </span>
        </Link>
        <button
          className="mobile-menu-close"
          aria-label="Đóng menu"
          onClick={drawer.close}
        >
          <X />
        </button>
        <p className="nav-caption">KHÔNG GIAN LÀM VIỆC</p>
        <nav aria-label="Chính">
          {visibleNav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} onClick={drawer.close}>
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {isOwner(profile) && (
            <>
              <p className="nav-caption">QUẢN TRỊ</p>
              <nav aria-label="Quản trị">
                <NavLink to="/users" onClick={drawer.close}>
                  <Users size={20} />
                  Nhân sự
                </NavLink>
                <NavLink to="/audit" onClick={drawer.close}>
                  <ShieldCheck size={20} />
                  Lịch sử thao tác
                </NavLink>
              </nav>
            </>
          )}
          <nav>
            <NavLink to="/settings" onClick={drawer.close}>
              <Settings size={20} />
              Cài đặt
            </NavLink>
          </nav>
          <div className="store-card">
            <span className="store-avatar">
              <Package size={21} />
            </span>
            <div>
              <strong>{settings.data?.store_name ?? "Cửa hàng của bạn"}</strong>
              <small>{roleLabels[profile!.role]}</small>
            </div>
            <span
              className={`connection-dot ${online ? "" : "offline"}`}
              title={online ? "Đã kết nối" : "Mất kết nối"}
            />
          </div>
        </div>
      </aside>
      <div className="workspace" inert={drawer.active}>
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Mở menu"
            aria-expanded={drawer.active}
            aria-controls="main-navigation"
            onClick={(event) => drawer.show(event.currentTarget)}
          >
            <Menu size={22} />
          </button>
          <GlobalSearchPalette />
          <button
            type="button"
            className="header-quick-action-btn"
            onClick={() => setQuickActionsOpen(true)}
            title="Thao tác nhanh"
            aria-label="Mở bảng thao tác nhanh"
          >
            <Zap size={16} />
            <span>Thao tác</span>
          </button>
          <div className="topbar-right">
            <span className="workday">
              {new Intl.DateTimeFormat("vi-VN", {
                weekday: "long",
                day: "2-digit",
                month: "2-digit",
                timeZone: "Asia/Ho_Chi_Minh",
              }).format(new Date())}
            </span>
            <span className="topbar-divider" />
            <Link to="/settings" className="user-chip">
              <span className="avatar">
                {profile?.full_name?.split(" ").at(-1)?.[0] ?? "U"}
              </span>
              <span>
                {profile?.full_name}
                <small>{roleLabels[profile!.role]}</small>
              </span>
            </Link>
            <button
              className="icon-button"
              aria-label="Đăng xuất"
              title="Đăng xuất"
              onClick={() => void signOut()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        {!online && (
          <div className="offline-banner" role="alert">
            <WifiOff size={18} /> Mất kết nối. Các giao dịch mới chưa được gửi;
            hãy kết nối mạng để tiếp tục.
          </div>
        )}
        <main className="main-content" id="main-content" tabIndex={-1}>
          <Suspense key={pathname} fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
        <footer className="workspace-footer">
          <span>Xe CRM · Mọi hoạt động, một nơi quản lý.</span>
          <span>
            <ShieldCheck size={13} /> Dữ liệu được phân quyền
          </span>
        </footer>
      </div>
      <nav
        className="bottom-nav"
        aria-label="Điều hướng nhanh"
        inert={drawer.active}
      >
        <NavLink to="/" end>
          <House size={21} />
          Tổng quan
        </NavLink>
        {canOperate(profile) && (
          <NavLink to="/acquisitions/new">
            <Plus size={22} />
            Thu xe
          </NavLink>
        )}
        <NavLink to="/vehicles">
          <Bike size={21} />
          Tồn kho
        </NavLink>
        <button
          type="button"
          onClick={() => setQuickActionsOpen(true)}
          aria-label="Thao tác nhanh"
        >
          <Zap size={21} />
          Thao tác
        </button>
        <button
          aria-expanded={drawer.active}
          aria-controls="main-navigation"
          onClick={(event) => drawer.show(event.currentTarget)}
        >
          <Menu size={21} />
          Thêm
        </button>
      </nav>

      <QuickActionsModal
        open={quickActionsOpen}
        onClose={() => setQuickActionsOpen(false)}
        onOpenSearch={() => {
          const input = document.querySelector<HTMLInputElement>(
            '.global-search input[type="search"]',
          );
          input?.focus();
        }}
      />
    </div>
  );
}
