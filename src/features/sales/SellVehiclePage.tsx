import { useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useFormDraft } from "@/lib/useFormDraft";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, ArrowLeft, ArrowRight, Bike, ChevronDown, ChevronUp, Clock, QrCode, Search, Send, ShoppingBag } from "lucide-react";
import { VietQrPaymentModal } from "./VietQrPaymentModal";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { celebrateSale } from "@/lib/celebrate";
import { executeOperation } from "@/lib/operationRecovery";
import { OperationRecoveryNotice } from "@/components/OperationRecoveryNotice";
import { canFinance, canOperate, isOwner } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { displayFrame } from "@/lib/frameNumber";
import { toast } from "@/lib/toast";
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
            <strong>Lưu ý:</strong> Một số xe chưa có giá thu và không thể bán.
            Mở hồ sơ xe và bổ sung giá thu trước khi tạo giao dịch.
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
                    {vehicleSubtitle(item) && (
                      <small>
                        <Highlight text={vehicleSubtitle(item)} query={deferredSearch} />
                      </small>
                    )}
                  </div>
                </div>
                <div className="row">
                  {item.pending_sale_approval && (
                    <span className="badge badge-reserved">
                      <span /> Chờ chủ duyệt bán
                    </span>
                  )}
                  {item.cost_pending ? (
                    <button
                      type="button"
                      className="button secondary"
                      disabled
                      title="Xe này chưa có giá thu, không thể bán"
                    >
                      Chờ giá thu
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
          onConfirmed={saleId => {
            celebrateSale();
            navigate(`/sales/${saleId}`);
          }}
        />
        <EmptyState
          title="Xe chưa sẵn sàng để bán"
          description="Xe phải đang tồn kho hoặc được giữ chỗ, có giá thu và chưa được bán."
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
  const [showVietQrModal, setShowVietQrModal] = useState(false);
  // Nhân viên chỉ "nói" số tiền khách trả trước khi tự sửa ô trả trước. Cho tới
  // lúc đó, bán xe mặc định là KHÁCH ĐÃ TRẢ ĐỦ — xem effect đồng bộ bên dưới.
  const [paymentEdited, setPaymentEdited] = useState(false);
  const handleOpenVietQr = () => {
    const targetAmount = Number.isFinite(paid) && paid > 0 ? paid : (Number.isFinite(price) ? price : 0);
    if (!targetAmount || targetAmount <= 0) {
      toast.warning("Vui lòng nhập giá bán hoặc số tiền khách trả trước để tạo mã VietQR.");
      return;
    }
    setShowVietQrModal(true);
  };
  const reviewPending = useRef(false);
  const [reviewing, setReviewing] = useState(false);
  // Giá thu là con số người thao tác xe được thấy và được nhập. Bán dưới giá thu
  // là quyết định của chủ cửa hàng: OWNER chốt ngay, STAFF/MANAGER gửi đơn chờ
  // duyệt — server cũng giữ đúng quy tắc này, không chỉ giao diện.
  const owner = isOwner(profile);
  const purchaseCost = vehicle.purchase_price ?? null;
  // Giá thu bị ẩn với role hiện tại (chủ nhập / dữ liệu cũ): nhân viên không được
  // suy ra mức lời/lỗ, nên MỌI giao dịch bán đều phải chủ xác nhận — server giữ chốt.
  const costHidden = !!vehicle.purchase_price_hidden;
  const belowCost = (value: number) =>
    purchaseCost != null && Number.isFinite(value) && value < purchaseCost;
  const isBelowCost = belowCost(price);
  const shortfall = isBelowCost ? purchaseCost! - price : 0;
  const needsApproval = !owner && (isBelowCost || costHidden);
  const awaitingApproval = !!vehicle.pending_sale_approval;

  type Submission = { kind: "sale" | "approval"; id: string };

  const mutation = useMutation({
    mutationFn: (values: SaleFormValues): Promise<Submission> => {
      if (!profile) throw new AppError("Vui lòng đăng nhập lại trước khi bán xe.");
      if (!owner && (belowCost(values.sale_price) || vehicle.purchase_price_hidden)) {
        // Dưới giá thu, hoặc giá thu bị ẩn (chủ nhập/dữ liệu cũ): KHÔNG ghi giao
        // dịch. Đề xuất đi vào hàng đợi "Chờ duyệt" của OWNER; xe vẫn trong kho và
        // chưa có doanh thu. Server chặn lại nếu thực chất cần chủ xác nhận.
        return executeOperation<string>(
          profile.id,
          "request_sale_below_cost",
          vehicle.id,
          (requestId) =>
            api.requestSaleBelowCost(
              { ...values, vehicle_id: vehicle.id },
              requestId,
            ),
        ).then((approvalId): Submission => ({ kind: "approval", id: approvalId }));
      }
      return executeOperation<string>(profile.id, "sell_vehicle", vehicle.id, requestId =>
        api.call<string>("sell_vehicle", {
          p_data: { ...values, vehicle_id: vehicle.id, request_id: requestId },
        }),
      ).then((saleId): Submission => ({ kind: "sale", id: saleId }));
    },
    onSuccess: async (result) => {
      draftState.complete();
      if (result.kind === "approval") {
        await client.invalidateQueries();
        toast.success("Đã gửi yêu cầu duyệt lên chủ cửa hàng.", {
          description:
            "Xe vẫn nằm trong kho, chưa ghi nhận doanh thu. Giao dịch bán hoàn tất khi chủ duyệt.",
        });
        navigate(`/vehicles/${vehicle.id}`);
        return;
      }
      // The sale is already committed. Messaging runs in the background and can never fail the sale UX.
      void api.call<{ id?: string; status?: string }>("get_sale_communication", { p_sale_id: result.id })
        .then((job) => job.id && job.status === "QUEUED" ? api.processMessage(job.id) : undefined)
        .catch(() => undefined);
      await client.invalidateQueries();
      // Giao dịch đã chốt – chúc mừng một burst pháo hoa trước khi sang phiếu bán.
      celebrateSale({ detail: vehicleTitle(vehicle) });
      navigate(`/sales/${result.id}`);
    },
    onError: async (error, values) => {
      // Server là nơi chốt quyền. Nếu từ chối vì cần xác nhận của chủ (giá thu riêng
      // tư của OWNER/dữ liệu cũ, hoặc bán dưới giá), tự động chuyển sang hàng đợi duyệt
      // mà không để lộ con số giá thu.
      const msg = String((error as { message?: string })?.message ?? error);
      const needsOwner =
        !owner &&
        !!profile &&
        (msg.includes("SALE_OWNER_CONFIRMATION_REQUIRED") ||
          msg.includes("SALE_BELOW_COST_APPROVAL_REQUIRED"));
      if (needsOwner) {
        try {
          await executeOperation<string>(
            profile!.id,
            "request_sale_below_cost",
            vehicle.id,
            (requestId) =>
              api.requestSaleBelowCost(
                { ...values, vehicle_id: vehicle.id },
                requestId,
              ),
          );
          draftState.complete();
          await client.invalidateQueries();
          toast.success("Cần chủ cửa hàng xác nhận giá bán.", {
            description:
              "Đã gửi yêu cầu duyệt. Xe vẫn nằm trong kho, chưa ghi nhận doanh thu cho tới khi chủ duyệt.",
          });
          navigate(`/vehicles/${vehicle.id}`);
        } catch (submitError) {
          toast.error("Không gửi được yêu cầu duyệt.", {
            description: String(
              (submitError as { message?: string })?.message ?? submitError,
            ),
          });
        }
        return;
      }
      // Other failures already surface inline via the form's error state; do not
      // raise a competing toast (keeps offline/network messages single-sourced).
    },
  });

  // Số liệu đổi (giá bán, khách, chi phí) thì phải rút đơn cũ rồi gửi lại, vì
  // chủ duyệt đúng bản đề xuất đã đóng dấu lúc gửi.
  const withdrawal = useMutation({
    mutationFn: () => {
      if (!vehicle.sale_approval_id)
        throw new AppError("Không xác định được yêu cầu đang chờ để rút.");
      return api.cancelSaleApproval(vehicle.sale_approval_id);
    },
    onSuccess: async () => {
      await client.invalidateQueries();
      toast.success("Đã rút yêu cầu duyệt.", {
        description: "Chỉnh lại số liệu rồi bấm Gửi yêu cầu duyệt lần nữa.",
      });
    },
    onError: (error) =>
      toast.error("Không rút được yêu cầu.", {
        description: String((error as Error).message ?? error),
      }),
  });

  async function withdrawRequest() {
    const ok = await confirmAction({
      title: "Rút yêu cầu duyệt bán?",
      description:
        "Yêu cầu đang chờ được đánh dấu đã rút. Xe vẫn còn trong kho và bạn gửi lại bản đề xuất mới sau khi sửa số liệu.",
      confirmLabel: "Rút yêu cầu",
      cancelLabel: "Giữ lại",
      tone: "danger",
    });
    if (ok) withdrawal.mutate();
  }

  const error = (key: keyof SaleFormValues) =>
    form.formState.errors[key]?.message;

  // Tự mở phần chi tiết khi có lỗi ở các field bị ẩn để nhân viên nhìn thấy ngay.
  useEffect(() => {
    if (form.formState.errors.initial_payment || form.formState.errors.due_date) {
      setShowPaymentDetails(true);
    }
  }, [form.formState.errors.initial_payment, form.formState.errors.due_date]);

  // Bán xe mặc định là KHÁCH ĐÃ TRẢ ĐỦ. Cho tới khi nhân viên tự sửa ô "trả
  // trước" (kể cả nhập 0đ khi khách chưa trả), số tiền trả trước luôn bám đúng
  // giá bán nên "còn phải thu" = 0 — không có cảnh khách bị tính nợ chỉ vì mới
  // nhập giá. Đồng bộ theo giá (không phụ thuộc dirtyFields của form) để không
  // bao giờ bỏ lại một giá trị lẻ khiến khách hoá ra còn nợ cả.
  useEffect(() => {
    if (paymentEdited) return;
    form.setValue(
      "initial_payment",
      Number.isFinite(price) ? price : Number.NaN,
      // A blank first paint is not a user error. Validating its NaN sentinel
      // would immediately open the otherwise-collapsed payment details.
      { shouldValidate: Number.isFinite(price) },
    );
  }, [price, paymentEdited, form]);

  const reviewSale = async (values: SaleFormValues) => {
    if (reviewPending.current || mutation.isPending) return;
    reviewPending.current = true;
    setReviewing(true);
    // Review and send the same validated values, even if form state later changes.
    const snapshot = Object.freeze({ ...values });
    try {
      const confirmed = await confirmAction({
        title: needsApproval
          ? costHidden
            ? "Gửi yêu cầu bán — cần chủ duyệt"
            : "Gửi yêu cầu bán dưới giá thu"
          : "Kiểm tra giao dịch bán xe",
        description: needsApproval
          ? "Chủ cửa hàng sẽ nhận yêu cầu ở mục Chờ duyệt. Xe chưa bị bán và chưa ghi nhận doanh thu."
          : "Đối chiếu khách hàng và số tiền thực tế trước khi ghi nhận.",
        confirmLabel: needsApproval ? "Gửi yêu cầu duyệt" : "Xác nhận bán xe",
        cancelLabel: "Quay lại chỉnh sửa",
        summary: (
          <div className="sale-review-stack">
            {/* 1. Ưu tiên to tên xe ra */}
            <div className="sale-confirm-vehicle-header">
              <h3 className="sale-confirm-vehicle-title">
                {vehicle.vehicle_type || "Xe chưa phân loại"}
              </h3>
              {(vehicle.year || vehicle.color) && (
                <div className="sale-confirm-vehicle-tags">
                  {vehicle.year && (
                    <span className="sale-confirm-tag">Đời {vehicle.year}</span>
                  )}
                  {vehicle.color && (
                    <span className="sale-confirm-tag">Màu {vehicle.color}</span>
                  )}
                </div>
              )}
            </div>

            {/* 2. Nổi bật Biển số và Số khung đồng bộ giao diện */}
            <div className="sale-confirm-id-grid">
              <div className="sale-confirm-id-card">
                <span className="sale-confirm-id-label">BIỂN SỐ XE</span>
                <div className={`vehicle-plate-badge${!vehicle.license_plate ? " is-empty" : ""}`}>
                  {vehicle.license_plate && (
                    <span className="vehicle-plate-screw vehicle-plate-screw-left" aria-hidden="true" />
                  )}
                  <span className="vehicle-plate-text">
                    {vehicle.license_plate || "Chưa có biển"}
                  </span>
                  {vehicle.license_plate && (
                    <span className="vehicle-plate-screw vehicle-plate-screw-right" aria-hidden="true" />
                  )}
                </div>
              </div>

              <div className="sale-confirm-id-card">
                <span className="sale-confirm-id-label">SỐ KHUNG (VIN)</span>
                <div className={`vehicle-frame-badge${!displayFrame(vehicle.frame_number) ? " is-empty" : ""}`}>
                  <span className="vehicle-frame-text">
                    {displayFrame(vehicle.frame_number) ? (
                      displayFrame(vehicle.frame_number).length > 6 ? (
                        <>
                          <span className="vehicle-frame-prefix">
                            {displayFrame(vehicle.frame_number).slice(0, -6)}
                          </span>
                          <strong className="vehicle-frame-highlight">
                            {displayFrame(vehicle.frame_number).slice(-6)}
                          </strong>
                        </>
                      ) : (
                        <strong className="vehicle-frame-highlight">
                          {displayFrame(vehicle.frame_number)}
                        </strong>
                      )
                    ) : (
                      "Chưa có số khung"
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* 3. Giá bán ở dưới nhưng to rõ ràng */}
            <div className="sale-confirm-price-banner">
              <div className="sale-confirm-price-left">
                <span className="sale-confirm-price-label">TỔNG GIÁ BÁN</span>
                <strong className="sale-confirm-price-amount">
                  {money(snapshot.sale_price)}
                </strong>
              </div>
              {snapshot.sale_price - snapshot.initial_payment > 0 ? (
                <div className="sale-confirm-debt-badge">
                  <span>Còn nợ lại:</span>
                  <strong>{money(snapshot.sale_price - snapshot.initial_payment)}</strong>
                </div>
              ) : (
                <div className="sale-confirm-paid-badge">
                  <span>✓ Đã thanh toán đủ</span>
                </div>
              )}
            </div>

            {/* 4. Chi tiết giao dịch: Mã xe đưa vào đây */}
            <dl className="summary-list sale-review-summary">
              {vehicle.internal_code && (
                <div>
                  <dt>Mã xe trong kho</dt>
                  <dd><code>{vehicle.internal_code}</code></dd>
                </div>
              )}
              {purchaseCost != null && (
                <div><dt>Giá thu vào</dt><dd>{money(purchaseCost)}</dd></div>
              )}
              <div><dt>Khách hàng</dt><dd><strong>{snapshot.customer_name || "Khách lẻ"}</strong></dd></div>
              <div><dt>Số điện thoại</dt><dd>{snapshot.customer_phone || "Chưa cung cấp"}</dd></div>
              <div><dt>Ngày bán</dt><dd>{dateLabel(snapshot.sale_date)}</dd></div>
              <div><dt>Hình thức thu</dt><dd>{paymentLabels[snapshot.payment_method]}</dd></div>
              <div><dt>Khách đã trả trước</dt><dd>{money(snapshot.initial_payment)}</dd></div>
              <div className="summary-total"><dt>Còn phải thu</dt><dd>{money(snapshot.sale_price - snapshot.initial_payment)}</dd></div>
              <div><dt>Hạn thanh toán</dt><dd>{snapshot.due_date ? dateLabel(snapshot.due_date) : "Chưa hẹn ngày"}</dd></div>
              {snapshot.notes && <div><dt>Ghi chú</dt><dd>{snapshot.notes}</dd></div>}
            </dl>
            {belowCost(snapshot.sale_price) && (
              <p className="notice warning">
                <AlertTriangle size={15} />
                <span>
                  Bán dưới giá thu, thiếu{" "}
                  <strong className="danger">
                    {money(purchaseCost! - snapshot.sale_price)}
                  </strong>
                  .{" "}
                  {owner
                    ? "Bạn là chủ cửa hàng nên giao dịch sẽ hoàn tất ngay."
                    : "Yêu cầu sẽ chờ chủ cửa hàng phê duyệt."}
                </span>
              </p>
            )}
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
          celebrateSale();
          navigate(`/sales/${saleId}`);
        }}
      />
      {!owner && (
        <OperationRecoveryNotice<string>
          userId={profile?.id} operation="request_sale_below_cost" scope={vehicle.id}
          onConfirmed={async () => {
            draftState.complete();
            await client.invalidateQueries();
            navigate(`/vehicles/${vehicle.id}`);
          }}
        />
      )}
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
              <Field label="Tên khách hàng" error={error("customer_name")}>
                <input
                  autoComplete="name"
                  {...form.register("customer_name")}
                  placeholder="Khách lẻ (tùy chọn)"
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
                    // "Trả trước" được đồng bộ về đúng giá bán (mặc định khách đã
                    // trả đủ) bởi effect ở trên — không xử lý ở đây để tránh
                    // trạng thái dirtyFields cũ khiến số tiền bị lệch.
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
            {/* Hàng luôn hiển thị: nút toggle chi tiết thanh toán + nút Tạo VietQR.
                Nút QR đặt ở ngoài khu gập để nhân viên tạo mã chuyển khoản
                ngay khi nhập giá, không phải mở "chi tiết thanh toán" trước. */}
            <div className="sale-payment-actions-row">
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
              <Button
                type="button"
                variant="secondary"
                className="sale-vietqr-button"
                onClick={handleOpenVietQr}
              >
                <QrCode size={15} /> Tạo VietQR
              </Button>
            </div>
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
                    onChange={(value) => {
                      // Nhân viên chạm tay vào ô trả trước (kể cả gõ 0 khi khách
                      // chưa trả) → không tự bám giá bán nữa, giữ đúng số họ nhập.
                      setPaymentEdited(true);
                      form.setValue("initial_payment", value ?? Number.NaN, {
                        shouldValidate: true,
                        shouldDirty: true,
                      });
                    }}
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
          {awaitingApproval && (
            <div className="notice warning">
              <Clock size={15} />
              <span>
                Xe này đang có yêu cầu bán dưới giá thu chờ chủ duyệt. Chưa bán
                được và cũng chưa gửi thêm yêu cầu khác cho tới khi chủ quyết
                định. Cần đổi giá bán hay thông tin khách thì rút yêu cầu rồi gửi
                lại bản mới.
              </span>
              <Button
                variant="secondary"
                disabled={withdrawal.isPending}
                onClick={() => void withdrawRequest()}
              >
                {withdrawal.isPending ? "Đang rút…" : "Rút yêu cầu"}
              </Button>
            </div>
          )}
          {mutation.isError && <ErrorState error={mutation.error} />}
          {isBelowCost && (
            <p className="notice warning">
              <AlertTriangle size={15} />
              <span>
                Giá bán thấp hơn giá thu vào. Chênh lệch{" "}
                <strong className="danger">{money(shortfall)}</strong>.{" "}
                {owner
                  ? "Bạn là chủ cửa hàng: xác nhận là giao dịch hoàn tất ngay, không cần gửi yêu cầu."
                  : "Nhân viên không tự chốt giao dịch dưới giá thu. Bấm «Gửi yêu cầu duyệt» để chuyển sang mục Chờ duyệt của chủ cửa hàng."}
              </span>
            </p>
          )}
          {canFinance(profile) &&
            Number.isFinite(price) &&
            vehicle.total_cost != null &&
            price < vehicle.total_cost && (
              <p className="notice">
                Giá bán thấp hơn giá vốn {money(vehicle.total_cost - price)} (đã
                gồm chi phí làm xe). Kiểm tra trước khi xác nhận bán xe.
              </p>
            )}
        </div>
        <aside className="stack">
          <Card>
            {/* Không lặp lại danh tính xe ở đây – đã có breadcrumb + dialog
                kiểm tra hiển thị biển số / số khung nổi bật khi cần đối chiếu. */}
            <dl className="summary-list">
              <div>
                <dt>Giá thu vào</dt>
                <dd>{purchaseCost != null ? money(purchaseCost) : "Chưa có"}</dd>
              </div>
              {canFinance(profile) && (
                <div>
                  <dt>Giá vốn hiện tại</dt>
                  <dd>{money(vehicle.total_cost)}</dd>
                </div>
              )}
              {isBelowCost && (
                <div>
                  <dt>Thấp hơn giá thu</dt>
                  <dd className="danger">−{money(shortfall)}</dd>
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
                disabled={mutation.isPending || reviewing || awaitingApproval}
                title={
                  awaitingApproval
                    ? "Đang có yêu cầu chờ chủ duyệt nên chưa bán được"
                    : undefined
                }
              >
                {needsApproval ? <Send size={17} /> : <ShoppingBag size={17} />}
                {mutation.isPending
                  ? needsApproval
                    ? "Đang gửi yêu cầu…"
                    : "Đang hoàn tất…"
                  : needsApproval
                    ? "Gửi yêu cầu duyệt"
                    : "Xác nhận bán xe"}
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
      {showVietQrModal && (
        <VietQrPaymentModal
          vehicle={vehicle}
          amount={Number.isFinite(paid) && paid > 0 ? paid : (Number.isFinite(price) ? price : 0)}
          onClose={() => setShowVietQrModal(false)}
          onPaymentConfirmed={() => {
            setShowVietQrModal(false);
            form.setValue("payment_method", "BANK_TRANSFER", { shouldDirty: true });
            const currentPaid = form.getValues("initial_payment");
            if (!Number.isFinite(currentPaid) || currentPaid <= 0) {
              const currentPrice = form.getValues("sale_price");
              if (Number.isFinite(currentPrice)) {
                form.setValue("initial_payment", currentPrice, { shouldDirty: true, shouldValidate: true });
              }
            }
          }}
        />
      )}
    </div>
  );
}
