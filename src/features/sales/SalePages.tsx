import { useDeferredValue, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  CirclePlus,
  CreditCard,
  Search,
  ShoppingBag,
} from "lucide-react";
import { api } from "@/lib/api";
import { canFinance, canManage, canOperate } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  Badge,
  Button,
  Card,
  DateRange,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Pagination,
} from "@/components/ui";
import type { Paged, Sale, Vehicle } from "@/types";
import { paymentLabels } from "@/features/vehicles/vehicleSchema";
import {
  paymentSchema,
  saleSchema,
  type PaymentFormValues,
  type SaleFormValues,
} from "./saleSchema";

const pageSize = 20;
type SaleRecord = Sale & {
  vehicle_code?: string;
  vehicle_name?: string;
  cancellation_reason?: string;
};

export function SalesPage() {
  const { profile } = useAuth();
  const [range, setRange] = useState({
    from: `${today().slice(0, 7)}-01`,
    to: today(),
  });
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["sales", range, deferredSearch, page],
    queryFn: () =>
      api.call<Paged<SaleRecord>>("list_sales", {
        p_filters: {
          ...range,
          search: deferredSearch,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
  });
  return (
    <div className="stack">
      <PageHeader
        title="Bán hàng"
        description="Theo dõi giao dịch, thanh toán và công nợ của từng xe."
        actions={
          canOperate(profile) ? (
            <Link className="button primary" to="/sell">
              <CirclePlus size={18} /> Tạo giao dịch
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="row filter-row">
          <label className="search-field">
            <Search size={19} />
            <input
              aria-label="Tìm giao dịch"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Mã giao dịch, khách hàng, SĐT, mã xe…"
            />
          </label>
          <DateRange
            value={range}
            onChange={(value) => {
              setRange(value);
              setPage(1);
            }}
          />
        </div>
      </Card>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.items.length ? (
        <EmptyState
          title="Chưa có giao dịch trong khoảng thời gian này"
          description="Thay đổi bộ lọc ngày hoặc tạo giao dịch bán xe mới."
        />
      ) : (
        <Card className="table-card">
          <div className="table-wrap desktop-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Giao dịch / Ngày bán</th>
                  <th>Xe</th>
                  <th>Khách hàng</th>
                  <th className="numeric">Giá bán</th>
                  <th className="numeric">Còn phải thu</th>
                  <th>Trạng thái</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      <Link className="text-link" to={`/sales/${sale.id}`}>
                        {sale.sale_code}
                      </Link>
                      <small>{dateLabel(sale.sale_date)}</small>
                    </td>
                    <td>
                      <strong>
                        {sale.vehicle_name ||
                          `${sale.vehicle?.brand ?? ""} ${sale.vehicle?.model ?? ""}`}
                      </strong>
                      <small>
                        {sale.vehicle_code || sale.vehicle?.internal_code}
                      </small>
                    </td>
                    <td>
                      <strong>{sale.customer_name}</strong>
                      <small>
                        {sale.customer_phone || "Chưa có số điện thoại"}
                      </small>
                    </td>
                    <td className="numeric price">{money(sale.sale_price)}</td>
                    <td className="numeric">
                      {sale.status === "CANCELLED"
                        ? "—"
                        : money(sale.remaining_amount)}
                    </td>
                    <td>
                      <Badge status={sale.status} />
                    </td>
                    <td>
                      <Link
                        className="icon-button"
                        aria-label={`Xem ${sale.sale_code}`}
                        to={`/sales/${sale.id}`}
                      >
                        <ArrowRight size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-cards">
            {query.data.items.map((sale) => (
              <Link
                className="mobile-record"
                to={`/sales/${sale.id}`}
                key={sale.id}
              >
                <div className="row between">
                  <strong>{sale.sale_code}</strong>
                  <Badge status={sale.status} />
                </div>
                <span>{sale.vehicle_name || sale.vehicle_code}</span>
                <span className="muted">
                  {sale.customer_name} · {dateLabel(sale.sale_date)}
                </span>
                <div className="row between">
                  <strong className="price">{money(sale.sale_price)}</strong>
                  <small>
                    {sale.status === "CANCELLED"
                      ? "Đã hủy"
                      : `Còn thu ${money(sale.remaining_amount)}`}
                  </small>
                </div>
              </Link>
            ))}
          </div>
          <Pagination
            page={page}
            total={query.data.total}
            pageSize={pageSize}
            onChange={setPage}
          />
        </Card>
      )}
    </div>
  );
}

export function SellVehiclePage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const vehicle = useQuery({
    queryKey: ["vehicle", id],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: id }),
    enabled: !!id,
  });
  const inventory = useQuery({
    queryKey: ["sell-vehicle-picker", deferredSearch, page],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: {
          search: deferredSearch,
          status: "AVAILABLE",
          offset: (page - 1) * pageSize,
          limit: pageSize,
        },
      }),
    enabled: !id,
  });
  if (!canOperate(profile))
    return <EmptyState title="Bạn không có quyền tạo giao dịch." />;
  if (!id)
    return (
      <div className="stack">
        <PageHeader
          title="Tạo giao dịch bán xe"
          description="Chọn xe trong kho để bắt đầu bán hàng."
        />
        <Card>
          <label className="search-field">
            <Search size={19} />
            <input
              aria-label="Tìm xe để bán"
              autoFocus
              placeholder="Tìm mã xe, biển số, hãng, dòng xe…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </Card>
        {inventory.isPending ? (
          <Loading />
        ) : inventory.isError ? (
          <ErrorState
            error={inventory.error}
            retry={() => void inventory.refetch()}
          />
        ) : !inventory.data.items.length ? (
          <EmptyState
            title="Không có xe có thể bán"
            description="Nhập thêm xe hoặc thử từ khóa khác."
          />
        ) : (
          <Card>
            {inventory.data.items.map((item) => (
              <div key={item.id} className="compact-row">
                <div className="vehicle-cell">
                  <span className="vehicle-icon">
                    <Bike size={25} />
                  </span>
                  <div>
                    <strong>
                      {item.brand} {item.model}
                    </strong>
                    <small>
                      {item.internal_code} ·{" "}
                      {item.license_plate || "Chưa có biển số"}
                    </small>
                  </div>
                </div>
                <div className="row">
                  <span className="price">{money(item.asking_price)}</span>
                  <Link
                    className="button secondary"
                    to={`/vehicles/${item.id}/${item.cost_pending ? "edit" : "sell"}`}
                  >
                    {item.cost_pending ? "Chờ giá nhập" : "Chọn xe"}
                    <ArrowRight size={16} />
                  </Link>
                </div>
              </div>
            ))}
            <Pagination
              page={page}
              total={inventory.data.total}
              pageSize={pageSize}
              onChange={setPage}
            />
          </Card>
        )}
      </div>
    );
  if (vehicle.isPending) return <Loading />;
  if (vehicle.isError)
    return (
      <ErrorState error={vehicle.error} retry={() => void vehicle.refetch()} />
    );
  if (
    !vehicle.data ||
    !["IN_STOCK", "RESERVED"].includes(vehicle.data.status) ||
    vehicle.data.cost_pending
  )
    return (
      <div className="stack">
        <EmptyState
          title="Xe chưa sẵn sàng để bán"
          description="Xe phải đang tồn kho hoặc được giữ chỗ, có đủ giá nhập và chưa được bán."
        />
        <Link className="button secondary" to={`/vehicles/${id}`}>
          Về chi tiết xe
        </Link>
      </div>
    );
  return <SaleEditor key={vehicle.data.id} vehicle={vehicle.data} />;
}

function SaleEditor({ vehicle }: { vehicle: Vehicle }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const form = useForm<SaleFormValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: {
      customer_name: "",
      customer_phone: "",
      sale_price: vehicle.asking_price,
      sale_date: today(),
      initial_payment: 0,
      payment_method: "CASH",
      notes: "",
    },
  });
  const price = form.watch("sale_price");
  const paid = form.watch("initial_payment");
  const mutation = useMutation({
    mutationFn: (values: SaleFormValues) =>
      api.call<string>("sell_vehicle", {
        p_data: { ...values, vehicle_id: vehicle.id },
      }),
    onSuccess: async (saleId) => {
      await client.invalidateQueries();
      navigate(`/sales/${saleId}`);
    },
  });
  const error = (key: keyof SaleFormValues) =>
    form.formState.errors[key]?.message;
  return (
    <div className="stack">
      <Link className="back-link" to={`/vehicles/${vehicle.id}`}>
        <ArrowLeft size={16} /> Chi tiết xe
      </Link>
      <PageHeader
        title="Bán xe"
        description="Hoàn tất thông tin khách hàng, giá bán và thanh toán trong một bước."
      />
      <form
        onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        className="detail-grid"
      >
        <div className="stack">
          <Card>
            <h2 className="section-title">Khách hàng</h2>
            <div className="form-grid">
              <Field label="Tên khách hàng *" error={error("customer_name")}>
                <input
                  autoFocus
                  autoComplete="name"
                  {...form.register("customer_name")}
                  placeholder="Họ và tên khách hàng"
                />
              </Field>
              <Field label="Số điện thoại" error={error("customer_phone")}>
                <input
                  type="tel"
                  autoComplete="tel"
                  {...form.register("customer_phone")}
                />
              </Field>
            </div>
          </Card>
          <Card>
            <h2 className="section-title">Giá bán & thanh toán</h2>
            <div className="form-grid">
              <Field label="Giá bán thực tế (₫) *" error={error("sale_price")}>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  {...form.register("sale_price", { valueAsNumber: true })}
                />
              </Field>
              <Field label="Ngày bán *" error={error("sale_date")}>
                <input type="date" {...form.register("sale_date")} />
              </Field>
              <Field
                label="Thu tiền lần đầu (₫)"
                error={error("initial_payment")}
              >
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max={Number.isFinite(price) ? price : undefined}
                  step="1"
                  {...form.register("initial_payment", { valueAsNumber: true })}
                />
              </Field>
              <Field label="Hình thức thanh toán">
                <select {...form.register("payment_method")}>
                  {Object.entries(paymentLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                form.setValue(
                  "initial_payment",
                  Number.isFinite(price) ? price : 0,
                  { shouldValidate: true },
                )
              }
            >
              Đã thu đủ tiền
            </Button>
            <Field label="Ghi chú" error={error("notes")}>
              <textarea
                rows={3}
                {...form.register("notes")}
                placeholder="Điều kiện bàn giao, thỏa thuận với khách hàng…"
              />
            </Field>
          </Card>
          {mutation.isError && <ErrorState error={mutation.error} />}
        </div>
        <aside className="stack">
          <Card>
            <div className="vehicle-icon large">
              <Bike size={48} />
            </div>
            <h2 className="section-title">
              {vehicle.brand} {vehicle.model}
            </h2>
            <p className="muted">
              {vehicle.internal_code} ·{" "}
              {vehicle.license_plate || "Chưa có biển số"}
            </p>
            <Badge status={vehicle.status} />
            <dl className="summary-list">
              <div>
                <dt>Giá niêm yết</dt>
                <dd>{money(vehicle.asking_price)}</dd>
              </div>
              {canFinance(profile) && (
                <div>
                  <dt>Giá vốn hiện tại</dt>
                  <dd>{money(vehicle.total_cost)}</dd>
                </div>
              )}
              <div>
                <dt>Giá bán</dt>
                <dd>{money(Number.isFinite(price) ? price : 0)}</dd>
              </div>
              <div>
                <dt>Thu lần đầu</dt>
                <dd>{money(Number.isFinite(paid) ? paid : 0)}</dd>
              </div>
              <div className="summary-total">
                <dt>Còn phải thu</dt>
                <dd>
                  {money(
                    Number.isFinite(price - paid)
                      ? Math.max(0, price - paid)
                      : 0,
                  )}
                </dd>
              </div>
            </dl>
            <p className="muted">
              Giá vốn được chốt tại thời điểm bán. Bạn có thể ghi nhận các lần
              thanh toán tiếp theo trong chi tiết giao dịch.
            </p>
            <Button
              type="submit"
              className="full-width"
              disabled={mutation.isPending}
            >
              <ShoppingBag size={17} />
              {mutation.isPending ? "Đang hoàn tất…" : "Xác nhận bán xe"}
            </Button>
            <Link
              className="button ghost full-width"
              to={`/vehicles/${vehicle.id}`}
            >
              Quay lại
            </Link>
          </Card>
        </aside>
      </form>
    </div>
  );
}

function PaymentEditor({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const client = useQueryClient();
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
    mutationFn: (values: PaymentFormValues) =>
      api.call("add_payment", { p_data: { ...values, sale_id: sale.id } }),
    onSuccess: async () => {
      await client.invalidateQueries();
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
          <input
            autoFocus
            type="number"
            inputMode="numeric"
            min="1"
            max={sale.remaining_amount}
            step="1"
            {...form.register("amount", { valueAsNumber: true })}
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
          <input type="date" {...form.register("payment_date")} />
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
      <div className="form-actions">
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

export function SaleDetailPage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const client = useQueryClient();
  const [showPayment, setShowPayment] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [reason, setReason] = useState("");
  const query = useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.call<SaleRecord>("get_sale", { p_id: id }),
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
        <ArrowLeft size={16} /> Bán hàng
      </Link>
      <PageHeader
        title={sale.sale_code}
        description={`Giao dịch ngày ${dateLabel(sale.sale_date)}`}
        actions={<Badge status={sale.status} />}
      />
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
