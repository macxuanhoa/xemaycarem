import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Ban, Check, Circle, CreditCard, MoreHorizontal, Printer, QrCode, X } from "lucide-react";
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
import { displayFrame } from "@/lib/frameNumber";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";

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
  const [menuOpen, setMenuOpen] = useState(false);
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
      setMenuOpen(false);
      setShowPayment(false);
      await client.invalidateQueries();
    },
  });

  // Escape đóng cả menu kebab lẫn hộp thoại hủy, giống menu chi tiết xe.
  useEffect(() => {
    if (!menuOpen && !showCancel) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setShowCancel(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, showCancel]);

  if (query.isPending) return <Loading />;
  if (query.isError && !query.data)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    );

  const sale = query.data;
  if (!sale) return <EmptyState title="Không tìm thấy giao dịch" />;

  const canPrintReceipt = sale.status === "COMPLETED" && !sale.sale_price_hidden;
  const canCancelSale = canManage(profile) && sale.status === "COMPLETED";

  return (
    <div className="stack">
      <Link
        className="back-link"
        to={sale.vehicle_id ? `/vehicles/${sale.vehicle_id}` : "/vehicles?status=SOLD"}
      >
        <ArrowLeft size={16} /> {sale.vehicle_id ? "Chi tiết xe" : "Kho xe đã bán"}
      </Link>
      {/* Title là mã giao dịch trần (một token, không dấu cách) nên không bao giờ
          bị cắt dòng xấu; nhãn "Mã giao dịch" chuyển xuống dòng mô tả. */}
      <PageHeader
        title={sale.sale_code}
        description={`Mã giao dịch bán xe · Ngày ${dateLabel(sale.sale_date)}`}
        actions={
          <>
            <Badge status={sale.status} />
            {(canPrintReceipt || canCancelSale) && (
              /* Kebab mở menu nổi neo ngay dưới nút (đúng kiểu chi tiết xe),
                 không đẩy nội dung trang xuống như thẻ điều chỉnh cũ. */
              <div className="vehicle-actions-menu-wrap">
                <button
                  type="button"
                  className="icon-button vehicle-actions-trigger"
                  aria-label="Thao tác giao dịch"
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <MoreHorizontal size={22} />
                </button>
                {menuOpen && (
                  <>
                    <div
                      className="vehicle-actions-scrim"
                      role="presentation"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="vehicle-actions-menu">
                      {canPrintReceipt && (
                        <button
                          type="button"
                          className="vehicle-actions-menu-item vehicle-actions-menu-primary"
                          onClick={() => {
                            setMenuOpen(false);
                            setReceipt("sale");
                          }}
                        >
                          <Printer size={16} /> In phiếu bán xe
                        </button>
                      )}
                      {canCancelSale && (
                        <button
                          type="button"
                          className="vehicle-actions-menu-item vehicle-actions-menu-danger"
                          onClick={() => {
                            setMenuOpen(false);
                            setShowCancel(true);
                          }}
                        >
                          <Ban size={16} /> Hủy giao dịch
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        }
      />
      {showCancel && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShowCancel(false)}
        >
          <div
            className="modal-card sale-cancel-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sale-cancel-title"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Đầu đề chuẩn: biểu tượng hủy trong ô tint đỏ + nhãn, nút X góc
                phải — thay cho nút "Đóng" chữ trôi nổi cùng khoảng trống thừa. */}
            <div className="modal-header sale-cancel-header">
              <div className="sale-cancel-heading">
                <span className="sale-cancel-icon" aria-hidden="true">
                  <Ban size={17} />
                </span>
                <h3 id="sale-cancel-title">Hủy giao dịch bán xe</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Đóng hộp thoại"
                onClick={() => setShowCancel(false)}
              >
                <X size={18} />
              </button>
            </div>
            <form
              className="sale-cancel-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (reason.trim().length >= 5) cancel.mutate();
              }}
            >
              <p className="notice">
                Xe trở lại tồn kho, lịch sử giao dịch vẫn được giữ. Khoản đã thu
                cần đối chiếu và hoàn trả ngoài hệ thống nếu có. Thao tác này
                được ghi vào nhật ký kiểm toán.
              </p>
              <Field
                label="Lý do hủy *"
                error={
                  reason.length > 0 && reason.trim().length < 5
                    ? "Ít nhất 5 ký tự."
                    : undefined
                }
              >
                <textarea
                  autoFocus
                  required
                  minLength={5}
                  maxLength={1000}
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Nhập lý do cụ thể (ít nhất 5 ký tự)"
                />
              </Field>
              {/* Đếm ký hiệu im lặng: biết đã đủ dài hay chưa mà không cần lỗi. */}
              <p className="sale-reason-counter muted small">
                {reason.trim().length >= 5 ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <Circle size={13} aria-hidden="true" />
                )}{" "}
                {reason.trim().length}/1000 · tối thiểu 5 ký tự
              </p>
              {cancel.isError && <ErrorState error={cancel.error} />}
              <div className="modal-footer sale-cancel-footer">
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
          </div>
        </div>
      )}
      {receipt && !sale.sale_price_hidden && (
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
          {sale.cancellation_reason && (
            <> <em>Lý do: {sale.cancellation_reason}</em></>
          )}
        </p>
      )}
      <div className="detail-grid">
        {/* Cột trái: Thông tin giao dịch & Lịch sử thanh toán */}
        <div className="stack">
          <Card>
            <h2 className="section-title">Thông tin giao dịch</h2>
            {/* Xe đã bán: một dải định danh gọn (biển số · loại · khung · mã kho)
                thay cho bốn dòng thông số lặp lại y hệt trang chi tiết xe. */}
            <Link className="sale-vehicle-strip" to={`/vehicles/${sale.vehicle_id}`}>
              <span className="identity-chip-plate">
                <strong>{sale.license_plate || sale.vehicle?.license_plate || "Chưa có"}</strong>
              </span>
              <span className="sale-vehicle-text">
                <strong>{sale.vehicle_type || vehicleSubtitle(sale) || "Xem chi tiết xe"}</strong>
                <small>
                  Khung {displayFrame(sale.vehicle?.frame_number) || "chưa có"} · Mã kho{" "}
                  {sale.vehicle_code || sale.vehicle?.internal_code || "—"}
                </small>
              </span>
              <ArrowRight size={16} className="sale-vehicle-arrow" aria-hidden="true" />
            </Link>
            <dl className="sale-spec-list sale-party-list">
              <div>
                <dt>Khách hàng</dt>
                <dd>
                  <strong>{sale.customer_name}</strong>
                  {sale.customer_phone && (
                    <a href={`tel:${sale.customer_phone}`} className="text-link">
                      {sale.customer_phone}
                    </a>
                  )}
                </dd>
              </div>
              <div>
                <dt>Bán ngày</dt>
                <dd>
                  {dateLabel(sale.sale_date)} · {sale.employee_name || "Nhân viên cửa hàng"}
                </dd>
              </div>
            </dl>

            {sale.notes && (
              <div className="sale-notes-box">
                <span className="sale-notes-label">Ghi chú giao dịch</span>
                <p>{sale.notes}</p>
              </div>
            )}
          </Card>

          <Card>
            <div className="row between sale-payments-head">
              <h2 className="section-title">Lịch sử thanh toán</h2>
              {!sale.sale_price_hidden && canOperate(profile) &&
                sale.status === "COMPLETED" &&
                sale.remaining_amount > 0 && (
                  <div className="row" style={{ gap: "8px" }}>
                    <Button variant="ghost" onClick={() => setShowVietQr(true)}>
                      <QrCode size={16} /> VietQR
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
            {!sale.sale_price_hidden && sale.payments?.length ? (
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
              <p className="muted">{sale.sale_price_hidden
                ? "Thông tin thanh toán do chủ cửa hàng quản lý."
                : "Chưa ghi nhận thanh toán."}</p>
            )}
            {showPayment && !sale.sale_price_hidden && sale.status === "COMPLETED" && (
              <PaymentEditor
                key={`${sale.id}-${sale.paid_amount}`}
                sale={sale}
                onClose={() => setShowPayment(false)}
              />
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

          {!sale.sale_price_hidden && sale.status === "COMPLETED" && <PaymentReceiptReview saleId={sale.id} />}
        </div>

        {/* Cột phải: một thẻ tài chính duy nhất — thanh toán ở trên,
            hiệu quả bán hàng (chỉ người có quyền tài chính thấy) ngăn cách
            bằng một vạch mờ, thay vì hai thẻ giá rời rạc chồng nhau. */}
        <aside className="stack">
          <Card>
            <div className="row between" style={{ alignItems: "center", marginBottom: 10 }}>
              <h2 className="section-title" style={{ margin: 0 }}>Tài chính giao dịch</h2>
              {!sale.sale_price_hidden && sale.status === "COMPLETED" && (
                sale.remaining_amount === 0 ? (
                  <span className="badge success small">Đã thanh toán đủ</span>
                ) : (
                  <span className="badge warning small">Còn nợ</span>
                )
              )}
            </div>
            <div className="price-hero">
              <span className="muted">Giá bán</span>
              <strong>{sale.sale_price_hidden ? "Cà Rem nhập" : money(sale.sale_price)}</strong>
            </div>
            <dl className="summary-list">
              <div>
                <dt>
                  Đã thu {sale.status === "CANCELLED" ? "(đã vô hiệu)" : ""}
                </dt>
                <dd>{sale.sale_price_hidden ? "Cà Rem nhập" : money(sale.paid_amount)}</dd>
              </div>
              <div className="summary-total">
                <dt>Còn phải thu</dt>
                <dd style={{ color: sale.remaining_amount > 0 ? "var(--color-danger, #c2410c)" : "var(--color-primary-dark, #2b6127)" }}>
                  {sale.sale_price_hidden ? "Cà Rem nhập" : sale.status === "CANCELLED"
                    ? "—"
                    : money(sale.remaining_amount)}
                </dd>
              </div>
            </dl>
            {canFinance(profile) && (
              <div className="sale-profit-block">
                <h3 className="sale-profit-head">Hiệu quả bán hàng</h3>
                <dl className="summary-list">
                  <div>
                    <dt>Tổng giá vốn</dt>
                    <dd>
                      {money(sale.total_cost_snapshot)}
                      <small className="sale-cost-detail">
                        {" "}· mua {money(sale.purchase_cost_snapshot)} · chi phí{" "}
                        {money(sale.expense_cost_snapshot)}
                      </small>
                    </dd>
                  </div>
                  <div className="summary-total">
                    <dt>Lợi nhuận gộp</dt>
                    <dd style={{ color: (sale.gross_profit ?? 0) >= 0 ? "var(--color-primary-dark, #2b6127)" : "var(--color-danger, #dc2626)" }}>
                      {money(sale.gross_profit)}
                    </dd>
                  </div>
                </dl>
                <p className="sale-profit-note">
                  Giá vốn chốt tại thời điểm bán, giữ nguyên cho báo cáo lịch sử.
                </p>
              </div>
            )}
          </Card>
        </aside>
      </div>
      {showVietQr && !sale.sale_price_hidden && (
        <VietQrPaymentModal
          vehicle={{
            id: sale.vehicle_id,
            license_plate: sale.license_plate || sale.vehicle?.license_plate,
            internal_code: sale.vehicle_code || sale.vehicle?.internal_code,
            vehicle_title: vehicleTitle(sale),
          }}
          saleId={sale.id}
          saleCode={sale.sale_code}
          payerName={sale.customer_name}
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
