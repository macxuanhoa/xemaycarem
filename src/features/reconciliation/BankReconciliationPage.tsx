import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banknote,
  Check,
  Link2,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { canFinance } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { money, dateLabel } from "@/lib/format";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { BankTransaction, BankTransactionList, BankTxnStatus } from "@/types";

const PAGE_SIZE = 25;

/** Ánh xạ trạng thái đối soát sang nhãn tiếng Việt rõ nghĩa cho nhân viên. */
const STATUS_LABEL: Record<BankTxnStatus, string> = {
  UNMATCHED: "Chưa khớp",
  MATCHED_PENDING: "Khớp tự động — chờ xác nhận",
  MANUAL_REVIEW: "Cần rà soát thủ công",
  RECORDED: "Đã ghi nhận tiền",
  IGNORED: "Đã bỏ qua",
};

const REASON_LABEL: Record<string, string> = {
  REFERENCE_AMOUNT_MATCH: "Mã tham chiếu và số tiền trùng khớp",
  AMOUNT_MISMATCH: "Số tiền không khớp yêu cầu",
  REQUEST_NOT_PENDING: "Yêu cầu đã được xử lý trước đó",
  REFERENCE_FOUND_NO_REQUEST: "Có mã tham chiếu nhưng không còn yêu cầu chờ",
  NO_REFERENCE: "Không đọc được mã tham chiếu",
  MANUAL_LINK: "Nhân viên gán tay",
  AUTO_MATCH_DISABLED: "Tắt đối soát tự động",
  "": "—",
};

const FILTERS: { key: string; label: string; status?: BankTxnStatus }[] = [
  { key: "all", label: "Tất cả" },
  { key: "MATCHED_PENDING", label: "Chờ xác nhận", status: "MATCHED_PENDING" },
  { key: "MANUAL_REVIEW", label: "Rà soát", status: "MANUAL_REVIEW" },
  { key: "UNMATCHED", label: "Chưa khớp", status: "UNMATCHED" },
  { key: "RECORDED", label: "Đã ghi nhận", status: "RECORDED" },
  { key: "IGNORED", label: "Đã bỏ qua", status: "IGNORED" },
];

/** Nút hành động tải với vòng quay riêng, tránh khóa cả danh sách. */
function RowButton({
  children,
  onClick,
  variant = "secondary",
  busy,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={variant}
      onClick={onClick}
      disabled={disabled || busy}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      {busy && <LoaderCircle size={14} className="spin" />}
      {children}
    </Button>
  );
}

export default function BankReconciliationPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [linking, setLinking] = useState<BankTransaction | null>(null);
  const [linkRef, setLinkRef] = useState("");
  const [ignore, setIgnore] = useState<BankTransaction | null>(null);
  const [ignoreReason, setIgnoreReason] = useState("");

  const allowed = canFinance(profile);
  const status = FILTERS.find((f) => f.key === filter)?.status;

  const query = useQuery({
    queryKey: ["bank-transactions", status, page],
    queryFn: () =>
      api.listBankTransactions({
        status,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    enabled: allowed,
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["bank-transactions"] });
    void client.invalidateQueries({ queryKey: ["notifications"] });
    void client.invalidateQueries({ queryKey: ["receivables"] });
    void client.invalidateQueries({ queryKey: ["sales"] });
  };

  const confirmMut = useMutation({
    mutationFn: (txn: BankTransaction) =>
      api.confirmBankTransaction({
        id: txn.id,
        request_id: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast.success("Đã ghi nhận tiền vào đơn bán.", {
        description: "Kho, công nợ và lợi nhuận đã cập nhật qua quy trình xác nhận.",
      });
      refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const linkMut = useMutation({
    mutationFn: (data: { id: string; reference: string }) =>
      api.linkBankTransaction(data),
    onSuccess: () => {
      toast.success("Đã gán giao dịch vào yêu cầu chờ.", {
        description: "Kiểm tra lại số tiền rồi hãy xác nhận ghi nhận.",
      });
      setLinking(null);
      setLinkRef("");
      refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const ignoreMut = useMutation({
    mutationFn: (data: { id: string; reason: string }) =>
      api.ignoreBankTransaction(data),
    onSuccess: () => {
      toast.success("Đã đánh dấu bỏ qua.", {
        description: "Giao dịch này không ghi nhận tiền và vẫn lưu vết kiểm toán.",
      });
      setIgnore(null);
      setIgnoreReason("");
      refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const askConfirm = async (txn: BankTransaction) => {
    const ok = await confirmAction({
      title: "Xác nhận ghi nhận tiền thật?",
      entity: txn.sale_code || txn.vehicle_label || txn.reference || txn.provider_txn_id,
      description:
        "Hệ thống sẽ chuyển khoản này thành thanh toán chính thức cho đơn bán. Hành động ghi vào sổ và chỉ thực hiện một lần.",
      summary: (
        <div className="stack" style={{ gap: 4, fontSize: "0.875rem" }}>
          <span>Số tiền vào: <strong>{money(txn.amount)}</strong></span>
          <span>Người chuyển: {txn.sender_name || "—"}</span>
          <span>Mã tham chiếu: {txn.reference || "—"}</span>
        </div>
      ),
      confirmLabel: "Xác nhận đã thu tiền",
      cancelLabel: "Chưa chắc, để lại",
    });
    if (ok) confirmMut.mutate(txn);
  };

  if (!allowed) {
    return (
      <div className="stack">
        <PageHeader
          title="Đối soát chuyển khoản"
          description="Trang này chỉ dành cho người được xem số thu."
        />
        <EmptyState
          title="Bạn không có quyền đối soát"
          description="Hãy liên hệ chủ cửa hàng nếu bạn cần ghi nhận thanh toán chuyển khoản."
        />
      </div>
    );
  }

  const data: BankTransactionList | undefined = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="stack">
      <PageHeader
        title="Đối soát chuyển khoản"
        description="Giao dịch ngân hàng tự động đưa về đây. Chỉ ghi nhận tiền khi bạn chắc chắn đã thực thu."
        actions={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw size={16} /> Làm mới
          </Button>
        }
      />

      {data && data.pending_count > 0 && (
        <Card className="notice notice-info" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ShieldAlert size={20} style={{ color: "#d97706" }} />
          <span>
            <strong>{data.pending_count}</strong> giao dịch đang chờ người xác nhận.
            Không có khoản nào được ghi sổ cho tới khi bạn bấm xác nhận.
          </span>
        </Card>
      )}

      <div className="settings-tabs-nav" role="group" aria-label="Bộ lọc trạng thái">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            className={`settings-nav-item ${filter === f.key ? "active" : ""}`}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
          >
            <span>{f.label}</span>
          </button>
        ))}
      </div>

      {query.isPending && allowed ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title="Chưa có giao dịch nào"
          description="Khi khách chuyển khoản và webhook ngân hàng được bật, các khoản tiền sẽ xuất hiện ở đây."
        />
      ) : (
        <>
          <div className="stack" style={{ gap: 12 }}>
            {data.items.map((txn) => {
              const confirmable =
                txn.status === "MATCHED_PENDING" ||
                (txn.status === "MANUAL_REVIEW" && !!txn.qr_request_id);
              const linkable =
                txn.status === "UNMATCHED" ||
                (txn.status === "MANUAL_REVIEW" && !txn.qr_request_id);
              const ignorable =
                txn.status === "UNMATCHED" ||
                txn.status === "MATCHED_PENDING" ||
                txn.status === "MANUAL_REVIEW";
              return (
                <Card key={txn.id}>
                  <div className="row between wrap" style={{ gap: 12, alignItems: "flex-start" }}>
                    <div className="stack" style={{ gap: 4, flex: 1, minWidth: 240 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <Banknote size={18} style={{ color: "var(--brand-emerald-dark, #059669)" }} />
                        <strong style={{ fontSize: "1.05rem" }}>{money(txn.amount)}</strong>
                        <span className={`badge badge-status-${txn.status.toLowerCase()}`}>
                          <span />
                          {STATUS_LABEL[txn.status]}
                        </span>
                        <span className="muted small">{txn.provider}</span>
                      </div>
                      <span className="muted small">
                        Người chuyển: <strong>{txn.sender_name || "—"}</strong>
                        {txn.sender_bank ? ` · ${txn.sender_bank}` : ""}
                        {" · "}{dateLabel(txn.transfer_at)}
                      </span>
                      <span className="muted small">
                        Mã tham chiếu: <code>{txn.reference || "(không có)"}</code>
                        {" · "}Lý do: {REASON_LABEL[txn.match_reason] ?? txn.match_reason}
                      </span>
                      {txn.transfer_content && (
                        <span className="muted small">Nội dung CK: “{txn.transfer_content}”</span>
                      )}
                      {(txn.sale_code || txn.vehicle_label) && (
                        <span className="small">
                          Gắn với: <strong>{txn.sale_code || ""}</strong>
                          {txn.vehicle_label ? ` · ${txn.vehicle_label}` : ""}
                        </span>
                      )}
                    </div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      {confirmable && (
                        <RowButton
                          variant="primary"
                          busy={confirmMut.isPending && confirmMut.variables?.id === txn.id}
                          onClick={() => void askConfirm(txn)}
                        >
                          <Check size={15} /> Xác nhận thu tiền
                        </RowButton>
                      )}
                      {linkable && (
                        <RowButton
                          onClick={() => {
                            setLinking(txn);
                            setLinkRef(txn.reference || "");
                          }}
                        >
                          <Link2 size={15} /> Gán vào đơn chờ
                        </RowButton>
                      )}
                      {ignorable && (
                        <RowButton
                          variant="ghost"
                          onClick={() => {
                            setIgnore(txn);
                            setIgnoreReason("");
                          }}
                        >
                          <X size={15} /> Bỏ qua
                        </RowButton>
                      )}
                      {txn.status === "RECORDED" && (
                        <span className="muted small">
                          Đã ghi nhận {dateLabel(txn.confirmed_at)}
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="row between" style={{ alignItems: "center" }}>
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Trang trước
              </Button>
              <span className="muted small">
                Trang {page} / {totalPages} · {data.total} giao dịch
              </span>
              <Button
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Trang sau
              </Button>
            </div>
          )}
        </>
      )}

      {linking && (
        <div className="dialog-backdrop" onClick={() => setLinking(null)} role="presentation">
          <div className="dialog-panel" role="dialog" aria-modal="true" aria-label="Gán giao dịch"
            onClick={(e) => e.stopPropagation()}>
            <h2>Gán giao dịch vào đơn đang chờ</h2>
            <p className="muted small">
              Nhập mã tham chiếu in trên mã VietQR khách đã quét (dạng CAREM GD01001).
              Hệ thống chỉ nối vào yêu cầu đang chờ và KHÔNG tự ghi tiền.
            </p>
            <Field label="Mã tham chiếu">
              <input
                autoFocus
                value={linkRef}
                maxLength={40}
                placeholder="CAREM GD01001"
                onChange={(e) => setLinkRef(e.target.value)}
              />
            </Field>
            <p className="muted small">
              Số tiền đang chờ gán: <strong>{money(linking.amount)}</strong> · {linking.sender_name || "—"}
            </p>
            {linkMut.error && <ErrorState error={linkMut.error} />}
            <div className="confirm-dialog-actions">
              <Button variant="secondary" onClick={() => setLinking(null)}>Hủy</Button>
              <RowButton
                variant="primary"
                busy={linkMut.isPending}
                disabled={!linkRef.trim()}
                onClick={() =>
                  linkMut.mutate({ id: linking.id, reference: linkRef.trim() })
                }
              >
                Nối vào đơn chờ
              </RowButton>
            </div>
          </div>
        </div>
      )}

      {ignore && (
        <div className="dialog-backdrop" onClick={() => setIgnore(null)} role="presentation">
          <div className="dialog-panel" role="dialog" aria-modal="true" aria-label="Bỏ qua giao dịch"
            onClick={(e) => e.stopPropagation()}>
            <h2>Bỏ qua giao dịch này</h2>
            <p className="muted small">
              Dùng cho tiền không liên quan cửa hàng (chuyển nhầm, hoàn hàng…).
              Không ghi nhận bất kỳ khoản nào; giao dịch vẫn được lưu để kiểm tra sau.
            </p>
            <Field label="Lý do bỏ qua">
              <input
                autoFocus
                value={ignoreReason}
                maxLength={240}
                placeholder="VD: Khách chuyển nhầm, không phải mua xe"
                onChange={(e) => setIgnoreReason(e.target.value)}
              />
            </Field>
            {ignoreMut.error && <ErrorState error={ignoreMut.error} />}
            <div className="confirm-dialog-actions">
              <Button variant="secondary" onClick={() => setIgnore(null)}>Hủy</Button>
              <RowButton
                variant="danger"
                busy={ignoreMut.isPending}
                disabled={!ignoreReason.trim()}
                onClick={() =>
                  ignoreMut.mutate({ id: ignore.id, reason: ignoreReason.trim() })
                }
              >
                Đánh dấu bỏ qua
              </RowButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
