import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  Eye,
  Plus,
  Search,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { isOwner } from "@/lib/permissions";
import type { Profile } from "@/types";
import { CreateUserModal } from "./components/CreateUserModal";
import { StaffSettingsModal } from "./components/StaffSettingsModal";

export default function UsersPage() {
  const { profile } = useAuth();
  const owner = isOwner(profile);
  const [adding, setAdding] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<Profile | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");

  const q = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.call<Profile[]>("list_profiles"),
  });

  const totalStaff = q.data?.length ?? 0;
  const activeStaff =
    q.data?.filter(
      (p) =>
        p.active &&
        !p.deleted_at &&
        !(p.disabled_until && new Date(p.disabled_until) > new Date()),
    ).length ?? 0;
  const managerCount = q.data?.filter((p) => p.role === "MANAGER").length ?? 0;
  const staffCount = q.data?.filter((p) => p.role === "STAFF").length ?? 0;

  const filteredStaff = q.data?.filter((p) => {
    const matchesSearch =
      !search ||
      p.full_name.toLowerCase().includes(search.toLowerCase()) ||
      p.username.toLowerCase().includes(search.toLowerCase());
    const matchesRole = roleFilter === "ALL" || p.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const rolePills = [
    { key: "ALL", label: "Tất cả" },
    { key: "OWNER", label: "Chủ cửa hàng" },
    { key: "MANAGER", label: "Quản lý" },
    { key: "STAFF", label: "Nhân viên" },
  ];

  return (
    <div className="stack">
      <PageHeader
        title="Nhân sự"
        description="Mỗi người một tài khoản. Mỗi vai trò một quyền hạn rõ ràng."
        actions={
          owner ? (
            <Button onClick={() => setAdding(true)}>
              <Plus size={18} />
              Thêm tài khoản
            </Button>
          ) : undefined
        }
      />

      {/* STATS HUD */}
      <div className="staff-stats-grid">
        <div className="staff-stat-card">
          <div className="staff-stat-icon indigo">
            <Users size={20} />
          </div>
          <div>
            <div className="staff-stat-num">{totalStaff}</div>
            <div className="staff-stat-label">
              Tổng số tài khoản ({managerCount} Quản lý, {staffCount} Nhân viên)
            </div>
          </div>
        </div>

        <div className="staff-stat-card">
          <div className="staff-stat-icon emerald">
            <CalendarClock size={20} />
          </div>
          <div>
            <div className="staff-stat-num">{activeStaff}</div>
            <div className="staff-stat-label">
              Đang hoạt động ({totalStaff - activeStaff} tạm dừng / khóa)
            </div>
          </div>
        </div>
      </div>

      {/* SEARCH & ROLE FILTER BAR */}
      <Card>
        <div className="staff-toolbar">
          <div className="receivables-search-wrap">
            <Search size={18} className="search-icon" />
            <input
              aria-label="Tìm nhân sự"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm theo họ tên, tên đăng nhập (@username)…"
            />
            {search && (
              <button
                type="button"
                className="receivables-clear-btn"
                onClick={() => setSearch("")}
                aria-label="Xóa tìm kiếm"
              >
                ✕
              </button>
            )}
          </div>

          <div className="filter-pills-bar" role="tablist" aria-label="Lọc theo vai trò">
            {rolePills.map((pill) => (
              <button
                key={pill.key}
                type="button"
                className={`filter-pill ${roleFilter === pill.key ? "active" : ""}`}
                onClick={() => setRoleFilter(pill.key)}
              >
                <span>{pill.label}</span>
                {pill.key !== "ALL" && (
                  <span className="filter-pill-count">
                    {q.data?.filter((u) => u.role === pill.key).length ?? 0}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* POPUP MODAL 1: CREATE USER */}
      {adding && (
        <CreateUserModal
          onDone={() => {
            setAdding(false);
          }}
        />
      )}

      {/* POPUP MODAL 2: UNIFIED STAFF SETTINGS */}
      {selectedStaff && (
        <StaffSettingsModal
          user={selectedStaff}
          isSelf={selectedStaff.id === profile?.id}
          isOwnerAcc={selectedStaff.role === "OWNER"}
          onClose={() => setSelectedStaff(null)}
        />
      )}

      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : !filteredStaff?.length ? (
        <EmptyState
          title={search || roleFilter !== "ALL" ? "Không tìm thấy tài khoản phù hợp" : "Chưa có tài khoản"}
          description={
            search || roleFilter !== "ALL"
              ? "Hãy thử thay đổi từ khóa tìm kiếm hoặc bỏ chọn bộ lọc vai trò."
              : undefined
          }
        />
      ) : (
        <div className="user-grid">
          {filteredStaff.map((p) => {
            const isSelf = p.id === profile?.id;
            const isOwnerAcc = p.role === "OWNER";
            const isLocked =
              p.disabled_until && new Date(p.disabled_until) > new Date();

            return (
              <Card key={p.id} className={`user-staff-card ${isSelf ? "self-account" : ""}`}>
                <div className="user-card-top">
                  <div className="row" style={{ gap: "12px", alignItems: "center" }}>
                    <span className="avatar large user-staff-avatar">
                      {p.full_name.split(" ").at(-1)?.[0]}
                    </span>
                    <div className="user-staff-info">
                      <h3 className="user-staff-name">{p.full_name}</h3>
                      <span className="user-staff-handle">
                        @{p.username} {isSelf && "· Tài khoản của bạn"}
                      </span>
                    </div>
                  </div>

                  <span
                    className={`badge ${p.active && !p.deleted_at && !isLocked ? "badge-active" : "badge-cancelled"}`}
                  >
                    {p.active && !p.deleted_at && !isLocked
                      ? "Hoạt động"
                      : isLocked
                        ? "Bị cấm"
                        : "Tạm dừng"}
                  </span>
                </div>

                <div className="user-card-chips">
                  <div className="user-chip-item">
                    <Badge status={p.role} />
                  </div>

                  {p.role === "MANAGER" && p.can_view_financials && (
                    <div className="user-chip-item user-chip-accent" title="Quyền xem giá vốn & lợi nhuận">
                      <Eye size={13} />
                      <span>Xem giá vốn</span>
                    </div>
                  )}

                  {!isOwnerAcc && p.must_change_password && (
                    <div className="user-chip-item user-chip-warning">
                      <span>Cần đổi MK</span>
                    </div>
                  )}
                </div>

                <div className="user-card-footer">
                  <Button
                    variant="secondary"
                    className="user-configure-btn"
                    onClick={() => setSelectedStaff(p)}
                  >
                    <SlidersHorizontal size={15} />
                    <span>{isSelf ? "Xem thiết lập tài khoản" : "Thiết lập nhân sự"}</span>
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {q.data?.length === 0 && <EmptyState title="Chưa có tài khoản" />}
    </div>
  );
}
