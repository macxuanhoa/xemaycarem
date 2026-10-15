import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { money, dateLabel } from "@/lib/format";
import { canManage } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { paymentLabels } from "@/features/vehicles/vehicleSchema";
import type { Payment } from "@/types";

export type PaymentReceipt = {
  id: string; sale_id: string; amount: number; payment_method: Payment["payment_method"];
  payment_date: string; status: "PENDING" | "RECORDED" | "REJECTED";
  evidence_kind: string | null; evidence_scope: string; evidence_reference: string;
  payment_id: string | null; reference: string; notes: string;
};

export function PaymentReceiptReview({ saleId }: { saleId: string }) {
  const { profile } = useAuth();
  const query = useQuery({
    queryKey: ["payment-receipts", saleId],
    queryFn: () => api.call<PaymentReceipt[]>("list_payment_receipts", { p_sale_id: saleId }),
    refetchInterval: 15000,
  });
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const pending = query.data?.filter(r => r.status === "PENDING") ?? [];
  if (!pending.length) return null;
  return <Card className="stack">
    <h2 className="section-title">Khoản thu chờ xác minh</h2>
    <p className="muted">Các khoản này chưa tính vào tiền đã thu. Quản lý đối chiếu chứng từ, tiền thực nhận và lịch sử thanh toán trước khi ghi nhận.</p>
    {pending.map(receipt => <ReceiptRow key={receipt.id} receipt={receipt} manager={canManage(profile)} />)}
  </Card>;
}

function ReceiptRow({ receipt, manager }: { receipt: PaymentReceipt; manager: boolean }) {
  const client = useQueryClient();
  const [kind, setKind] = useState(receipt.evidence_kind ?? "MANUAL_RECONCILIATION");
  const [scope, setScope] = useState(receipt.evidence_scope);
  const [reference, setReference] = useState(receipt.evidence_reference);
  const [proof, setProof] = useState("");
  const [checked, setChecked] = useState(false);
  const mutation = useMutation({
    mutationFn: (reject: boolean) => reject
      ? api.call("reject_payment_receipt", { p_id: receipt.id, p_reason: proof.trim() })
      : api.call("add_payment", { p_data: {
        request_id: receipt.id, receipt_id: receipt.id,
        evidence_kind: kind, evidence_scope: scope.trim(), evidence_reference: reference.trim(),
        verification_reference: proof.trim(),
      } }),
    onSuccess: async () => { await client.invalidateQueries(); },
  });
  return <div className="stack inset-form">
    <strong>{money(receipt.amount)} · {paymentLabels[receipt.payment_method]} · {dateLabel(receipt.payment_date)}</strong>
    {receipt.reference && <p className="muted">Tham chiếu: {receipt.reference}</p>}
    {receipt.notes && <p>{receipt.notes}</p>}
    {!manager ? <p className="notice">Đang chờ chủ cửa hàng hoặc quản lý xác minh.</p> : <>
      <div className="form-grid">
        <Field label="Loại chứng từ"><select value={kind} disabled={!!receipt.evidence_kind} onChange={e => setKind(e.target.value)}>
          <option value="BANK_TRANSACTION">Giao dịch ngân hàng</option>
          <option value="CASH_VOUCHER">Phiếu thu tiền mặt</option>
          <option value="MANUAL_RECONCILIATION">Biên bản đối chiếu thủ công</option>
        </select></Field>
        <Field label="Tài khoản nhận / sổ chứng từ"><input maxLength={120} value={scope} disabled={!!receipt.evidence_kind} onChange={e => setScope(e.target.value)} /></Field>
        <Field label="Mã giao dịch / phiếu thu dùng chung"><input maxLength={200} value={reference} disabled={!!receipt.evidence_kind} onChange={e => setReference(e.target.value)} /></Field>
        <Field label="Bằng chứng đối chiếu / lý do từ chối"><textarea maxLength={1000} value={proof} onChange={e => setProof(e.target.value)} placeholder="Ghi nguồn bằng chứng đã kiểm tra; nếu nhập trùng, ghi lý do từ chối." /></Field>
      </div>
      <label className="checkbox-label"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />Đã kiểm tra tiền thực nhận, chứng từ và lịch sử; khoản này chưa được ghi nhận.</label>
      {mutation.isError && <ErrorState error={mutation.error} />}
      <div className="form-actions">
        <Button variant="secondary" disabled={mutation.isPending || proof.trim().length < 5} onClick={() => mutation.mutate(true)}>Từ chối khoản thu</Button>
        <Button disabled={mutation.isPending || !checked || proof.trim().length < 5 || !scope.trim() || reference.trim().length < 3} onClick={() => mutation.mutate(false)}>{mutation.isPending ? "Đang xử lý…" : "Xác minh và ghi nhận"}</Button>
      </div>
    </>}
  </div>;
}
