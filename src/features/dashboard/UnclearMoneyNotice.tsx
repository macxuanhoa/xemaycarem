import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, ChevronDown, ChevronRight, Link2, LoaderCircle, X } from "lucide-react";
import { Button, Card, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { canFinance } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { compactMoney, dateLabel, money } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import type { BankTransaction } from "@/types";

/**
 * Phần sót lại duy nhất của tiền chuyển khoản: khoản không đọc ra mã đơn nào.
 * Gọn một dòng trên Dashboard, bấm ra để gán vào đơn hoặc bỏ qua.
 */
export function UnclearMoneyNotice() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState<BankTransaction | null>(null);
  const [linkRef, setLinkRef] = useState("");
  const [ignoring, setIgnoring] = useState<BankTransaction | null>(null);
  const [ignoreReason, setIgnoreReason] = useState("");

  const query = useQuery({
    queryKey: ["unclear-money"],
    // Một lần gọi là đủ: tiền "chưa rõ đơn" gồm khoản không đọc ra mã, và khoản có
    // mã nhưng chưa gắn được vào đơn nào (mã tạo trước khi lập phiếu bán).
    queryFn: () => api.listBankTransactions({ limit: 50 }),
    enabled: canFinance(profile),
    refetchInterval: 60_000,
  });

  const items = (query.data?.items ?? []).filter(
    (t) => t.status !== "IGNORED" && t.status !== "RECORDED" && !t.sale_id,
  );
  const total = items.reduce((sum, t) => sum + t.amount, 0);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["unclear-money"] });
    void client.invalidateQueries({ queryKey: ["notifications"] });
  };

  const linkMut = useMutation({
    mutationFn: (data: { id: string; reference: string }) =>
      api.linkBankTransaction(data),
    onSuccess: () => {
      toast.success("Đã nối khoản tiền vào đơn.", {
        description: "Đơn hàng sẽ hiện khoản chờ ghi nhận để chủ cửa hàng xác nhận.",
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
        description: "Tiền không ghi vào đơn nào và vẫn lưu vết để tìm lại sau.",
      });
      setIgnoring(null);
      setIgnoreReason("");
      refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  if (!canFinance(profile) || items.length === 0) return null;

  return (
    <>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            color: "inherit",
          }}
        >
          <span className="alert-icon">
            <Banknote size={18} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: "0.9375rem" }}>
              {items.length} khoản tiền về chưa rõ của đơn nào
              {total > 0 ? ` (${compactMoney(total)})` : ""}
            </strong>
            <span className="muted small" style={{ display: "block" }}>
              Tiền đã vào tài khoản nhưng chưa gắn được vào đơn — bấm để gán hoặc bỏ qua.
            </span>
          </span>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        {open && (
          <div className="stack" style={{ gap: 10, padding: "0 14px 14px" }}>
            {items.map((txn) => (
              <div
                key={txn.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border-soft, #e2e8f0)",
                }}
              >
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 200 }}>
                  <strong style={{ fontSize: "0.9375rem" }}>{money(txn.amount)}</strong>
                  <span className="muted small">
                    {txn.sender_name || "Người chuyển không rõ"} · {dateLabel(txn.transfer_at)}
                  </span>
                  {txn.reference && (
                    <span className="muted small">
                      Mã trên nội dung chuyển khoản: <code>{txn.reference}</code>
                    </span>
                  )}
                  {txn.transfer_content && (
                    <span className="muted small">Nội dung: “{txn.transfer_content}”</span>
                  )}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setLinking(txn);
                      setLinkRef("");
                    }}
                  >
                    <Link2 size={15} /> Gán vào đơn
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setIgnoring(txn);
                      setIgnoreReason("");
                    }}
                  >
                    <X size={15} /> Bỏ qua
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {linking && (
        <div className="dialog-backdrop" onClick={() => setLinking(null)} role="presentation">
          <div
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Gán khoản tiền vào đơn"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Gán khoản tiền vào đơn</h2>
            <p className="muted small">
              Nhập mã in trên mã QR khách đã quét (dạng CAREM GD01001). Tiền chỉ nối
              vào đơn đang chờ, không tự ghi vào sổ.
            </p>
            <Field label="Mã trên đơn">
              <input
                autoFocus
                value={linkRef}
                maxLength={40}
                placeholder="CAREM GD01001"
                onChange={(e) => setLinkRef(e.target.value)}
              />
            </Field>
            <p className="muted small">
              Số tiền đang gán: <strong>{money(linking.amount)}</strong> ·{" "}
              {linking.sender_name || "—"}
            </p>
            {linkMut.error && (
              <p className="small" style={{ color: "var(--danger, #dc2626)" }}>
                {friendlyError(linkMut.error)}
              </p>
            )}
            <div className="confirm-dialog-actions">
              <Button variant="secondary" onClick={() => setLinking(null)}>
                Hủy
              </Button>
              <Button
                disabled={!linkRef.trim() || linkMut.isPending}
                onClick={() => linkMut.mutate({ id: linking.id, reference: linkRef.trim() })}
              >
                {linkMut.isPending && <LoaderCircle size={14} className="spin" />}
                Nối vào đơn
              </Button>
            </div>
          </div>
        </div>
      )}

      {ignoring && (
        <div className="dialog-backdrop" onClick={() => setIgnoring(null)} role="presentation">
          <div
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Bỏ qua khoản tiền"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Bỏ qua khoản tiền này</h2>
            <p className="muted small">
              Dùng cho tiền không liên quan cửa hàng (chuyển nhầm, hoàn hàng…). Không
              ghi nhận khoản nào, vẫn lưu vết để tìm lại sau.
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
            {ignoreMut.error && (
              <p className="small" style={{ color: "var(--danger, #dc2626)" }}>
                {friendlyError(ignoreMut.error)}
              </p>
            )}
            <div className="confirm-dialog-actions">
              <Button variant="secondary" onClick={() => setIgnoring(null)}>
                Hủy
              </Button>
              <Button
                variant="danger"
                disabled={!ignoreReason.trim() || ignoreMut.isPending}
                onClick={() =>
                  ignoreMut.mutate({ id: ignoring.id, reason: ignoreReason.trim() })
                }
              >
                {ignoreMut.isPending && <LoaderCircle size={14} className="spin" />}
                Đánh dấu bỏ qua
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
