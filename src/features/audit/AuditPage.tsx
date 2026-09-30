import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
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
import type { Activity, Paged } from "@/types";
import { actionLabels } from "@/features/vehicles/vehicleSchema";
export default function AuditPage() {
  const [range, setRange] = useState(monthRange),
    [page, setPage] = useState(1),
    [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["audit", range, page, search],
    queryFn: () =>
      api.call<Paged<Activity>>("list_audit", {
        p_filters: { ...range, search, offset: (page - 1) * 25, limit: 25 },
      }),
  });
  return (
    <div className="stack">
      <PageHeader
        title="Lịch sử thao tác"
        description="Ai đã thay đổi, thay đổi điều gì và vào lúc nào."
      />
      <Card>
        <div className="section-heading">
          <label className="search-field">
            <Search size={18} />
            <input
              aria-label="Tìm lịch sử"
              placeholder="Tìm thao tác, đối tượng…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <DateRange
            value={range}
            onChange={(v) => {
              setRange(v);
              setPage(1);
            }}
          />
        </div>
      </Card>
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <Card className="table-card">
          {q.data?.items.length ? (
            <>
              <div className="audit-list">
                {q.data.items.map((a) => (
                  <details key={a.id} className="audit-record">
                    <summary>
                      <span className="audit-mark" />
                      <div>
                        <strong>{actionLabels[a.action] ?? a.action}</strong>
                        <small>
                          {a.actor_name ?? a.full_name ?? a.user_id} ·{" "}
                          {a.entity_type}
                        </small>
                      </div>
                      <time>
                        {dateLabel(a.created_at)}
                        <small>
                          {new Date(a.created_at).toLocaleTimeString("vi-VN", {
                            timeZone: "Asia/Ho_Chi_Minh",
                          })}
                        </small>
                      </time>
                    </summary>
                    <p className="small muted">Đối tượng: {a.entity_id}</p>
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
                  </details>
                ))}
              </div>
              <Pagination
                page={page}
                total={q.data.total}
                pageSize={25}
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
