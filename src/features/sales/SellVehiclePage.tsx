import { useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useFormDraft } from "@/lib/useFormDraft";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Bike, ChevronDown, ChevronUp, Search, ShoppingBag } from "lucide-react";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { executeOperation } from "@/lib/operationRecovery";
import { OperationRecoveryNotice } from "@/components/OperationRecoveryNotice";
import { canFinance, canOperate } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { useAuth } from "@/features/auth/AuthProvider";
import {
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
import { Highlight } from "@/components/search/Highlight";
import type { Paged, Vehicle } from "@/types";
import { AVAILABLE_VEHICLE_FILTER } from "@/lib/vehicleFilters";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";
import { paymentLabels } from "@/features/vehicles/vehicleSchema";
import { saleSchema, type SaleFormValues } from "./saleSchema";

const pageSize = 6;

export function SellVehiclePage() {
  const navigate = useNavigate();
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
              placeholder="Tìm mã xe, biển số, số khung, loại xe…"
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
              <div key={item.id} className="compact-row sell-pick-row">
                <div className="vehicle-cell">
                  <span className="vehicle-icon">
                    <Bike size={25} />
                  </span>
                  <div>
                    <strong title={vehicleTitle(item)}>
                      <Highlight text={vehicleTitle(item)} query={deferredSearch} />
                    </strong>
                    <small>
                      <Highlight text={vehicleSubtitle(item)} query={deferredSearch} /> ·{" "}
                      <Highlight text={item.internal_code} query={deferredSearch} />
                    </small>
                  </div>
                </div>
                <div className="row">
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
        <OperationRecoveryNotice<string>
          userId={profile?.id} operation="sell_vehicle" scope={id}
          onConfirmed={saleId => navigate(`/sales/${saleId}`)}
        />
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
  const location = useLocation();
  const client = useQueryClient();
  const draftKey = `sale:${vehicle.id}`;
  // Copilot draft handoff: only these reviewed fields prefill; every value
  // stays editable and the save still goes through the confirmed sell RPC.
  const aiDraft = (location.state as { aiDraft?: Record<string, unknown> } | null)
    ?.aiDraft;
  // Bán hàng là nghiệp vụ duy nhất sinh giá: ô giá mở form để trống, không lấy
  // từ hồ sơ xe, không lấy từ bản nháp AI — nhân viên tự nhập giá thật tại quầy.
  const emptyPrice = Number.NaN;

  const form = useForm<SaleFormValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: {
      customer_name:
        typeof aiDraft?.customer_name === "string"
          ? aiDraft.customer_name.slice(0, 120)
          : "",
      customer_phone:
        typeof aiDraft?.customer_phone === "string"
          ? aiDraft.customer_phone.slice(0, 15)
          : "",
      sale_price: emptyPrice,
      sale_date: today(),
      due_date: "",
      initial_payment: emptyPrice,
      payment_method: "CASH",
      notes: "",
    },
  });

  const draftState = useFormDraft(draftKey, profile?.id, form);
  const draft = draftState.draft;
  const price = form.watch("sale_price");
  const paid = form.watch("initial_payment");
  // Blank money is modelled as NaN; a MoneyInput must render it as an empty
  // box (undefined), never leak the literal "NaN" when it mounts mid-session.
  const priceInput = Number.isFinite(price) ? price : undefined;
  const paidInput = Number.isFinite(paid) ? paid : undefined;
  const paymentValid = Number.isFinite(price) && Number.isFinite(paid) && paid <= price;
  const remaining = paymentValid ? price - paid : undefined;
  const priceField = form.register("sale_price");
  const paidField = form.register("initial_payment");
  const [showPaymentDetails, setShowPaymentDetails] = useState(false);
  const reviewPending = useRef(false);
  const [reviewing, setReviewing] = useState(false);

  const mutation = useMutation({
    mutationFn: (values: SaleFormValues) => {
      if (!profile) throw new AppError("Vui lòng đăng nhập lại trước khi bán xe.");
      return executeOperation<string>(profile.id, "sell_vehicle", vehicle.id, requestId =>
        api.call<string>("sell_vehicle", {
          p_data: { ...values, vehicle_id: vehicle.id, request_id: requestId },
        }),
      );
    },
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

  // Tự mở phần chi tiết khi có lỗi ở các field bị ẩn để nhân viên nhìn thấy ngay.
  useEffect(() => {
    if (form.formState.errors.initial_payment || form.formState.errors.due_date) {
      setShowPaymentDetails(true);
    }
  }, [form.formState.errors.initial_payment, form.formState.errors.due_date]);

  const reviewSale = async (values: SaleFormValues) => {
    if (reviewPending.current || mutation.isPending) return;
    reviewPending.current = true;
    setReviewing(true);
    // Review and send the same validated values, even if form state later changes.
    const snapshot = Object.freeze({ ...values });
    try {
      const confirmed = await confirmAction({
        title: "Kiểm tra giao dịch bán xe",
        description: "Đối chiếu khách hàng và số tiền thực tế trước khi ghi nhận.",
        confirmLabel: "Xác nhận bán xe",
        cancelLabel: "Quay lại chỉnh sửa",
        summary: (
          <div className="sale-review-stack">
            {/* Ưu tiên thị giác: Xe – Biển số – Số khung – rồi Giá bán hero,
                sau đó mới tới các dòng hỗ trợ (khách hàng, ngày, hình thức,
                trả trước, còn phải thu, hạn). Biển số dùng tile đồng bộ với
                chi tiết xe để nhận diện nhanh ngay tại quầy. */}
            {vehicleSubtitle(vehicle) && (
              <p className="sale-review-vehicle">
                {vehicleSubtitle(vehicle)}
                {vehicle.internal_code && (
                  <span className="muted"> · Mã {vehicle.internal_code}</span>
                )}
              </p>
            )}
            <div className="vehicle-id-strip">
              <div className="vehicle-id-tile vehicle-id-plate">
                <span className="vehicle-id-label">Biển số</span>
                <span className="vehicle-id-value">
                  {vehicle.license_plate || "Chưa có biển"}
                </span>
              </div>
              <div className="vehicle-id-tile vehicle-id-frame">
                <span className="vehicle-id-label">Số khung</span>
                <span className="vehicle-id-value">
                  {vehicle.frame_number || "Chưa có"}
                </span>
              </div>
            </div>
            <div className="sale-review-price-hero">
              <span className="sale-review-price-label">Giá bán</span>
              <span className="sale-review-price-value">
                {money(snapshot.sale_price)}
              </span>
            </div>
            <dl className="summary-list sale-review-summary">
              <div><dt>Khách hàng</dt><dd>{snapshot.customer_name}</dd></div>
              <div><dt>Số điện thoại</dt><dd>{snapshot.customer_phone || "Chưa cung cấp"}</dd></div>
              <div><dt>Ngày bán</dt><dd>{dateLabel(snapshot.sale_date)}</dd></div>
              <div><dt>Hình thức thu</dt><dd>{paymentLabels[snapshot.payment_method]}</dd></div>
              <div><dt>Khách đã trả trước</dt><dd>{money(snapshot.initial_payment)}</dd></div>
              <div className="summary-total"><dt>Còn phải thu</dt><dd>{money(snapshot.sale_price - snapshot.initial_payment)}</dd></div>
              <div><dt>Hạn thanh toán</dt><dd>{snapshot.due_date ? dateLabel(snapshot.due_date) : "Chưa hẹn ngày"}</dd></div>
              {snapshot.notes && <div><dt>Ghi chú</dt><dd>{snapshot.notes}</dd></div>}
            </dl>
          </div>
        ),
      });
      if (confirmed) mutation.mutate(snapshot);
    } finally {
      reviewPending.current = false;
      setReviewing(false);
    }
  };

  return (
    <div className="stack">
      <Link className="back-link" to={`/vehicles/${vehicle.id}`}>
        <ArrowLeft size={16} /> Chi tiết xe
      </Link>
      <PageHeader
        title="Bán xe"
        description="Hoàn tất thông tin khách hàng, giá bán và thanh toán trong một bước."
      />
      {aiDraft && (
        <p className="notice">
          Bản nháp từ câu lệnh của Cà Rem: kiểm tra lại khách hàng, số điện thoại
          và giá bán trước khi lưu.
        </p>
      )}
      <OperationRecoveryNotice<string>
        userId={profile?.id} operation="sell_vehicle" scope={vehicle.id}
        onConfirmed={async saleId => {
          draftState.complete();
          await client.invalidateQueries();
          navigate(`/sales/${saleId}`);
        }}
      />
      {draft && (
        <div className="notice draft-notice">
          <span>
            Có bản nháp giao dịch chưa hoàn tất cho xe này. Nhấn tiếp tục để
            khôi phục đầy đủ thông tin khách hàng, giá bán, thanh toán và ghi
            chú.
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
        onSubmit={form.handleSubmit(reviewSale)}
        className="detail-grid sale-form"
        aria-busy={mutation.isPending || reviewing}
      >
        <div className="stack sale-editor-fields">
          <Card>
            <h2 className="section-title">Khách hàng</h2>
            <div className="form-grid">
              <Field label="Tên khách hàng *" error={error("customer_name")}>
                <input
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
            {/* Hàng luôn hiển thị: giá bán và ngày bán */}
            <div className="form-grid">
              <Field label="Bán với giá" error={error("sale_price")}>
                <MoneyInput
                  aria-label="Bán với giá"
                  name={priceField.name}
                  ref={priceField.ref}
                  value={priceInput}
                  min={0}
                  required
                  onBlur={() => void form.trigger("sale_price")}
                  onChange={(value) => {
                    form.setValue("sale_price", value ?? Number.NaN, {
                      shouldValidate: true,
                      shouldDirty: true,
                    });
                    // Giữ "trả trước" đúng bằng giá cho tới khi nhân viên tự sửa.
                    if (!form.formState.dirtyFields.initial_payment) {
                      form.setValue(
                        "initial_payment",
                        value ?? Number.NaN,
                        { shouldValidate: true },
                      );
                    }
                  }}
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
            </div>
            {/* Nút toggle thêm/ẩn chi tiết thanh toán */}
            <Button
              type="button"
              variant="ghost"
              className="sale-payment-details-toggle"
              onClick={() => setShowPaymentDetails((v) => !v)}
              aria-expanded={showPaymentDetails}
            >
              {showPaymentDetails ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              {showPaymentDetails ? "Ẩn chi tiết thanh toán" : "Thêm chi tiết thanh toán"}
            </Button>
            {/* Fields stay mounted so "đã trả trước" attaches at first paint
                like "Bán với giá" (a late-mounted controlled money input lets
                react-hook-form write the NaN blank-sentinel into the DOM as
                the literal "NaN"); the toggle only collapses its visibility. */}
            <div
              className="form-grid sale-payment-details"
              style={{ display: showPaymentDetails ? undefined : "none" }}
            >
                <Field
                  label="Khách đã trả trước (₫)"
                  error={error("initial_payment")}
                >
                  <MoneyInput
                    aria-label="Khách đã trả trước (₫)"
                    name={paidField.name}
                    ref={paidField.ref}
                    value={paidInput}
                    min={0}
                    onBlur={() => void form.trigger("initial_payment")}
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
                      <small className="muted">
                        Khách còn nợ {money(price - paid)}. Nên hẹn ngày thanh toán để quản lý công nợ.
                      </small>
                    )}
                </Field>
              </div>
            <dl className="summary-list sale-payment-summary" data-state={paymentValid ? "valid" : "invalid"} aria-label="Tóm tắt thanh toán">
              <div><dt>Giá bán</dt><dd>{Number.isFinite(price) ? money(price) : "Chưa hợp lệ"}</dd></div>
              <div><dt>Đã trả trước</dt><dd>{Number.isFinite(paid) ? money(paid) : "Chưa hợp lệ"}</dd></div>
              <div className="summary-total"><dt>Còn phải thu</dt><dd>{paymentValid ? money(remaining) : "Kiểm tra số tiền"}</dd></div>
            </dl>
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
            {/* Không lặp lại danh tính xe ở đây – đã có breadcrumb + dialog
                kiểm tra hiển thị biển số / số khung nổi bật khi cần đối chiếu. */}
            <dl className="summary-list">
              {canFinance(profile) && (
                <div>
                  <dt>Giá vốn hiện tại</dt>
                  <dd>{money(vehicle.total_cost)}</dd>
                </div>
              )}
              <div className="summary-total">
                <dt>Còn phải thu</dt>
                <dd>
                  {paymentValid ? money(remaining) : "Kiểm tra số tiền"}
                </dd>
              </div>
            </dl>
            <div className="sale-action-footer">
              <Button
                type="submit"
                className="full-width"
                disabled={mutation.isPending || reviewing}
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
