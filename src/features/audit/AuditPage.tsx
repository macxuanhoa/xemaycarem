import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Clock, FileClock, History, Search, ShieldCheck, User } from "lucide-react";
import {
  Card,
  DateRange,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { api } from "@/lib/api";
import { dateLabel, monthRange } from "@/lib/format";
import type { Activity } from "@/types";
import { actionLabels } from "@/features/vehicles/vehicleSchema";

function renderChangedKeys(oldData: unknown, newData: unknown) {
  if (
    !oldData ||
    !newData ||
    typeof oldData !== "object" ||
    typeof newData !== "object"
  ) {
    return null;
  }
  const oldObj = oldData as Record<string, unknown>;
  const newObj = newData as Record<string, unknown>;
  const allKeys = Array.from(
    new Set([...Object.keys(oldObj), ...Object.keys(newObj)]),
  );
  const changed = allKeys.filter(
    (k) => JSON.stringify(oldObj[k]) !== JSON.stringify(newObj[k]),
  );
  if (!changed.length) return null;

  return (
    <div className="audit-diff-summary">
      <span className="small muted" style={{ fontWeight: 600 }}>
        Các trường dữ liệu đã thay đổi:
      </span>
      {changed.slice(0, 6).map((k) => (
        <div key={k} className="audit-diff-line">
          <span className="audit-diff-key">{k}:</span>
          <span className="audit-diff-old">
            {typeof oldObj[k] === "object"
              ? JSON.stringify(oldObj[k])
              : String(oldObj[k] ?? "—")}
          </span>
          <span className="audit-diff-arrow">→</span>
          <span className="audit-diff-new">
            {typeof newObj[k] === "object"
              ? JSON.stringify(newObj[k])
              : String(newObj[k] ?? "—")}
          </span>
        </div>
      ))}
      {changed.length > 6 && (
        <small className="muted">+ {changed.length - 6} trường khác</small>
      )}
    </div>
  );
}

export default function AuditPage() {
  const pageSize = 6;
  const [range, setRange] = useState(monthRange);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [actionCategory, setActionCategory] = useState("ALL");

  const q = useQuery({
    queryKey: ["audit", range, search],
    placeholderData: keepPreviousData,
    queryFn: () => api.callAll<Activity>("list_audit", { ...range, search }),
  });

  const rawItems = q.data?.items ?? [];
  const filtered = actionCategory === "ALL"
    ? rawItems
    : rawItems.filter((a) => {
        const act = a.action.toUpperCase();
        if (actionCategory === "VEHICLE") return act.includes("VEHICLE") || a.entity_type === "vehicles";
        if (actionCategory === "SALE") return act.includes("SALE") || a.entity_type === "sales";
        if (actionCategory === "EXPENSE") return act.includes("EXPENSE") || a.entity_type === "expenses";
        if (actionCategory === "PAYMENT") return act.includes("PAYMENT") || act.includes("DEBT");
        return true;
      });

  const items = filtered.slice((page - 1) * pageSize, page * pageSize);

  const getActionChipClass = (action: string) => {
    const act = action.toUpperCase();
    if (act.includes("CREATE") || act.includes("ACQUIRE") || act.includes("ADD"))
      return "audit-action-chip create";
    if (act.includes("UPDATE") || act.includes("EDIT") || act.includes("SET"))
      return "audit-action-chip update";
    if (act.includes("DELETE") || act.includes("CANCEL") || act.includes("REMOVE"))
      return "audit-action-chip delete";
    return "audit-action-chip default";
  };

  const entityPills = [
    { key: "ALL", label: "Tất cả thao tác" },
    { key: "VEHICLE", label: "Xe & Tồn kho" },
    { key: "SALE", label: "Bán hàng" },
    { key: "PAYMENT", label: "Thu tiền & Nợ" },
    { key: "EXPENSE", label: "Chi phí" },
  ];

  return (
    <div className="stack">
      <PageHeader
        title="Lịch sử thao tác"
        description="Ai đã thay đổi, thay đổi điều gì và vào lúc nào."
      />

      {/* STATS HUD */}
      <div className="audit-stats-row">
        <div className="staff-stat-card">
          <div className="staff-stat-icon indigo">
            <History size={20} />
          </div>
          <div>
            <div className="staff-stat-num">{q.data?.total ?? 0}</div>
            <div className="staff-stat-label">Tổng thao tác trong kỳ đã chọn</div>
          </div>
        </div>

        <div className="staff-stat-card">
          <div className="staff-stat-icon emerald">
            <FileClock size={20} />
          </div>
          <div>
            <div className="staff-stat-num">{filtered.length}</div>
            <div className="staff-stat-label">
              Bản ghi phù hợp ({items.length} trên trang {page})
            </div>
          </div>
        </div>

        <div className="staff-stat-card">
          <div className="staff-stat-icon amber">
            <ShieldCheck size={20} />
          </div>
          <div>
            <div className="staff-stat-num" style={{ fontSize: "16px", marginTop: "2px" }}>
              Bất biến &amp; Minh bạch
            </div>
            <div className="staff-stat-label">
              Múi giờ Asia/Ho_Chi_Minh · Không thể sửa/xóa log
            </div>
          </div>
        </div>
      </div>

      {/* FILTER CONTROLS */}
      <Card>
        <div className="stack" style={{ gap: "14px" }}>
          <div className="filter-pills-bar" role="tablist" aria-label="Lọc theo nghiệp vụ">
            {entityPills.map((pill) => (
              <button
                key={pill.key}
                type="button"
                className={`filter-pill ${actionCategory === pill.key ? "active" : ""}`}
                onClick={() => {
                  setActionCategory(pill.key);
                  setPage(1);
                }}
              >
                <span>{pill.label}</span>
              </button>
            ))}
          </div>

          <div className="audit-filter-controls">
            <div className="receivables-search-wrap" style={{ flex: "1 1 260px" }}>
              <Search size={18} className="search-icon" />
              <input
                aria-label="Tìm lịch sử"
                placeholder="Tìm theo thao tác, mã xe, tên người thực hiện…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
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

            <DateRange
              value={range}
              onChange={(v) => {
                setRange(v);
                setPage(1);
              }}
            />
          </div>
        </div>
      </Card>

      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <Card className="table-card">
          {q.isFetching && !q.isPending && (
            <div className="table-updating-bar" role="progressbar" aria-label="Đang cập nhật danh sách" />
          )}
          {filtered.length ? (
            <>
              <div className="audit-list">
                {items.map((a) => (
                  <details key={a.id} className="audit-record">
                    <summary>
                      <span className={getActionChipClass(a.action)}>
                        {actionLabels[a.action] ?? a.action}
                      </span>
                      <div className="audit-record-main">
                        <div className="audit-record-actor">
                          <User size={13} className="muted" />
                          <strong>
                            {a.actor_name ?? a.full_name ?? a.user_id}
                          </strong>
                          <span className="muted small">·</span>
                          <span className="muted small">{a.entity_type}</span>
                        </div>
                      </div>
                      <time className="audit-record-time small">
                        <Clock size={13} className="muted" />
                        <span>{dateLabel(a.created_at)}</span>
                        <small className="muted">
                          {new Date(a.created_at).toLocaleTimeString("vi-VN", {
                            timeZone: "Asia/Ho_Chi_Minh",
                          })}
                        </small>
                      </time>
                    </summary>

                    <div className="audit-record-body">
                      <p className="small muted audit-record-id">
                        Mã định danh đối tượng: <code>{a.entity_id}</code>
                      </p>

                      {renderChangedKeys(a.old_data, a.new_data)}

                      <div className="audit-diff">
                        <div>
                          <h3>Trước thay đổi</h3>
                          <pre>
                            {JSON.stringify(a.old_data, null, 2) ?? "Không có"}
                          </pre>
                        </div>
                        <div>
                          <h3>Sau thay đổi</h3>
                          <pre>
                            {JSON.stringify(a.new_data, null, 2) ?? "Không có"}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
              <Pagination
                page={page}
                total={filtered.length}
                pageSize={pageSize}
                onChange={setPage}
              />
            </>
          ) : (
            <EmptyState title="Chưa có thao tác trong khoảng ngày này" />
          )}
        </Card>
      )}
    </div>
  );
}
