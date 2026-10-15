import { Suspense, useEffect, useMemo, useState } from "react";
import { useNetworkStatus } from "@/lib/networkStatus";
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
  Bot,
  Camera,
  ChevronDown,
  ExternalLink,
  House,
  Inbox,
  LogOut,
  Menu,
  Moon,
  Bike,
  Package,
  Plus,
  ClipboardList,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
  Sun,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate, isOwner, roleLabels } from "@/lib/permissions";
import { Loading } from "@/components/ui";
import { NetworkGuard } from "@/components/NetworkGuard";
import { InstallHint } from "@/components/InstallHint";
import { useMobileDrawer } from "@/lib/useMobileDrawer";
import { GlobalSearchPalette } from "@/components/search/GlobalSearchPalette";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { NotificationBell } from "@/components/NotificationBell";
import { preloadRoute } from "@/lib/routePreload";
import { currentTheme, toggleTheme, type Theme } from "@/lib/theme";
import { useNavBadges } from "@/lib/useNavBadges";

function RouteLoadingFallback() {
  return (
    <div
      className="route-loading-fallback"
      role="status"
      aria-label="Đang tải trang"
    >
      <Loading variant="section" label="Đang tải trang…" />
    </div>
  );
}

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  staffOnly?: boolean;
  badgeKey?: "vehicles" | "acquisitions" | "customers";
};

const mainNav: NavItem[] = [
  { to: "/", label: "Tổng quan", icon: House },
  { to: "/acquisitions", label: "Thu vào", icon: ArrowDownLeft, badgeKey: "acquisitions" },
  { to: "/vehicles", label: "Tồn kho", icon: Bike, badgeKey: "vehicles" },
  { to: "/customers", label: "Khách hàng", icon: Users, badgeKey: "customers" },
  { to: "/expenses", label: "Chi phí", icon: ClipboardList },
];
export function AppLayout() {
  const { profile, signOut } = useAuth();
  const { badges, managementTotal, markSeen } = useNavBadges();
  // Sun/moon switch lives in the mobile header in place of logout (mis-tap guard).
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<{ store_name: string }>("get_settings"),
  });
  const drawer = useMobileDrawer();
  const net = useNetworkStatus();
  const { pathname, state } = useLocation();
  // The AI section stays collapsed until opened, but is revealed on its pages.
  // Seeded from the router location so server-render tests never touch window.
  const [aiSectionOpen, setAiSectionOpen] = useState(
    () =>
      pathname.startsWith("/assistant") ||
      pathname.startsWith("/copilot") ||
      pathname.startsWith("/docs"),
  );
  const navigationType = useNavigationType();
  const saleRoute =
    pathname === "/sell" ||
    pathname.startsWith("/sales") ||
    /^\/vehicles\/[^/]+\/sell\/?$/.test(pathname);
  const intakeRoute =
    pathname.startsWith("/acquisitions") || pathname.startsWith("/intake");
  const captureRoute = pathname.startsWith("/capture");
  const navRouteActive = (to: string) =>
    to === "/"
      ? pathname === "/"
      : to === "/acquisitions"
        ? intakeRoute
        : to === "/vehicles"
          ? pathname.startsWith("/vehicles") || saleRoute
          : pathname === to || pathname.startsWith(`${to}/`);

  useEffect(() => {
    if (
      pathname.startsWith("/assistant") ||
      pathname.startsWith("/copilot") ||
      pathname.startsWith("/docs")
    )
      setAiSectionOpen(true);
  }, [pathname]);

  useEffect(() => {
    if (
      pathname === "/vehicles" &&
      (navigationType === "POP" || state?.restoreInventory)
    )
      return;
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname, navigationType, state]);


  const visibleNav = mainNav.filter(
    (n) =>
      (n.to !== "/expenses" || canManage(profile)) &&
      (!n.staffOnly || canOperate(profile)),
  );

  const currentPageTitle = useMemo(() => {
    if (pathname === "/") return "Tổng quan";
    if (/^\/vehicles\/[^/]+\/sell\/?$/.test(pathname) || pathname === "/sell") return "Bán xe";
    if (pathname.startsWith("/sales/")) return "Chi tiết bán xe";
    const item = mainNav.find((n) => pathname.startsWith(n.to) && n.to !== "/");
    if (item) return item.label;
    if (pathname.startsWith("/expenses")) return "Chi phí";
    if (pathname.startsWith("/settings")) return "Cài đặt";
    if (pathname.startsWith("/audit")) return "Lịch sử thao tác";
    if (pathname.startsWith("/approvals")) return "Chờ duyệt";
    if (pathname.startsWith("/duplicate-reviews"))
      return "Xác minh nghi trùng";
    if (pathname.startsWith("/users")) return "Nhân sự";
    if (pathname.startsWith("/capture")) return "Camera thông minh";
    if (pathname.startsWith("/intake")) return "Thu xe tốc ký";
    if (pathname.startsWith("/assistant")) return "Trợ lý Cà Rem";
    if (pathname.startsWith("/copilot")) return "Tra cứu AI Cà Rem";
    if (pathname.startsWith("/docs")) return "Tài liệu cửa hàng";
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
          {visibleNav.map(({ to, label, icon: Icon, badgeKey }) => {
            const count = badgeKey ? badges[badgeKey] : 0;
            return (
              <Link
                key={to}
                to={to}
                className={navRouteActive(to) ? "active" : ""}
                aria-current={
                  navRouteActive(to)
                    ? pathname === to
                      ? "page"
                      : "location"
                    : undefined
                }
                onClick={() => {
                  drawer.close();
                  if (badgeKey) markSeen(badgeKey);
                }}
                onMouseEnter={() => preloadRoute(to)}
                onFocus={() => preloadRoute(to)}
              >
                <Icon size={20} />
                <span>{label}</span>
                {count > 0 && (
                  <span className="sidebar-nav-badge">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        {/* AI mode: grounded Q&A plus the documentation the answers cite. */}
        {canOperate(profile) && (
          <div className="ai-nav-group">
            <button
              type="button"
              className="ai-nav-toggle"
              aria-expanded={aiSectionOpen}
              aria-controls="ai-nav-links"
              onClick={() => setAiSectionOpen((open) => !open)}
              onMouseEnter={() => preloadRoute("/copilot")}
              onFocus={() => preloadRoute("/copilot")}
            >
              <Bot size={18} />
              <span className="ai-nav-caption">TRỢ LÝ AI</span>
              <ChevronDown
                size={15}
                className={`ai-nav-chevron ${aiSectionOpen ? "open" : ""}`}
              />
            </button>
            {aiSectionOpen && (
              <nav id="ai-nav-links" aria-label="Trợ lý AI">
                <NavLink
                  to="/assistant"
                  onClick={drawer.close}
                  onMouseEnter={() => preloadRoute("/assistant")}
                  onFocus={() => preloadRoute("/assistant")}
                >
                  <Bot size={20} />
                  <span>Trợ lý Cà Rem</span>
                </NavLink>
                <NavLink
                  to="/copilot"
                  onClick={drawer.close}
                  onMouseEnter={() => preloadRoute("/copilot")}
                  onFocus={() => preloadRoute("/copilot")}
                >
                  <Sparkles size={20} />
                  <span>Tra cứu AI Cà Rem</span>
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
            )}
          </div>
        )}
        <div className="sidebar-bottom">
          {canManage(profile) && (
            <>
              <p className="nav-caption">QUẢN TRỊ</p>
              <nav aria-label="Quản trị">
                {/* Managers open Nhân sự to set roles for their juniors. */}
                <NavLink
                  to="/users"
                  onClick={drawer.close}
                  onMouseEnter={() => preloadRoute("/users")}
                  onFocus={() => preloadRoute("/users")}
                >
                  <Users size={20} />
                  Nhân sự
                </NavLink>
                {/* Trung tâm duyệt chung (Nghi trùng xe, Bán dưới giá thu, Xóa xe) */}
                <NavLink
                  to="/approvals"
                  className={({ isActive }) =>
                    isActive || pathname.startsWith("/duplicate-reviews")
                      ? "active"
                      : ""
                  }
                  onClick={() => {
                    drawer.close();
                    markSeen("approvals");
                  }}
                  onMouseEnter={() => {
                    preloadRoute("/approvals");
                    preloadRoute("/duplicate-reviews");
                  }}
                  onFocus={() => {
                    preloadRoute("/approvals");
                    preloadRoute("/duplicate-reviews");
                  }}
                >
                  <Inbox size={20} />
                  <span>Chờ duyệt</span>
                  {badges.approvals > 0 && (
                    <span className="sidebar-nav-badge">
                      {badges.approvals > 99 ? "99+" : badges.approvals}
                    </span>
                  )}
                </NavLink>
                {isOwner(profile) && (
                  <NavLink
                    to="/audit"
                    onClick={drawer.close}
                    onMouseEnter={() => preloadRoute("/audit")}
                    onFocus={() => preloadRoute("/audit")}
                  >
                    <ShieldCheck size={20} />
                    Lịch sử thao tác
                  </NavLink>
                )}
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
            {/* Mobile safe place for logout: inside the drawer, away from the header. */}
            <button
              type="button"
              className="sidebar-signout"
              onClick={() => void signOut()}
            >
              <LogOut size={20} />
              Đăng xuất
            </button>
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
              className={`connection-dot ${net.online ? "" : "offline"}`}
              title={net.online ? "Đã kết nối" : "Mất kết nối"}
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
              {managementTotal > 0 && (
                <span
                  className="mobile-menu-badge-dot"
                  aria-label={`${managementTotal} việc cần xử lý`}
                />
              )}
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
            <NotificationBell />
            <button
              className="icon-button header-theme-toggle"
              aria-label={
                theme === "dark"
                  ? "Chuyển sang nền sáng"
                  : "Chuyển sang nền tối"
              }
              title={theme === "dark" ? "Nền sáng" : "Nền tối"}
              onClick={() => setTheme(toggleTheme())}
            >
              {/* key remounts the icon so the pop/spin animation replays on every switch */}
              {theme === "dark" ? (
                <Sun key="sun" size={18} />
              ) : (
                <Moon key="moon" size={18} />
              )}
            </button>
            <button
              className="icon-button header-logout"
              aria-label="Đăng xuất"
              title="Đăng xuất"
              onClick={() => void signOut()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <AnnouncementBar />
        {import.meta.env.VITE_APP_ENV === "staging" && (
          <div className="staging-banner" role="status">
            Môi trường thử nghiệm · Dữ liệu dùng để kiểm tra
          </div>
        )}
        <NetworkGuard />
        <InstallHint />
        <main className="main-content" id="main-content" tabIndex={-1}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Outlet />
          </Suspense>
        </main>
        {!["/acquisitions", "/acquisitions/new", "/vehicles", "/copilot"].includes(
          pathname,
        ) && (
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
        <Link
          to="/"
          className={pathname === "/" ? "active" : ""}
          data-active={pathname === "/" ? "true" : undefined}
          aria-current={pathname === "/" ? "page" : undefined}
          onMouseEnter={() => preloadRoute("/")}
          onTouchStart={() => preloadRoute("/")}
        >
          <span className="bottom-nav-icon">
            <House size={22} />
          </span>
          <span className="bottom-nav-label">Tổng quan</span>
        </Link>
        {canOperate(profile) && (
          <Link
            to="/acquisitions/new"
            className={intakeRoute ? "active" : ""}
            data-active={intakeRoute ? "true" : undefined}
            aria-current={intakeRoute ? "location" : undefined}
            onClick={() => markSeen("acquisitions")}
            onMouseEnter={() => preloadRoute("/acquisitions/new")}
            onTouchStart={() => preloadRoute("/acquisitions/new")}
          >
            <span className="bottom-nav-icon">
              <Plus size={22} />
              {badges.acquisitions > 0 && (
                <span className="bottom-nav-badge">
                  {badges.acquisitions > 99 ? "99+" : badges.acquisitions}
                </span>
              )}
            </span>
            <span className="bottom-nav-label">Thu xe</span>
          </Link>
        )}
        {canOperate(profile) && (
          /* Camera thông minh — viên kính nổi giữa thanh, vị trí số 3/5. */
          <Link
            to="/capture"
            className={`bottom-nav-camera${captureRoute ? " active" : ""}`}
            data-active={captureRoute ? "true" : undefined}
            aria-current={captureRoute ? "page" : undefined}
            onMouseEnter={() => preloadRoute("/capture")}
            onTouchStart={() => preloadRoute("/capture")}
          >
            <span className="bottom-nav-fab">
              <Camera size={21} />
            </span>
            <span className="bottom-nav-label">Camera</span>
          </Link>
        )}
        <Link
          to="/vehicles"
          className={navRouteActive("/vehicles") ? "active" : ""}
          data-active={
            pathname.startsWith("/vehicles") && !saleRoute ? "true" : undefined
          }
          aria-current={
            navRouteActive("/vehicles")
              ? pathname === "/vehicles"
                ? "page"
                : "location"
              : undefined
          }
          onClick={() => markSeen("vehicles")}
          onMouseEnter={() => preloadRoute("/vehicles")}
          onTouchStart={() => preloadRoute("/vehicles")}
        >
          <span className="bottom-nav-icon">
            <Bike size={22} />
            {badges.vehicles > 0 && (
              <span className="bottom-nav-badge">
                {badges.vehicles > 99 ? "99+" : badges.vehicles}
              </span>
            )}
          </span>
          <span className="bottom-nav-label">Tồn kho</span>
        </Link>
        {/* Bán ra đã rời khỏi bottom nav (OWNER 12/10/2026): luồng bán và xem lại
            hồ sơ giao dịch đi qua tab Đã bán trong Tồn kho; ô này dành cho Khách hàng. */}
        <Link
          to="/customers"
          className={navRouteActive("/customers") ? "active" : ""}
          data-active={navRouteActive("/customers") ? "true" : undefined}
          aria-current={
            navRouteActive("/customers")
              ? pathname === "/customers"
                ? "page"
                : "location"
              : undefined
          }
          onClick={() => markSeen("customers")}
          onMouseEnter={() => preloadRoute("/customers")}
          onTouchStart={() => preloadRoute("/customers")}
        >
          <span className="bottom-nav-icon">
            <Users size={22} />
            {badges.customers > 0 && (
              <span className="bottom-nav-badge">
                {badges.customers > 99 ? "99+" : badges.customers}
              </span>
            )}
          </span>
          <span className="bottom-nav-label">Khách hàng</span>
        </Link>
      </nav>
    </div>
  );
}

export default AppLayout;
