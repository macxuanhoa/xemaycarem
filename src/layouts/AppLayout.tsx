import { Suspense, useEffect, useMemo, useState } from "react";
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
  BookOpen,
  ChartNoAxesCombined,
  ExternalLink,
  House,
  LogOut,
  Menu,
  Bike,
  Package,
  Plus,
  Receipt,
  ClipboardList,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
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
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { preloadRoute } from "@/lib/routePreload";

function RouteLoadingFallback() {
  return (
    <div className="route-loading-fallback" role="status" aria-label="Đang tải trang">
      <Loading />
    </div>
  );
}

const mainNav = [
  { to: "/", label: "Tổng quan", icon: House },
  { to: "/acquisitions", label: "Thu vào", icon: ArrowDownLeft },
  { to: "/vehicles", label: "Tồn kho", icon: Bike },
  { to: "/sales", label: "Bán hàng & Thu nợ", icon: Receipt },
  { to: "/customers", label: "Khách hàng", icon: Users },
  { to: "/expenses", label: "Chi phí", icon: ClipboardList },
  { to: "/reports", label: "Báo cáo", icon: ChartNoAxesCombined },
];
export function AppLayout() {
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
    const handleGlobalKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTyping =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
      if (isTyping) return;
      if (
        e.key.toLowerCase() === "q" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        setQuickActionsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, []);

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
      !["/reports", "/expenses"].includes(n.to) ||
      canManage(profile),
  );

  const currentPageTitle = useMemo(() => {
    if (pathname === "/") return "Tổng quan";
    const item = mainNav.find((n) => pathname.startsWith(n.to) && n.to !== "/");
    if (item) return item.label;
    if (pathname.startsWith("/receivables")) return "Bán hàng & Thu nợ";
    if (pathname.startsWith("/expenses")) return "Chi phí";
    if (pathname.startsWith("/settings")) return "Cài đặt";
    if (pathname.startsWith("/audit")) return "Lịch sử thao tác";
    if (pathname.startsWith("/users")) return "Nhân sự";
    if (pathname.startsWith("/capture")) return "Quét giấy tờ";
    if (pathname.startsWith("/copilot")) return "Trợ lý AI";
    if (pathname.startsWith("/docs")) return "Tài liệu cửa hàng";
    if (pathname.startsWith("/import")) return "Nhập dữ liệu";
    if (pathname.startsWith("/sell")) return "Bán xe";
    return "";
  }, [pathname]);
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
            <img src="/logo.jpg" alt="Logo Cà Rem" className="brand-logo-img" />
          </span>
          <span className="brand-text">
            Cà Rem<small>HỆ THỐNG CỬA HÀNG XE</small>
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
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={drawer.close}
              onMouseEnter={() => preloadRoute(to)}
              onFocus={() => preloadRoute(to)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        {/* AI mode: grounded Q&A plus the documentation the answers cite. */}
        {canOperate(profile) && (
          <>
            <p className="nav-caption">TRỢ LÝ AI</p>
            <nav aria-label="Trợ lý AI">
              <NavLink
                to="/copilot"
                onClick={drawer.close}
                onMouseEnter={() => preloadRoute("/copilot")}
                onFocus={() => preloadRoute("/copilot")}
              >
                <Sparkles size={20} />
                <span>Hỏi AI Cà Rem</span>
              </NavLink>
              <NavLink
                to="/docs"
                onClick={drawer.close}
                onMouseEnter={() => preloadRoute("/docs")}
                onFocus={() => preloadRoute("/docs")}
              >
                <BookOpen size={20} />
                <span>Tài liệu cửa hàng</span>
              </NavLink>
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          {isOwner(profile) && (
            <>
              <p className="nav-caption">QUẢN TRỊ</p>
              <nav aria-label="Quản trị">
                <NavLink
                  to="/users"
                  onClick={drawer.close}
                  onMouseEnter={() => preloadRoute("/users")}
                  onFocus={() => preloadRoute("/users")}
                >
                  <Users size={20} />
                  Nhân sự
                </NavLink>
                <NavLink
                  to="/audit"
                  onClick={drawer.close}
                  onMouseEnter={() => preloadRoute("/audit")}
                  onFocus={() => preloadRoute("/audit")}
                >
                  <ShieldCheck size={20} />
                  Lịch sử thao tác
                </NavLink>
              </nav>
            </>
          )}
          <nav>
            <NavLink
              to="/settings"
              onClick={drawer.close}
              onMouseEnter={() => preloadRoute("/settings")}
              onFocus={() => preloadRoute("/settings")}
            >
              <Settings size={20} />
              Cài đặt
            </NavLink>
          </nav>
          <div className="sidebar-showroom-cta">
            <Link
              to="/showroom"
              target="_blank"
              rel="noopener noreferrer"
              className="sidebar-showroom-btn"
              onClick={drawer.close}
            >
              <Store size={18} />
              <span>Xem Showroom Khách</span>
              <ExternalLink size={12} />
            </Link>
          </div>
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
          <div className="topbar-left">
            <button
              className="mobile-menu"
              aria-label="Mở menu"
              aria-expanded={drawer.active}
              aria-controls="main-navigation"
              onClick={(event) => drawer.show(event.currentTarget)}
            >
              <Menu size={22} />
            </button>
            {currentPageTitle && (
              <div className="topbar-breadcrumb" aria-label="Đường dẫn trang">
                <span className="breadcrumb-brand">Cà Rem</span>
                <span className="breadcrumb-sep">/</span>
                <span className="breadcrumb-page">{currentPageTitle}</span>
              </div>
            )}
          </div>
          <GlobalSearchPalette />
          <div className="topbar-actions-group">
            <Link
              to="/showroom"
              target="_blank"
              rel="noopener noreferrer"
              className="header-showroom-link"
              title="Mở Showroom Cà Rem (Trang khách xem xe)"
            >
              <Store size={15} />
              <span>Showroom</span>
              <ExternalLink size={12} style={{ opacity: 0.7 }} />
            </Link>
            <button
              type="button"
              className="header-quick-action-btn"
              onClick={() => setQuickActionsOpen(true)}
              title="Thao tác nhanh (Phím tắt: Q)"
              aria-label="Mở bảng thao tác nhanh"
            >
              <Zap size={15} />
              <span>Thao tác</span>
              <kbd className="header-key-hint">Q</kbd>
            </button>
          </div>
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
        <AnnouncementBar />
        {!online && (
          <div className="offline-banner" role="alert">
            <WifiOff size={18} /> Mất kết nối. Các giao dịch mới chưa được gửi;
            hãy kết nối mạng để tiếp tục.
          </div>
        )}
        <main className="main-content" id="main-content" tabIndex={-1}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Outlet />
          </Suspense>
        </main>
        {!["/acquisitions", "/acquisitions/new", "/vehicles"].includes(pathname) && (
          <footer className="workspace-footer">
            <span>Cà Rem · Vận hành cửa hàng xe máy chuyên nghiệp.</span>
            <span>
              <ShieldCheck size={13} /> Dữ liệu được phân quyền
            </span>
          </footer>
        )}
      </div>
      <nav
        className="bottom-nav"
        aria-label="Điều hướng nhanh"
        inert={drawer.active}
      >
        <NavLink
          to="/"
          end
          onMouseEnter={() => preloadRoute("/")}
          onTouchStart={() => preloadRoute("/")}
        >
          <House size={21} />
          Tổng quan
        </NavLink>
        {canOperate(profile) && (
          <NavLink
            to="/acquisitions/new"
            onMouseEnter={() => preloadRoute("/acquisitions/new")}
            onTouchStart={() => preloadRoute("/acquisitions/new")}
          >
            <Plus size={22} />
            Thu xe
          </NavLink>
        )}
        <NavLink
          to="/vehicles"
          onMouseEnter={() => preloadRoute("/vehicles")}
          onTouchStart={() => preloadRoute("/vehicles")}
        >
          <Bike size={21} />
          Tồn kho
        </NavLink>
        <NavLink
          to="/sales"
          onMouseEnter={() => preloadRoute("/sales")}
          onTouchStart={() => preloadRoute("/sales")}
        >
          <Receipt size={21} />
          Bán ra
        </NavLink>
        <button
          aria-expanded={drawer.active}
          aria-controls="main-navigation"
          onClick={(event) => drawer.show(event.currentTarget)}
        >
          <Menu size={21} />
          Menu
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

export default AppLayout;
