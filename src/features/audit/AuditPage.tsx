import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Clock, FileClock, History, Search, User } from "lucide-react";
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
import {
  actionChip,
  changedFields,
  describeAction,
  entityLabel,
  recordSubject,
  summarizeFields,
} from "./auditLabels";

/**
 * Reads an audit row the way a person would describe it: who did what, which
 * fields changed (old → new) in plain Vietnamese. The raw before/after JSON is
 * kept behind a collapsed panel so nothing is lost for forensic review.
 */
function AuditRecordBody({ a }: { a: Activity }) {
  const oldData = (a.old_data ?? null) as Record<string, unknown> | null;
  const newData = (a.new_data ?? null) as Record<string, unknown> | null;
  const actor = a.actor_name ?? a.full_name ?? "Hệ thống";
  const sentence = describeAction(a.action, actor);
  const subject = recordSubject(newData ?? oldData);

  const diffs = changedFields(oldData, newData);
  // Create (only new) / delete (only old) have no diff — list the key fields.
  const snapshot = diffs.length
    ? []
    : summarizeFields(newData ?? oldData);

  return (
    <div className="audit-record-body">
      <p className="audit-lead">
        {sentence}
        {subject ? <span className="audit-lead-subject">: “{subject}”</span> : null}
      </p>

      {diffs.length > 0 && (
        <div className="audit-diff-summary">
          <span className="small muted" style={{ fontWeight: 600 }}>
            Những thay đổi:
          </span>
          {diffs.map((d) => (
            <div key={d.label} className="audit-diff-line">
              <span className="audit-diff-key">{d.label}:</span>
              <span className="audit-diff-old">{d.old}</span>
              <span className="audit-diff-arrow">→</span>
              <span className="audit-diff-new">{d.next}</span>
            </div>
          ))}
        </div>
      )}

      {snapshot.length > 0 && (
        <div className="audit-diff-summary">
          <span className="small muted" style={{ fontWeight: 600 }}>
            Thông tin ghi nhận:
          </span>
          {snapshot.map((f) => (
            <div key={f.key} className="audit-diff-line">
              <span className="audit-diff-key">{f.key}:</span>
              <span className="audit-diff-value">{f.value}</span>
            </div>
          ))}
        </div>
      )}

      {diffs.length === 0 && snapshot.length === 0 && (
        <p className="muted small">
          Thao tác này không ghi nhận thay đổi trường dữ liệu nào.
        </p>
      )}

      <details className="audit-raw">
        <summary className="small muted">Xem dữ liệu thô (JSON)</summary>
        <p className="small muted audit-record-id">
          Mã định danh đối tượng: <code>{a.entity_id ?? "—"}</code>
        </p>
        <div className="audit-diff">
          <div>
            <h3>Trước thay đổi</h3>
            <pre>{JSON.stringify(a.old_data ?? null, null, 2)}</pre>
          </div>
          <div>
            <h3>Sau thay đổi</h3>
            <pre>{JSON.stringify(a.new_data ?? null, null, 2)}</pre>
          </div>
        </div>
      </details>
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
            <div className="receivables-search-wrap">
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
                        {actionChip(a.action)}
                      </span>
                      <div className="audit-record-main">
                        <div className="audit-record-actor">
                          <User size={13} className="muted" />
                          <strong>
                            {a.actor_name ?? a.full_name ?? a.user_id}
                          </strong>
                          <span className="muted small">·</span>
                          <span className="muted small">
                            {entityLabel(a.entity_type)}
                          </span>
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

                    <AuditRecordBody a={a} />
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
