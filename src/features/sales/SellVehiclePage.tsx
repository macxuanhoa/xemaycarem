import { useState } from "react";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useFormDraft } from "@/lib/useFormDraft";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { Link, useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Bike, Search, ShoppingBag } from "lucide-react";
import { api } from "@/lib/api";
import { canFinance, canOperate } from "@/lib/permissions";
import { money, today } from "@/lib/format";
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
  Pagination,
} from "@/components/ui";
import type { Paged, Vehicle } from "@/types";
import { AVAILABLE_VEHICLE_FILTER } from "@/lib/vehicleFilters";
import { paymentLabels } from "@/features/vehicles/vehicleSchema";
import { saleSchema, type SaleFormValues } from "./saleSchema";

const pageSize = 6;

export function SellVehiclePage() {
  const { id } = useParams();
  const { profile } = useAuth();
  const [search, setSearch] = useState("");
  const deferredSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1);

  const vehicle = useQuery({
    queryKey: ["vehicle", id],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: id }),
    enabled: !!id,
  });

  const inventory = useQuery({
    queryKey: ["sell-vehicle-picker", deferredSearch, page],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: {
          search: deferredSearch,
          status: AVAILABLE_VEHICLE_FILTER,
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
        {inventory.data?.items.some((item) => item.cost_pending) && (
          <p className="notice">
            <strong>Lưu ý:</strong> Một số xe chưa có giá nhập và không thể bán.
            Liên hệ người có quyền tài chính để cập nhật giá nhập.
          </p>
        )}
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
          <Card className="table-card">
            {inventory.isFetching && !inventory.isPending && (
              <div className="table-updating-bar" role="progressbar" aria-label="Đang cập nhật danh sách" />
            )}
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
                  {item.cost_pending ? (
                    <button
                      type="button"
                      className="button secondary"
                      disabled
                      title="Xe này chưa có giá nhập, không thể bán"
                    >
                      Chờ giá nhập
                    </button>
                  ) : (
                    <Link
                      className="button secondary"
                      to={`/vehicles/${item.id}/sell`}
                    >
                      Chọn xe
                      <ArrowRight size={16} />
                    </Link>
                  )}
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
  const draftKey = `sale:${vehicle.id}`;

  const form = useForm<SaleFormValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: {
      customer_name: "",
      customer_phone: "",
      sale_price: vehicle.asking_price,
      sale_date: today(),
      due_date: "",
      initial_payment: 0,
      payment_method: "CASH",
      notes: "",
    },
  });

  const draftState = useFormDraft(draftKey, profile?.id, form);
  const draft = draftState.draft;
  const price = form.watch("sale_price");
  const paid = form.watch("initial_payment");

  const mutation = useMutation({
    mutationFn: (values: SaleFormValues) =>
      api.call<string>("sell_vehicle", {
        p_data: { ...values, vehicle_id: vehicle.id },
      }),
    onSuccess: async (saleId) => {
      draftState.complete();
      // The sale is already committed. Messaging runs in the background and can never fail the sale UX.
      void api.call<{ id?: string; status?: string }>("get_sale_communication", { p_sale_id: saleId })
        .then((job) => job.id && job.status === "QUEUED" ? api.processMessage(job.id) : undefined)
        .catch(() => undefined);
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
      {draft && (
        <div className="notice draft-notice">
          <span>
            Có bản nháp khách hàng cho xe này. Giá và thanh toán cần kiểm tra
            lại.
          </span>
          <Button variant="secondary" onClick={draftState.resume}>
            Tiếp tục bản nháp
          </Button>
          <Button variant="ghost" onClick={draftState.discard}>
            Bỏ bản nháp
          </Button>
        </div>
      )}
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
                <MoneyInput
                  aria-label="Giá bán thực tế (₫) *"
                  value={price}
                  onChange={(value) =>
                    form.setValue("sale_price", value ?? Number.NaN, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                />
              </Field>
              <Field label="Ngày bán *" error={error("sale_date")}>
                <DatePicker
                  aria-label="Ngày bán *"
                  value={form.watch("sale_date")}
                  onChange={(val) =>
                    form.setValue("sale_date", val, {
                      shouldDirty: true,
                      shouldValidate: !!error("sale_date"),
                    })
                  }
                  onBlur={() => void form.trigger("sale_date")}
                  max={today()}
                  required
                />
              </Field>
              <Field
                label="Thu tiền lần đầu (₫)"
                error={error("initial_payment")}
              >
                <MoneyInput
                  aria-label="Thu tiền lần đầu (₫)"
                  value={paid}
                  onChange={(value) =>
                    form.setValue("initial_payment", value ?? Number.NaN, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
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
              <Field
                label="Hạn thanh toán (nếu còn nợ)"
                error={error("due_date")}
              >
                <DatePicker
                  aria-label="Hạn thanh toán (nếu còn nợ)"
                  value={form.watch("due_date")}
                  min={form.watch("sale_date")}
                  onChange={(val) =>
                    form.setValue("due_date", val, {
                      shouldDirty: true,
                      shouldValidate: !!error("due_date"),
                    })
                  }
                  onBlur={() => void form.trigger("due_date")}
                />
                {Number.isFinite(price) &&
                  Number.isFinite(paid) &&
                  price > paid &&
                  !form.watch("due_date") && (
                    <small
                      className="muted"
                      style={{ display: "block", marginTop: "4px" }}
                    >
                      Khách còn nợ {money(price - paid)}. Nên hẹn ngày thanh toán để quản lý công nợ.
                    </small>
                  )}
              </Field>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                form.setValue(
                  "initial_payment",
                  Number.isFinite(price) ? price : 0,
                  { shouldValidate: true, shouldDirty: true },
                );
                form.setValue("due_date", "", { shouldDirty: true });
              }}
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
          {canFinance(profile) &&
            Number.isFinite(price) &&
            vehicle.total_cost != null &&
            price < vehicle.total_cost && (
              <p className="notice">
                Giá bán thấp hơn giá vốn {money(vehicle.total_cost - price)}.
                Kiểm tra trước khi xác nhận bán xe.
              </p>
            )}
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
            <div className="form-footer-actions">
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
            </div>
          </Card>
        </aside>
      </form>
    </div>
  );
}
