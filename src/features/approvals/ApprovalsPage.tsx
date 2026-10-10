import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Check, RotateCcw, Bike, User, X } from "lucide-react";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { celebrateSale } from "@/lib/celebrate";
import { executeOperation } from "@/lib/operationRecovery";
import { dateLabel, money } from "@/lib/format";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/features/auth/AuthProvider";
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
  SALE_BELOW_COST: "Bán xe dưới giá thu",
  VEHICLE_DELETION: "Xóa xe khỏi kho",
};

const pageSize = 50;

type ResolveInput =
  | { item: ApprovalRequest; action: "APPROVE" | "REJECT"; kind: "sale"; note?: string }
  | { item: ApprovalRequest; action: "APPROVE" | "RESTORE"; kind: "deletion"; note?: string };

/** Bảng đề xuất bán dưới giá thu: dữ liệu do server chốt lúc nhân viên gửi đơn. */
function saleFacts(item: ApprovalRequest) {
  const payload = item.payload ?? {};
  return (
    <>
      <small className="muted">
        Biển số <strong>{item.license_plate || "chưa có biển"}</strong> · Số khung{" "}
        <strong>{item.frame_number || "chưa có"}</strong>
      </small>
      <dl className="summary-list">
        <div>
          <dt>Giá thu vào</dt>
          <dd>{money(payload.snapshot_purchase_price)}</dd>
        </div>
        <div>
          <dt>Giá bán đề xuất</dt>
          <dd className="danger">{money(payload.sale_price)}</dd>
        </div>
        <div className="summary-total">
          <dt>Chênh lệch</dt>
          <dd className="danger">−{money(payload.shortfall)}</dd>
        </div>
      </dl>
      <small className="muted">
        Khách {payload.customer_name || "chưa rõ"}
        {payload.customer_phone ? ` · ${payload.customer_phone}` : ""} · Ngày bán{" "}
        {payload.sale_date ? dateLabel(payload.sale_date) : "chưa rõ"} · Trả trước{" "}
        {money(payload.initial_payment)}
      </small>
    </>
  );
}

export function ApprovalsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ["approvals", offset],
    queryFn: () =>
      api.listPendingApprovals({ limit: pageSize, offset }),
    placeholderData: keepPreviousData,
  });

  // Hai luồng duyệt dùng chung một hàng đợi. Duyệt bán ghi giao dịch ngay trong
  // cùng transaction nên cần request_id chống bấm hai lần (biên lai vận hành).
  const resolve = useMutation({
    mutationFn: async (input: ResolveInput): Promise<string | null> => {
      if (input.kind === "sale") {
        if (!profile)
          throw new AppError("Vui lòng đăng nhập lại trước khi duyệt yêu cầu.");
        const result = await executeOperation(
          profile.id,
          "resolve_sale_approval",
          input.item.id,
          (requestId) =>
            api.resolveSaleApproval(
              input.item.id,
              input.action,
              input.note,
              requestId,
            ),
        );
        return result.sale_id;
      }
      await api.resolveVehicleDeletion(input.item.id, input.action, input.note);
      return null;
    },
    onSuccess: async (saleId, input) => {
      await client.invalidateQueries({ queryKey: ["approvals"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["sales"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      if (input.kind === "sale" && input.action === "APPROVE" && saleId) {
        // Chủ vừa chốt giao dịch: pháo hoa chúc mừng như lúc nhân viên bán.
        celebrateSale({ detail: input.item.vehicle_title || undefined });
        navigate(`/sales/${saleId}`);
      }
    },
    onError: (error) =>
      toast.error("Không xử lý được yêu cầu.", {
        description: String((error as Error).message ?? error),
      }),
  });

  async function approveSale(item: ApprovalRequest) {
    const ok = await confirmAction({
      title: "Phê duyệt bán dưới giá thu?",
      description:
        "Hệ thống ghi đúng giao dịch nhân viên đã đề xuất: xe chuyển sang đã bán, cập nhật tồn kho, doanh thu và lợi nhuận. Nhân viên nhận được thông báo.",
      entity: item.vehicle_title || item.vehicle_code || undefined,
      confirmLabel: "Phê duyệt",
      cancelLabel: "Xem lại",
      tone: "primary",
      summary: (
        <div className="sale-review-stack">
          {saleFacts(item)}
          <p className="notice">
            Nếu giá thu hoặc chi phí của xe đã đổi sau lúc gửi đơn, hệ thống sẽ
            chặn và yêu cầu gửi lại bản mới.
          </p>
        </div>
      ),
    });
    if (!ok) return;
    resolve.mutate(
      { item, action: "APPROVE", kind: "sale" },
      { onSuccess: () => toast.success("Đã phê duyệt và ghi nhận giao dịch bán.") },
    );
  }

  async function rejectSale(item: ApprovalRequest) {
    const ok = await confirmAction({
      title: "Từ chối yêu cầu bán dưới giá thu?",
      description:
        "Xe không bị bán và vẫn nằm trong kho. Yêu cầu được đánh dấu từ chối, nhân viên gửi đơn nhận được thông báo.",
      entity: item.vehicle_title || item.vehicle_code || undefined,
      confirmLabel: "Từ chối",
      cancelLabel: "Giữ nguyên",
      tone: "danger",
      summary: <div className="sale-review-stack">{saleFacts(item)}</div>,
    });
    if (!ok) return;
    resolve.mutate(
      { item, action: "REJECT", kind: "sale" },
      { onSuccess: () => toast.success("Đã từ chối yêu cầu. Xe vẫn còn trong kho.") },
    );
  }

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
      { item, action: "APPROVE", kind: "deletion" },
      { onSuccess: () => toast.success("Đã duyệt xóa xe.") },
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
      { item, action: "RESTORE", kind: "deletion" },
      { onSuccess: () => toast.success("Đã khôi phục xe về kho.") },
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
  // Ưu tiên luồng tiền: yêu cầu bán dưới giá thu cần quyết định trong ngày.
  const kindOrder: ApprovalKind[] = ["SALE_BELOW_COST", "VEHICLE_DELETION"];
  const orderedKinds = [
    ...kindOrder.filter((kind) => groups[kind]?.length),
    ...Object.keys(groups).filter(
      (kind) => !kindOrder.includes(kind as ApprovalKind),
    ),
  ];

  return (
    <div className="stack">
      <PageHeader
        title="Chờ duyệt"
        description="Các yêu cầu cần chủ cửa hàng xem và quyết định mỗi ngày."
      />
      {items.length === 0 ? (
        <EmptyState
          title="Không có gì chờ duyệt"
          description="Khi nhân viên xin bán dưới giá thu hoặc gửi yêu cầu xóa xe, bạn sẽ thấy ở đây."
        />
      ) : (
        orderedKinds.map((kindKey) => {
          const kind = kindKey as ApprovalKind;
          const rows = groups[kind] ?? [];
          const isSale = kind === "SALE_BELOW_COST";
          return (
          <Card key={kind}>
            <h2 className="section-title">
              {KIND_LABELS[kind] ?? kind}
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
                    {isSale ? (
                      saleFacts(item)
                    ) : (
                      <small>
                        {[
                          item.vehicle_subtitle,
                          item.vehicle_code ? `Mã xe ${item.vehicle_code}` : "",
                          item.reason,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    )}
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
                    {isSale ? (
                      <>
                        <button
                          type="button"
                          className="button primary"
                          disabled={resolve.isPending}
                          onClick={() => void approveSale(item)}
                        >
                          <Check size={15} /> Phê duyệt
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={resolve.isPending}
                          onClick={() => void rejectSale(item)}
                        >
                          <X size={15} /> Từ chối
                        </button>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
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
          );
        })
      )}
    </div>
  );
}

export default ApprovalsPage;
