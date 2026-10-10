import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, CreditCard, MoreVertical, QrCode } from "lucide-react";
import { VietQrPaymentModal } from "./VietQrPaymentModal";
import { api } from "@/lib/api";
import { confirmPayment, pendingPayment, retainPayment } from "@/lib/paymentRecovery";
import { AppError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { canFinance, canManage, canOperate } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Badge,
  Button,
  Card,
  DatePicker,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import type { Payment, Sale } from "@/types";
import { CustomerReceipt } from "./CustomerReceipt";
import { IdentityDocumentPanel } from "@/components/IdentityDocumentPanel";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { paymentLabels } from "@/features/vehicles/vehicleSchema";
import { paymentSchema, type PaymentFormValues } from "./saleSchema";
import { PaymentReceiptReview, type PaymentReceipt } from "./PaymentReceiptReview";
import { vehicleTitle } from "@/lib/vehicleDisplay";

type SaleRecord = Sale & {
  vehicle_code?: string;
  cancellation_reason?: string;
};

export function SaleDetailPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const client = useQueryClient();
  const [showPayment, setShowPayment] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [reason, setReason] = useState("");
  const [receipt, setReceipt] = useState<Payment | "sale" | null>(null);
  const [showVietQr, setShowVietQr] = useState(false);

  const query = useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.call<SaleRecord>("get_sale", { p_id: id }),
  });

  const cancel = useMutation({
    mutationFn: () =>
      api.call("cancel_sale", { p_id: id, p_reason: reason.trim() }),
    onSuccess: async () => {
      setShowCancel(false);
      setShowAdjust(false);
      setShowPayment(false);
      await client.invalidateQueries();
    },
  });

  if (query.isPending) return <Loading />;
  if (query.isError)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    );

  const sale = query.data;
  if (!sale) return <EmptyState title="Không tìm thấy giao dịch" />;

  return (
    <div className="stack">
      <Link className="back-link" to="/sales">
        <ArrowLeft size={16} /> Bán ra
      </Link>
      <PageHeader
        title={sale.sale_code}
        description={`Giao dịch ngày ${dateLabel(sale.sale_date)}`}
        actions={
          <>
            <Badge status={sale.status} />
            {sale.status === "COMPLETED" && (
              <Button variant="secondary" onClick={() => setReceipt("sale")}>
                In phiếu bán xe
              </Button>
            )}
            {canManage(profile) && sale.status === "COMPLETED" && (
              <Button
                variant="ghost"
                className="heading-kebab"
                aria-label="Điều chỉnh giao dịch"
                aria-haspopup="true"
                aria-expanded={showAdjust}
                onClick={() => setShowAdjust((open) => !open)}
              >
                <MoreVertical size={18} />
              </Button>
            )}
          </>
        }
      />
      {canManage(profile) && sale.status === "COMPLETED" && showAdjust && (
        <Card className="sale-adjust-panel">
          <div className="row between">
            <h2 className="section-title">Điều chỉnh giao dịch</h2>
            <Button
              variant="ghost"
              onClick={() => {
                setShowAdjust(false);
                setShowCancel(false);
              }}
            >
              Đóng
            </Button>
          </div>
          {!showCancel ? (
            <>
              <p className="muted">
                Hủy giao dịch khi nhập nhầm hoặc khách trả xe. Xe sẽ trở lại tồn
                kho, lịch sử vẫn được giữ lại.
              </p>
              <Button variant="danger" onClick={() => setShowCancel(true)}>
                Hủy giao dịch bán xe
              </Button>
            </>
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (reason.trim().length >= 5) cancel.mutate();
              }}
            >
              <p className="notice">
                Sau khi hủy, đối chiếu và hoàn trả tiền đã nhận bên ngoài hệ
                thống nếu có. Thao tác này được ghi vào nhật ký.
              </p>
              <Field label="Lý do hủy *">
                <textarea
                  autoFocus
                  required
                  minLength={5}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Nhập lý do cụ thể (ít nhất 5 ký tự)"
                />
              </Field>
              {cancel.isError && <ErrorState error={cancel.error} />}
              <div className="form-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowCancel(false)}
                >
                  Giữ giao dịch
                </Button>
                <Button
                  variant="danger"
                  type="submit"
                  disabled={cancel.isPending || reason.trim().length < 5}
                >
                  {cancel.isPending
                    ? "Đang hủy…"
                    : "Xác nhận hủy giao dịch"}
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}
      {receipt && (
        <CustomerReceipt
          sale={sale}
          payment={receipt === "sale" ? undefined : receipt}
          onClose={() => setReceipt(null)}
        />
      )}
      {sale.status === "CANCELLED" && (
        <p className="notice">
          Giao dịch đã hủy. Khoản thu được giữ trong lịch sử và không tính vào
          tổng thu hiện tại. Đối chiếu hoàn tiền thực tế với khách hàng ngoài hệ
          thống.
          {sale.cancellation_reason && ` Lý do: ${sale.cancellation_reason}`}
        </p>
      )}
      <div className={canFinance(profile) ? "detail-grid" : "detail-grid detail-grid-single"}>
        <div className="stack">
          <Card>
            <h2 className="section-title">Thông tin giao dịch</h2>
            <dl className="details-list">
              <div>
                <dt>Xe</dt>
                <dd>
                  <Link
                    className="text-link"
                    to={`/vehicles/${sale.vehicle_id}`}
                  >
                    {vehicleTitle(sale)}{" "}
                    <ArrowRight size={14} />
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Mã xe</dt>
                <dd>
                  {sale.vehicle_code || sale.vehicle?.internal_code || "—"}
                </dd>
              </div>
              <div>
                <dt>Biển số</dt>
                <dd>
                  {sale.license_plate || sale.vehicle?.license_plate || "—"}
                </dd>
              </div>
              <div>
                <dt>Khách hàng</dt>
                <dd>{sale.customer_name}</dd>
              </div>
              <div>
                <dt>Số điện thoại</dt>
                <dd>{sale.customer_phone || "—"}</dd>
              </div>
              <div>
                <dt>Ngày bán</dt>
                <dd>{dateLabel(sale.sale_date)}</dd>
              </div>
            </dl>
            {sale.notes && (
              <div className="notes">
                <strong>Ghi chú</strong>
                <p>{sale.notes}</p>
              </div>
            )}
          </Card>
          <Card>
            <h2 className="section-title">Thanh toán</h2>
            <div className="price-hero">
              <span className="muted">Giá bán</span>
              <strong>{money(sale.sale_price)}</strong>
            </div>
            <dl className="summary-list">
              <div>
                <dt>
                  Đã thu {sale.status === "CANCELLED" ? "(đã vô hiệu)" : ""}
                </dt>
                <dd>{money(sale.paid_amount)}</dd>
              </div>
              <div className="summary-total">
                <dt>Còn phải thu</dt>
                <dd>
                  {sale.status === "CANCELLED"
                    ? "—"
                    : money(sale.remaining_amount)}
                </dd>
              </div>
            </dl>
            {sale.status === "COMPLETED" && sale.remaining_amount === 0 && (
              <p className="notice success">Đã thanh toán đủ</p>
            )}
          </Card>
          {canManage(profile) && (
            <IdentityDocumentPanel
              subjectType="sale"
              subjectId={sale.id}
              title="CCCD khách mua"
              personLabel="Khách mua"
            />
          )}
          <Card>
            <div className="row between">
              <h2 className="section-title">Lịch sử thanh toán</h2>
              {canOperate(profile) &&
                sale.status === "COMPLETED" &&
                sale.remaining_amount > 0 && (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <Button
                      variant="secondary"
                      onClick={() => setShowVietQr(true)}
                    >
                      <QrCode size={16} /> Tạo mã VietQR
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setShowPayment(!showPayment)}
                    >
                      <CreditCard size={16} /> Thu tiền
                    </Button>
                  </div>
                )}
            </div>
            {sale.payments?.length ? (
              <div className="compact-list">
                {sale.payments.map((payment) => (
                  <div className="compact-row" key={payment.id}>
                    <div>
                      <strong>
                        {paymentLabels[payment.payment_method] ??
                          payment.payment_method}
                      </strong>
                      <small>
                        {dateLabel(payment.payment_date)}
                        {payment.reference ? ` · ${payment.reference}` : ""}
                      </small>
                      {payment.notes && <small>{payment.notes}</small>}
                    </div>
                    <div className="align-right">
                      <strong>{money(payment.amount)}</strong>
                      {sale.status === "COMPLETED" &&
                        payment.status !== "VOIDED" && (
                          <Button
                            variant="ghost"
                            onClick={() => setReceipt(payment)}
                          >
                            In phiếu thu
                          </Button>
                        )}
                      {sale.status === "CANCELLED" && (
                        <small className="muted">Không tính vào tổng thu</small>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">Chưa ghi nhận thanh toán.</p>
            )}
            {showPayment && sale.status === "COMPLETED" && (
              <PaymentEditor
                key={`${sale.id}-${sale.paid_amount}`}
                sale={sale}
                onClose={() => setShowPayment(false)}
              />
            )}
          </Card>
          {sale.status === "COMPLETED" && <PaymentReceiptReview saleId={sale.id} />}
        </div>
        {canFinance(profile) && (
          <aside className="stack">
            <Card>
              <h2 className="section-title">Giá vốn đã chốt</h2>
              <dl className="summary-list">
                <div>
                  <dt>Giá mua</dt>
                  <dd>{money(sale.purchase_cost_snapshot)}</dd>
                </div>
                <div>
                  <dt>Chi phí xe</dt>
                  <dd>{money(sale.expense_cost_snapshot)}</dd>
                </div>
                <div>
                  <dt>Tổng giá vốn</dt>
                  <dd>{money(sale.total_cost_snapshot)}</dd>
                </div>
                <div className="summary-total">
                  <dt>Lợi nhuận gộp</dt>
                  <dd>{money(sale.gross_profit)}</dd>
                </div>
              </dl>
              <p className="muted">
                Giá vốn được lưu tại thời điểm bán để bảo toàn báo cáo lịch sử.
              </p>
            </Card>
          </aside>
        )}
      </div>
      {showVietQr && (
        <VietQrPaymentModal
          vehicle={{
            id: sale.vehicle_id,
            license_plate: sale.license_plate || sale.vehicle?.license_plate,
            internal_code: sale.vehicle_code || sale.vehicle?.internal_code,
            vehicle_title: vehicleTitle(sale),
          }}
          saleId={sale.id}
          saleCode={sale.sale_code}
          amount={sale.remaining_amount}
          onClose={() => setShowVietQr(false)}
          onPaymentConfirmed={async () => {
            setShowVietQr(false);
            await client.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}

export function PaymentEditor({
  sale,
  onClose,
}: {
  sale: Sale;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { profile } = useAuth();
  const [evidenceScope, setEvidenceScope] = useState("");
  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      amount: sale.remaining_amount,
      payment_method: "BANK_TRANSFER",
      payment_date: today(),
      reference: "",
      notes: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: PaymentFormValues) => {
      if (!profile?.id) throw new AppError("Phiên làm việc không hợp lệ. Vui lòng đăng nhập lại.");
      const pending = pendingPayment(profile.id, sale.id);
      if (pending) {
        // Upgrade recovery also covers a pre-receipt client whose financial
        // transaction committed before migration but whose response was lost.
        const ledger = await api.call<Sale & { payments: Payment[] }>("get_sale", { p_id: sale.id });
        if (ledger.payments.some(payment => payment.id === pending)) {
          confirmPayment(profile.id, sale.id, pending);
          toast.success("Khoản thu trước đã được ghi nhận. Đã đối soát, không tạo thêm khoản thu.");
          return;
        }
        const latest = await api.call<{ confirmed: boolean; receipt: PaymentReceipt | null }>("get_payment_receipt_request", { p_request_id: pending });
        if (latest.confirmed && latest.receipt?.sale_id === sale.id) {
          confirmPayment(profile.id, sale.id, pending);
          toast.success(latest.receipt.status === "RECORDED" ? "Khoản thu trước đã được ghi nhận. Đã đối soát, không tạo thêm khoản thu." : latest.receipt.status === "REJECTED" ? "Đề nghị thu tiền trước đã bị từ chối. Kiểm tra lại với quản lý." : "Đề nghị thu tiền trước đã được lưu. Không tạo thêm; quản lý kiểm tra mục chờ xác minh.");
          return;
        }
      }
      const id = retainPayment(profile.id, sale.id);
      const hasEvidence = !!values.reference?.trim() && !!evidenceScope.trim();
      const saved = await api.call<PaymentReceipt>("prepare_payment_receipt", {
        p_data: { ...values, sale_id: sale.id, request_id: id,
          evidence_kind: hasEvidence ? (values.payment_method === "BANK_TRANSFER" ? "BANK_TRANSACTION" : values.payment_method === "CASH" ? "CASH_VOUCHER" : "MANUAL_RECONCILIATION") : null,
          evidence_scope: hasEvidence ? evidenceScope.trim() : "",
          evidence_reference: hasEvidence ? values.reference?.trim() : "",
        },
      });
      confirmPayment(profile.id, sale.id, id);
      toast.success(saved.status === "RECORDED" ? "Chứng từ này đã được ghi nhận. Không tạo thêm khoản thu." : saved.status === "REJECTED" ? "Chứng từ này đã bị từ chối. Kiểm tra lại với quản lý." : "Đã lưu đề nghị thu tiền, chờ quản lý xác minh. Tiền đã thu chưa thay đổi.");
    },
    onSuccess: async () => {
      await Promise.all(
        [
          "sale",
          "sales",
          "receivables",
          "dashboard",
          "customers",
          "customer-history",
          "audit",
          "global-search",
          "payment-receipts",
        ].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
      onClose();
    },
  });

  return (
    <form
      className="stack inset-form"
      onSubmit={form.handleSubmit((values) => {
        if (values.amount > sale.remaining_amount) {
          form.setError("amount", {
            message: "Số tiền vượt quá khoản còn phải thu.",
          });
          return;
        }
        mutation.mutate(values);
      })}
    >
      <h3>Ghi nhận thanh toán</h3>
      <fieldset disabled={mutation.isPending} className="stack" style={{ border: 0, padding: 0, minWidth: 0 }}>
      <div className="form-grid">
        <Field
          label="Số tiền (₫) *"
          error={form.formState.errors.amount?.message}
        >
          <MoneyInput
            aria-label="Số tiền (₫) *"
            autoFocus
            value={form.watch("amount")}
            onChange={(amount) =>
              form.setValue("amount", amount ?? 0, { shouldValidate: true })
            }
          />
        </Field>
        <Field label="Hình thức">
          <select {...form.register("payment_method")}>
            {Object.entries(paymentLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Ngày thanh toán *"
          error={form.formState.errors.payment_date?.message}
        >
          <DatePicker
            aria-label="Ngày thanh toán *"
            value={form.watch("payment_date")}
            onChange={(val) =>
              form.setValue("payment_date", val, {
                shouldDirty: true,
                shouldValidate: !!form.formState.errors.payment_date,
              })
            }
            onBlur={() => void form.trigger("payment_date")}
            max={today()}
            required
          />
        </Field>
        <Field
          label="Mã tham chiếu"
          error={form.formState.errors.reference?.message}
        >
          <input
            {...form.register("reference")}
            placeholder="Mã chuyển khoản / chứng từ"
          />
        </Field>
        <Field label="Tài khoản nhận / sổ chứng từ">
          <input maxLength={120} value={evidenceScope} onChange={event => setEvidenceScope(event.target.value)} placeholder="Tài khoản nhận hoặc mã sổ phiếu thu" />
        </Field>
      </div>
      <Field label="Ghi chú" error={form.formState.errors.notes?.message}>
        <textarea rows={2} {...form.register("notes")} />
      </Field>
      </fieldset>
      {mutation.isError && <ErrorState error={mutation.error} />}
      <p className="notice">
        Đề nghị thu {money(form.watch("amount"))} cho {sale.customer_name} ·{" "}
        {sale.sale_code}. Quản lý đối chiếu chứng từ và lịch sử trước khi ghi nhận. Nếu thiếu mã chứng từ, cần lập biên bản đối chiếu dùng chung.
      </p>
      <div className="form-actions form-footer-actions">
        <Button type="button" variant="secondary" onClick={onClose}>
          Đóng
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Đang ghi nhận…" : "Lưu thanh toán"}
        </Button>
      </div>
    </form>
  );
}
