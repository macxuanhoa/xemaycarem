import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, RotateCcw, Bike, User } from "lucide-react";
import { api } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import {
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { ApprovalKind, ApprovalRequest } from "@/types";

// Human labels per approval kind. New approval workflows plug in here without a
// schema change — the queue itself is generic (migration 20261008000200).
const KIND_LABELS: Record<ApprovalKind, string> = {
  VEHICLE_DELETION: "Xóa xe khỏi kho",
};

const pageSize = 50;

export function ApprovalsPage() {
  const client = useQueryClient();
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ["approvals", offset],
    queryFn: () =>
      api.listPendingApprovals({ limit: pageSize, offset }),
    placeholderData: keepPreviousData,
  });

  const resolve = useMutation({
    mutationFn: ({
      id,
      action,
      note,
    }: {
      id: string;
      action: "APPROVE" | "RESTORE";
      note?: string;
    }) => api.resolveVehicleDeletion(id, action, note),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["approvals"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  async function approve(item: ApprovalRequest) {
    const ok = await confirmAction({
      title: "Duyệt xóa xe?",
      description:
        "Xe sẽ bị gỡ vĩnh viễn khỏi hệ thống cùng toàn bộ chi phí, hình ảnh và phiếu thu. Không thể hoàn tác.",
      entity: item.vehicle_title || item.vehicle_code || undefined,
      confirmLabel: "Duyệt xóa",
      tone: "danger",
    });
    if (!ok) return;
    resolve.mutate(
      { id: item.id, action: "APPROVE" },
      {
        onSuccess: () => toast.success("Đã duyệt xóa xe."),
        onError: (error) => toast.error("Không duyệt được xe.", {
          description: String((error as Error).message ?? error),
        }),
      },
    );
  }

  async function restore(item: ApprovalRequest) {
    const ok = await confirmAction({
      title: "Khôi phục xe?",
      description:
        "Từ chối yêu cầu xóa và trả xe trở lại tồn kho. Nhân viên đã gửi yêu cầu sẽ nhận được thông báo.",
      entity: item.vehicle_title || item.vehicle_code || undefined,
      confirmLabel: "Khôi phục",
      cancelLabel: "Giữ nguyên",
      tone: "primary",
    });
    if (!ok) return;
    resolve.mutate(
      { id: item.id, action: "RESTORE" },
      {
        onSuccess: () => toast.success("Đã khôi phục xe về kho."),
        onError: (error) => toast.error("Không khôi phục được xe.", {
          description: String((error as Error).message ?? error),
        }),
      },
    );
  }

  if (query.isPending) return <Loading />;
  if (query.isError)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />;

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const groups = items.reduce<Record<string, ApprovalRequest[]>>((acc, item) => {
    (acc[item.kind] ??= []).push(item);
    return acc;
  }, {});

  return (
    <div className="stack">
      <PageHeader
        title="Chờ duyệt"
        description="Các yêu cầu cần chủ cửa hàng xem và quyết định mỗi ngày."
      />
      {items.length === 0 ? (
        <EmptyState
          title="Không có gì chờ duyệt"
          description="Khi nhân viên gửi yêu cầu xóa xe, bạn sẽ thấy ở đây."
        />
      ) : (
        Object.entries(groups).map(([kind, rows]) => (
          <Card key={kind}>
            <h2 className="section-title">
              {KIND_LABELS[kind as ApprovalKind] ?? kind}
              <span className="muted" style={{ marginLeft: 8 }}>
                ({rows.length})
              </span>
            </h2>
            <div className="compact-list">
              {rows.map((item) => (
                <div className="compact-row approvals-row" key={item.id}>
                  <div className="approvals-row-main">
                    <strong>
                      {item.vehicle_title ||
                        item.vehicle_code ||
                        "Xe không còn tồn tại"}
                    </strong>
                    <small>
                      {[
                        item.vehicle_subtitle,
                        item.vehicle_code ? `Mã xe ${item.vehicle_code}` : "",
                        item.reason,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    <small className="muted">
                      <User size={12} style={{ verticalAlign: "-1px" }} />{" "}
                      {item.requester_name || "Nhân viên"} ·{" "}
                      {dateLabel(item.created_at)}
                    </small>
                    <Link
                      className="text-link"
                      to={`/vehicles/${item.subject_id}`}
                    >
                      <Bike size={13} /> Xem xe
                    </Link>
                  </div>
                  <div className="align-right approvals-row-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={resolve.isPending}
                      onClick={() => void approve(item)}
                    >
                      <Check size={15} /> Duyệt xóa
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={resolve.isPending}
                      onClick={() => void restore(item)}
                    >
                      <RotateCcw size={15} /> Khôi phục
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {total > pageSize && (
              <div className="row between" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="button secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
                >
                  Trang trước
                </button>
                <span className="muted">
                  {offset + 1}–{Math.min(total, offset + pageSize)} / {total}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  disabled={offset + pageSize >= total}
                  onClick={() => setOffset((o) => o + pageSize)}
                >
                  Trang sau
                </button>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

export default ApprovalsPage;
