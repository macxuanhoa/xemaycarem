import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  BadgePercent,
  Bike,
  Check,
  Fingerprint,
  Inbox,
  RotateCcw,
  Trash2,
  User,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { celebrateSale } from "@/lib/celebrate";
import { executeOperation } from "@/lib/operationRecovery";
import { dateLabel, money } from "@/lib/format";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { canManage, isOwner } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
} from "@/components/ui";
import { ReviewRow } from "@/features/approvals/DuplicateReviewsPage";
import type { ApprovalKind, ApprovalRequest } from "@/types";

const KIND_LABELS: Record<ApprovalKind, string> = {
  SALE_BELOW_COST: "Bán xe dưới giá thu",
  VEHICLE_DELETION: "Xóa xe khỏi kho",
  VEHICLE_DUPLICATE_REVIEW: "Nghi trùng xe cần xác minh",
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { profile } = useAuth();
  const owner = isOwner(profile);
  const manager = canManage(profile);

  const [offset, setOffset] = useState(0);
  const [dupOffset, setDupOffset] = useState(0);

  // Tab: all | duplicate | sale | deletion
  const tabParam = searchParams.get("tab");
  const activeTab = !owner
    ? "duplicate"
    : tabParam && ["all", "duplicate", "sale", "deletion"].includes(tabParam)
      ? tabParam
      : "all";

  const handleTabChange = (tabId: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (tabId === "all") {
          next.delete("tab");
        } else {
          next.set("tab", tabId);
        }
        return next;
      },
      { replace: true },
    );
  };

  // Queries
  const approvalsQuery = useQuery({
    queryKey: ["approvals", offset],
    queryFn: () =>
      api.listPendingApprovals({
        limit: pageSize,
        offset,
        exclude_kind: "VEHICLE_DUPLICATE_REVIEW",
      }),
    enabled: owner,
    placeholderData: keepPreviousData,
  });

  const duplicateQuery = useQuery({
    queryKey: ["duplicate-reviews", dupOffset],
    queryFn: () =>
      api.listVehicleDuplicateReviews({
        limit: pageSize,
        offset: dupOffset,
      }),
    enabled: manager,
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

  if (!manager) {
    return (
      <EmptyState
        title="Bạn chưa được cấp quyền mở trang này"
        description="Liên hệ chủ cửa hàng nếu cần thay đổi quyền truy cập."
      />
    );
  }

  if ((owner && approvalsQuery.isPending) || duplicateQuery.isPending) {
    return <Loading />;
  }

  if (owner && approvalsQuery.isError) {
    return (
      <ErrorState
        error={approvalsQuery.error}
        retry={() => void approvalsQuery.refetch()}
      />
    );
  }

  if (duplicateQuery.isError && (!owner || activeTab === "duplicate")) {
    return (
      <ErrorState
        error={duplicateQuery.error}
        retry={() => void duplicateQuery.refetch()}
      />
    );
  }

  // Duplicate items
  const duplicateItems = duplicateQuery.data?.items ?? [];
  const duplicateTotal = duplicateQuery.data?.total ?? duplicateItems.length;

  // Approval items (sale & deletion)
  const rawApprovalItems = approvalsQuery.data?.items ?? [];
  const approvalItems = rawApprovalItems.filter(
    (item) => item.kind !== "VEHICLE_DUPLICATE_REVIEW",
  );
  const approvalsTotal = approvalsQuery.data?.total ?? approvalItems.length;

  const sales = approvalItems.filter((item) => item.kind === "SALE_BELOW_COST");
  const deletions = approvalItems.filter((item) => item.kind === "VEHICLE_DELETION");
  const otherItems = approvalItems.filter(
    (item) => item.kind !== "SALE_BELOW_COST" && item.kind !== "VEHICLE_DELETION",
  );

  const totalCount = (owner ? approvalsTotal : 0) + duplicateTotal;

  const tabs = owner
    ? [
        {
          id: "all",
          label: "Tất cả",
          icon: <Inbox size={14} />,
          count: totalCount,
        },
        {
          id: "duplicate",
          label: "Nghi trùng xe",
          icon: <Fingerprint size={14} />,
          count: duplicateTotal,
        },
        {
          id: "sale",
          label: "Bán dưới giá thu",
          icon: <BadgePercent size={14} />,
          count: sales.length,
        },
        {
          id: "deletion",
          label: "Xóa xe khỏi kho",
          icon: <Trash2 size={14} />,
          count: deletions.length,
        },
      ]
    : [
        {
          id: "duplicate",
          label: "Nghi trùng xe",
          icon: <Fingerprint size={14} />,
          count: duplicateTotal,
        },
      ];

  const renderSaleRow = (item: ApprovalRequest) => (
    <div className="compact-row approvals-row" key={item.id}>
      <div className="approvals-row-main">
        <strong>
          {item.vehicle_title || item.vehicle_code || "Xe không còn tồn tại"}
        </strong>
        {saleFacts(item)}
        <small className="muted">
          <User size={12} style={{ verticalAlign: "-1px" }} />{" "}
          {item.requester_name || "Nhân viên"} · {dateLabel(item.created_at)}
        </small>
        <Link className="text-link" to={`/vehicles/${item.subject_id}`}>
          <Bike size={13} /> Xem xe
        </Link>
      </div>
      <div className="align-right approvals-row-actions">
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
      </div>
    </div>
  );

  const renderDeletionRow = (item: ApprovalRequest) => (
    <div className="compact-row approvals-row" key={item.id}>
      <div className="approvals-row-main">
        <strong>
          {item.vehicle_title || item.vehicle_code || "Xe không còn tồn tại"}
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
          {item.requester_name || "Nhân viên"} · {dateLabel(item.created_at)}
        </small>
        <Link className="text-link" to={`/vehicles/${item.subject_id}`}>
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
  );

  return (
    <div className="stack">
      <PageHeader
        title="Chờ duyệt"
        description={
          owner
            ? "Hàng đợi xác minh hồ sơ nghi trùng và phê duyệt đề xuất từ nhân viên mỗi ngày."
            : "Hàng đợi xác minh các hồ sơ xe nghi trùng biển số và số khung do nhân viên gửi lên."
        }
      />

      {!owner && (
        <p className="notice" style={{ margin: 0 }}>
          Bạn đang ở phân quyền Quản lý: duyệt hồ sơ xe nghi trùng. Các yêu cầu
          tài chính (bán dưới giá thu, xóa xe) thuộc thẩm quyền của Chủ cửa hàng.
        </p>
      )}

      {/* Phân loại xét duyệt */}
      <div className="approvals-filter-toolbar">
        <div
          className="approval-segmented-bar"
          role="tablist"
          aria-label="Phân loại duyệt"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`approval-seg-btn${activeTab === t.id ? " active" : ""}`}
              onClick={() => handleTabChange(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
              {t.count !== undefined && (
                <span className="approval-filter-count">{t.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab: Nghi trùng xe */}
      {activeTab === "duplicate" && (
        <>
          {duplicateItems.length === 0 ? (
            <EmptyState
              title="Không có yêu cầu nghi trùng nào đang chờ"
              description="Tất cả hồ sơ xe nghi trùng đã được xử lý xong."
            />
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              {duplicateItems.map((item) => (
                <ReviewRow key={item.id} item={item} />
              ))}
            </div>
          )}
          {duplicateTotal > pageSize && (
            <div className="row between" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="button secondary"
                disabled={dupOffset === 0}
                onClick={() => setDupOffset((o) => Math.max(0, o - pageSize))}
              >
                Trang trước
              </button>
              <span className="muted">
                {dupOffset + 1}–{Math.min(duplicateTotal, dupOffset + pageSize)} /{" "}
                {duplicateTotal}
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={dupOffset + pageSize >= duplicateTotal}
                onClick={() => setDupOffset((o) => o + pageSize)}
              >
                Trang sau
              </button>
            </div>
          )}
        </>
      )}

      {/* Tab: Bán dưới giá thu */}
      {activeTab === "sale" && (
        <>
          {sales.length === 0 ? (
            <EmptyState
              title="Không có yêu cầu bán dưới giá thu nào đang chờ"
              description="Khi nhân viên xin bán dưới giá thu, các yêu cầu sẽ xuất hiện ở đây."
            />
          ) : (
            <Card>
              <h2 className="section-title">
                Bán xe dưới giá thu
                <span className="muted" style={{ marginLeft: 8 }}>
                  ({sales.length})
                </span>
              </h2>
              <div className="compact-list">
                {sales.map((item) => renderSaleRow(item))}
              </div>
            </Card>
          )}
          {approvalsTotal > pageSize && (
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
                {offset + 1}–{Math.min(approvalsTotal, offset + pageSize)} /{" "}
                {approvalsTotal}
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={offset + pageSize >= approvalsTotal}
                onClick={() => setOffset((o) => o + pageSize)}
              >
                Trang sau
              </button>
            </div>
          )}
        </>
      )}

      {/* Tab: Xóa xe */}
      {activeTab === "deletion" && (
        <>
          {deletions.length === 0 ? (
            <EmptyState
              title="Không có yêu cầu xóa xe nào đang chờ"
              description="Khi nhân viên gửi yêu cầu xóa xe khỏi kho, bạn sẽ thấy ở đây."
            />
          ) : (
            <Card>
              <h2 className="section-title">
                Xóa xe khỏi kho
                <span className="muted" style={{ marginLeft: 8 }}>
                  ({deletions.length})
                </span>
              </h2>
              <div className="compact-list">
                {deletions.map((item) => renderDeletionRow(item))}
              </div>
            </Card>
          )}
          {approvalsTotal > pageSize && (
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
                {offset + 1}–{Math.min(approvalsTotal, offset + pageSize)} /{" "}
                {approvalsTotal}
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={offset + pageSize >= approvalsTotal}
                onClick={() => setOffset((o) => o + pageSize)}
              >
                Trang sau
              </button>
            </div>
          )}
        </>
      )}

      {/* Tab: Tất cả */}
      {activeTab === "all" && (
        <>
          {duplicateItems.length === 0 && approvalItems.length === 0 ? (
            <EmptyState
              title="Không có gì chờ duyệt"
              description="Khi nhân viên xin bán dưới giá thu, yêu cầu xóa xe hoặc gửi hồ sơ nghi trùng, bạn sẽ thấy ở đây."
            />
          ) : (
            <div className="stack" style={{ gap: 18 }}>
              {/* Mục xe nghi trùng */}
              {duplicateItems.length > 0 && (
                <div>
                  <div
                    className="row between"
                    style={{ marginBottom: 10, alignItems: "center" }}
                  >
                    <h2
                      className="section-title"
                      style={{
                        margin: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Fingerprint size={18} />
                      Xác minh xe nghi trùng
                      <span className="muted">({duplicateTotal})</span>
                    </h2>
                    {duplicateTotal > duplicateItems.length && (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => handleTabChange("duplicate")}
                      >
                        Xem tất cả ({duplicateTotal})
                      </button>
                    )}
                  </div>
                  <div className="stack" style={{ gap: 14 }}>
                    {duplicateItems.map((item) => (
                      <ReviewRow key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              )}

              {/* Mục bán dưới giá thu */}
              {sales.length > 0 && (
                <Card>
                  <h2 className="section-title">
                    Bán xe dưới giá thu
                    <span className="muted" style={{ marginLeft: 8 }}>
                      ({sales.length})
                    </span>
                  </h2>
                  <div className="compact-list">
                    {sales.map((item) => renderSaleRow(item))}
                  </div>
                </Card>
              )}

              {/* Mục xóa xe */}
              {deletions.length > 0 && (
                <Card>
                  <h2 className="section-title">
                    Xóa xe khỏi kho
                    <span className="muted" style={{ marginLeft: 8 }}>
                      ({deletions.length})
                    </span>
                  </h2>
                  <div className="compact-list">
                    {deletions.map((item) => renderDeletionRow(item))}
                  </div>
                </Card>
              )}

              {/* Mục khác nếu có */}
              {otherItems.length > 0 && (
                <Card>
                  <h2 className="section-title">
                    Yêu cầu khác
                    <span className="muted" style={{ marginLeft: 8 }}>
                      ({otherItems.length})
                    </span>
                  </h2>
                  <div className="compact-list">
                    {otherItems.map((item) => (
                      <div className="compact-row approvals-row" key={item.id}>
                        <div className="approvals-row-main">
                          <strong>
                            {KIND_LABELS[item.kind] || item.kind}
                          </strong>
                          <small>{item.reason}</small>
                          <small className="muted">
                            <User size={12} style={{ verticalAlign: "-1px" }} />{" "}
                            {item.requester_name || "Nhân viên"} ·{" "}
                            {dateLabel(item.created_at)}
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )}

          {approvalsTotal > pageSize && (
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
                {offset + 1}–{Math.min(approvalsTotal, offset + pageSize)} /{" "}
                {approvalsTotal}
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={offset + pageSize >= approvalsTotal}
                onClick={() => setOffset((o) => o + pageSize)}
              >
                Trang sau
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default ApprovalsPage;
