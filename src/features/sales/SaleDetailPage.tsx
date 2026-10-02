import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, CreditCard } from "lucide-react";
import { api } from "@/lib/api";
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

type SaleRecord = Sale & {
  vehicle_code?: string;
  vehicle_name?: string;
  cancellation_reason?: string;
};
type CommunicationJob = { id?: string; channel?: string; status?: string; attempt_count?: number; last_error_code?: string; last_error_message_safe?: string };

export function SaleDetailPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const client = useQueryClient();
  const [showPayment, setShowPayment] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [reason, setReason] = useState("");
  const [receipt, setReceipt] = useState<Payment | "sale" | null>(null);

  const query = useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.call<SaleRecord>("get_sale", { p_id: id }),
  });
  const communication = useQuery({
    queryKey: ["sale-communication", id],
    queryFn: () => api.call<CommunicationJob>("get_sale_communication", { p_sale_id: id }),
    enabled: !!id,
    refetchInterval: (q) => q.state.data?.status === "QUEUED" || q.state.data?.status === "PROCESSING" ? 3000 : false,
  });
  const retryMessage = useMutation({
    mutationFn: async () => {
      await api.call("retry_sale_thank_you", { p_sale_id: id });
      const job = await api.call<CommunicationJob>("get_sale_communication", { p_sale_id: id });
      if (job.id) await api.processMessage(job.id);
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["sale-communication", id] }); },
  });

  const cancel = useMutation({
    mutationFn: () =>
      api.call("cancel_sale", { p_id: id, p_reason: reason.trim() }),
    onSuccess: async () => {
      setShowCancel(false);
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
          </>
        }
      />
      {receipt && (
        <CustomerReceipt
          sale={sale}
          payment={receipt === "sale" ? undefined : receipt}
          onClose={() => setReceipt(null)}
        />
      )}
      {sale.status === "COMPLETED" && (
        <Card className="row between">
          <div>
            <h2 className="section-title">Lời cảm ơn khách hàng</h2>
            <p className="muted small">
              {communication.data?.status === "SENT" ? `Đã gửi qua ${communication.data.channel === "ZALO_ZNS" ? "Zalo" : communication.data.channel}` :
                communication.data?.status === "DELIVERED" ? "Nhà cung cấp xác nhận đã nhận tin" :
                communication.data?.status === "QUEUED" ? "Đang chờ xử lý" :
                communication.data?.status === "PROCESSING" ? "Đang gửi" :
                communication.data?.status === "SKIPPED" && communication.data.last_error_code === "PROVIDER_NOT_CONFIGURED" ? "Chưa cấu hình nhà cung cấp tin nhắn" :
                communication.data?.status === "FAILED" ? `Gửi thất bại${communication.data.last_error_message_safe ? `: ${communication.data.last_error_message_safe}` : ""}` :
                communication.data?.status === "SKIPPED" ? "Chưa cấu hình kênh nhắn tin hoặc số điện thoại không hợp lệ" : "Chưa gửi"}
            </p>
          </div>
          {canManage(profile) && communication.data?.status === "FAILED" && communication.data.last_error_code !== "PROVIDER_NOT_CONFIGURED" && communication.data?.channel !== "DISABLED" && (
            <Button variant="secondary" disabled={retryMessage.isPending} onClick={() => retryMessage.mutate()}>Thử gửi lại</Button>
          )}
          {retryMessage.error && <ErrorState error={retryMessage.error} />}
        </Card>
      )}
      {sale.status === "CANCELLED" && (
        <p className="notice">
          Giao dịch đã hủy. Khoản thu được giữ trong lịch sử và không tính vào
          tổng thu hiện tại. Đối chiếu hoàn tiền thực tế với khách hàng ngoài hệ
          thống.
          {sale.cancellation_reason && ` Lý do: ${sale.cancellation_reason}`}
        </p>
      )}
      <div className="detail-grid">
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
                    {sale.vehicle_name ||
                      `${sale.vehicle?.brand ?? ""} ${sale.vehicle?.model ?? ""}`}{" "}
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
                  <Button
                    variant="secondary"
                    onClick={() => setShowPayment(!showPayment)}
                  >
                    <CreditCard size={16} /> Thu tiền
                  </Button>
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
          {canManage(profile) && sale.status === "COMPLETED" && (
            <Card>
              <h2 className="section-title">Điều chỉnh giao dịch</h2>
              {!showCancel ? (
                <>
                  <p className="muted">
                    Hủy giao dịch khi nhập nhầm hoặc khách trả xe. Xe sẽ trở lại
                    tồn kho, lịch sử vẫn được giữ lại.
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
        </div>
        <aside className="stack">
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
          {canFinance(profile) && (
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
          )}
        </aside>
      </div>
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
  const request = useRef<{ signature: string; id: string } | null>(null);
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
    mutationFn: (values: PaymentFormValues) => {
      const signature = JSON.stringify(values);
      if (request.current?.signature !== signature)
        request.current = { signature, id: crypto.randomUUID() };
      return api.call("add_payment", {
        p_data: { ...values, sale_id: sale.id, request_id: request.current.id },
      });
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
      </div>
      <Field label="Ghi chú" error={form.formState.errors.notes?.message}>
        <textarea rows={2} {...form.register("notes")} />
      </Field>
      {mutation.isError && <ErrorState error={mutation.error} />}
      <p className="notice">
        Xác nhận thu {money(form.watch("amount"))} cho {sale.customer_name} ·{" "}
        {sale.sale_code}.
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
