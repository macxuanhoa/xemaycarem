import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { NavLink, Outlet, Link, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ChartNoAxesCombined,
  ClipboardList,
  House,
  LogOut,
  Menu,
  Bike,
  Package,
  Plus,
  Receipt,
  Search,
  Settings,
  ShieldCheck,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate, isOwner, roleLabels } from "@/lib/permissions";
const mainNav = [
  { to: "/", label: "Tổng quan", icon: House },
  { to: "/vehicles", label: "Kho xe", icon: Bike },
  { to: "/sales", label: "Bán hàng", icon: Receipt },
  { to: "/expenses", label: "Chi phí", icon: ClipboardList },
  { to: "/reports", label: "Báo cáo", icon: ChartNoAxesCombined },
];
export default function AppLayout() {
  const { profile, signOut } = useAuth();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<{ store_name: string }>("get_settings"),
  });
  const [open, setOpen] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [search, setSearch] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  function onSearch(e: FormEvent) {
    e.preventDefault();
    navigate("/vehicles?q=" + encodeURIComponent(search));
    setSearch("");
  }
  const visibleNav = mainNav.filter(
    (n) => !["/reports", "/expenses"].includes(n.to) || canManage(profile),
  );
  return (
    <div className="app-shell">
      {open && (
        <button
          className="sidebar-overlay"
          onClick={() => setOpen(false)}
          aria-label="Đóng menu"
        />
      )}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <Link to="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand-icon">
            <Bike size={26} />
          </span>
          <span>
            Xe CRM<small>QUẢN LÝ CỬA HÀNG XE</small>
          </span>
        </Link>
        <button
          className="mobile-menu-close"
          aria-label="Đóng menu"
          onClick={() => setOpen(false)}
        >
          <X />
        </button>
        <p className="nav-caption">KHÔNG GIAN LÀM VIỆC</p>
        <nav>
          {visibleNav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setOpen(false)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {isOwner(profile) && (
            <>
              <p className="nav-caption">QUẢN TRỊ</p>
              <nav>
                <NavLink to="/users" onClick={() => setOpen(false)}>
                  <Users size={20} />
                  Nhân sự
                </NavLink>
                <NavLink to="/audit" onClick={() => setOpen(false)}>
                  <ShieldCheck size={20} />
                  Lịch sử thao tác
                </NavLink>
              </nav>
            </>
          )}
          <nav>
            <NavLink to="/settings" onClick={() => setOpen(false)}>
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
            <span className="connection-dot" />
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Mở menu"
            onClick={() => setOpen(true)}
          >
            <Menu size={22} />
          </button>
          <form className="global-search" onSubmit={onSearch}>
            <Search size={19} />
            <input
              aria-label="Tìm xe toàn hệ thống"
              placeholder="Tìm mã xe, biển số, số điện thoại…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="submit" aria-label="Tìm xe">
              <ArrowUpRight size={17} />
            </button>
          </form>
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
        <main className="main-content">
          <Outlet />
        </main>
        <footer className="workspace-footer">
          <span>Xe CRM · Mọi hoạt động, một nơi quản lý.</span>
          <span>
            <ShieldCheck size={13} /> Dữ liệu được phân quyền
          </span>
        </footer>
      </div>
      <nav className="bottom-nav">
        <NavLink to="/" end>
          <House size={21} />
          Tổng quan
        </NavLink>
        <NavLink to="/vehicles">
          <Bike size={21} />
          Kho xe
        </NavLink>
        {canOperate(profile) && (
          <NavLink to="/sell">
            <Plus size={22} />
            Bán xe
          </NavLink>
        )}
        <button onClick={() => setOpen(true)}>
          <Menu size={21} />
          Thêm
        </button>
      </nav>
    </div>
  );
}
