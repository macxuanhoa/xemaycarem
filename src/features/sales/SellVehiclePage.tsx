import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useFormDraft } from "@/lib/useFormDraft";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, ArrowLeft, ArrowRight, Bike, CheckCircle2, ChevronDown, ChevronUp, Clock, QrCode, Search, Send, ShoppingBag } from "lucide-react";
import { VietQrPaymentModal } from "./VietQrPaymentModal";
import { useVietQrPaymentWatcher } from "./useVietQrPaymentWatcher";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { celebrateSale } from "@/lib/celebrate";
import { executeOperation } from "@/lib/operationRecovery";
import { OperationRecoveryNotice } from "@/components/OperationRecoveryNotice";
import { canFinance, canOperate, isOwner } from "@/lib/permissions";
import { dateLabel, money, today } from "@/lib/format";
import { displayFrame } from "@/lib/frameNumber";
import { CHAR_LIMITS } from "@/lib/validation";
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
import type { Paged, Vehicle, VietQrPaymentRequest } from "@/types";
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
  if (vehicle.isError && !vehicle.data)
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
  const [receivedQr, setReceivedQr] = useState<VietQrPaymentRequest | null>(null);
  // Nhân viên chỉ "nói" số tiền khách trả trước khi tự sửa ô trả trước. Cho tới
  // lúc đó, bán xe mặc định là KHÁCH ĐÃ TRẢ ĐỦ — xem effect đồng bộ bên dưới.
  const [paymentEdited, setPaymentEdited] = useState(false);
  // P1-c: một lối ghi nhận duy nhất cho tiền đã được ngân hàng xác minh, bất kể
  // nhân viên bấm xác nhận trong modal hay hệ thống phát hiện lúc đã tắt cửa sổ.
  // Hai đường khác nhau sẽ cho ra hai trạng thái biểu mẫu khác nhau — đúng chỗ
  // dễ sinh trùng doanh thu nhất.
  const applyVerifiedPayment = useCallback(
    (request: VietQrPaymentRequest) => {
      setReceivedQr(request);
      setPaymentEdited(true);
      form.setValue("payment_method", "BANK_TRANSFER", { shouldDirty: true });
      form.setValue("initial_payment", request.amount, {
        shouldDirty: true,
        shouldValidate: true,
      });
    },
    [form],
  );
  // Theo dõi tiền vào sống ĐỘC LẬP với cửa sổ QR: trước đây toàn bộ vòng kiểm tra
  // 5 giây nằm trong modal, nên tắt cửa sổ giữa chừng (mở app ngân hàng cho khách,
  // chuyển tab) là tiền về cũng không ai hay, đơn vẫn báo chưa thu. Giai đoạn bán
  // xe này chưa có đơn hàng nên chỉ tra theo xe.
  useVietQrPaymentWatcher({
    vehicleId: vehicle.id,
    enabled: !receivedQr,
    onVerified: applyVerifiedPayment,
  });
  const targetAmount = Number.isFinite(paid) && paid > 0 ? paid : (Number.isFinite(price) ? price : 0);
  const handleOpenVietQr = () => {
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
  const needsApproval = !owner && (isBelowCost || costHidden);
  const awaitingApproval = !!vehicle.pending_sale_approval;
  const qrRequiresApproval = needsApproval || awaitingApproval;
  // Ngân hàng đã xác nhận tiền vào (receivedQr) → biểu mẫu chỉ còn để KIỂM TRA và
  // XÁC NHẬN: khóa mọi ô để số tiền / người trả / hình thức không lệch chứng từ.
  const locked = !!receivedQr;
  // MỘT con số duy nhất cho mọi mức "bán dưới" (giá thu — ai thao tác được xe
  // cũng thấy; giá vốn — chỉ role tài chính): tổng đang lỗ. Nhân viên không
  // cần đọc giảng giải giá thu/giá vốn, chỉ cần biết bán hời hay lỗ bao nhiêu.
  const lossBaseline =
    purchaseCost == null && vehicle.total_cost == null
      ? null
      : Math.max(purchaseCost ?? 0, vehicle.total_cost ?? 0);
  const lossAmount =
    lossBaseline != null && Number.isFinite(price) && price < lossBaseline
      ? lossBaseline - price
      : 0;
  // Cảnh báo lỗ gọn ghẽ nằm NGAY DƯỚI Ô GIÁ BÁN trong cùng thẻ trắng — không
  // còn dải vàng chen giữa các thẻ khiến khung form bị cắt khúc.
  const lossAlert =
    lossAmount > 0 ? (
      <div className="sale-loss-alert" role="status">
        <AlertTriangle size={14} />
        <span>Bán dưới giá thu</span>
        <strong className="sale-loss-amount">−{money(lossAmount)}</strong>
        {!owner && (
          <span className="sale-loss-sub">· cần chủ duyệt để chốt</span>
        )}
      </div>
    ) : null;
  // Bản chữ một dòng cho hộp "Kiểm tra giao dịch bán xe": cùng số lỗ với form,
  // riêng role tài chính mới thêm mốc giá vốn nếu lỗ tính theo giá vốn sâu hơn.
  const belowPriceNotice = (salePrice: number, extraClass = "") => {
    const parts: { label: string; amount: number }[] = [];
    if (Number.isFinite(salePrice) && purchaseCost != null && salePrice < purchaseCost)
      parts.push({ label: "giá thu", amount: purchaseCost - salePrice });
    if (
      canFinance(profile) &&
      Number.isFinite(salePrice) &&
      vehicle.total_cost != null &&
      salePrice < vehicle.total_cost
    )
      parts.push({ label: "giá vốn", amount: vehicle.total_cost - salePrice });
    if (!parts.length) return null;
    return (
      <p className={`notice warning${extraClass ? ` ${extraClass}` : ""}`}>
        <AlertTriangle size={15} />
        <span>
          Bán dưới{" "}
          {parts
            .map((part) => `${part.label} — lỗ ${money(part.amount)}`)
            .join(" · ")}
          .
        </span>
      </p>
    );
  };

  type Submission = { kind: "sale" | "approval"; id: string };

  const mutation = useMutation({
    mutationFn: (values: SaleFormValues): Promise<Submission> => {
      if (!profile) throw new AppError("Vui lòng đăng nhập lại trước khi bán xe.");
      if (values.payment_method === "BANK_TRANSFER" && values.initial_payment > 0 && !receivedQr) {
        throw new AppError("Chưa có xác nhận tiền vào từ ngân hàng. Mở phần thanh toán chuyển khoản để kiểm tra trước khi ghi nhận khoản thu.");
      }
      if (receivedQr && !owner && (belowCost(values.sale_price) || vehicle.purchase_price_hidden)) {
        throw new AppError("Khoản chuyển đã nhận cần được đối soát với chủ cửa hàng trước khi thay đổi giao dịch sang chờ duyệt.");
      }
      if (receivedQr && (
        values.initial_payment !== receivedQr.amount ||
        values.payment_method !== "BANK_TRANSFER" ||
        values.customer_name.trim() !== receivedQr.payer_name
      )) {
        throw new AppError("Thông tin thanh toán khác với khoản tiền ngân hàng đã nhận. Kiểm tra lại tên người thanh toán, số tiền trả trước và hình thức chuyển khoản trước khi bán xe.");
      }
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
          p_data: { ...values, vehicle_id: vehicle.id, request_id: requestId,
            ...(receivedQr ? { vietqr_request_id: receivedQr.id } : {}),
          },
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
          important: true,
        });
        navigate(`/vehicles/${vehicle.id}`);
        return;
      }
      // The sale is already committed. Messaging runs in the background and can never fail the sale UX.
      void api.call<{ id?: string; status?: string }>("get_sale_communication", { p_sale_id: result.id })
        .then((job) => job.id && job.status === "QUEUED" ? api.processMessage(job.id) : undefined)
        .catch(() => undefined);
      // Chốt giao dịch: bật pháo hoa và rời trang bán NGAY, không chờ refetch
      // cache. Nếu await invalidate ở lại trang, xe đã SOLD sẽ bị màn "Xe
      // chưa sẵn sàng để bán" nhấp lên một nhịp trước hiệu ứng chúc mừng —
      // trông như giao dịch hỏng. Phiếu bán bên trang mới luôn tự fetch dữ
      // liệu mới nhất từ server nên cache chạy nền là đủ.
      celebrateSale({ detail: vehicleTitle(vehicle) });
      navigate(`/sales/${result.id}`, { replace: true });
      void client.invalidateQueries().catch(() => undefined);
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
            important: true,
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
    // Khi xác nhận bán xe trực tiếp thì hình thức thanh toán là tiền mặt (CASH),
    // còn nếu bấm vào thanh toán chuyển khoản và đã nhận tiền thì là chuyển khoản (BANK_TRANSFER).
    const finalPaymentMethod = receivedQr ? "BANK_TRANSFER" : "CASH";
    form.setValue("payment_method", finalPaymentMethod);
    reviewPending.current = true;
    setReviewing(true);
    // Review and send the same validated values, even if form state later changes.
    const snapshot = Object.freeze({ ...values, payment_method: finalPaymentMethod });
    // Khi tiền đã vào tài khoản (locked), hộp kiểm tra là bước XEM LẠI + XÁC NHẬN
    // bán xe, không còn là "gửi yêu cầu duyệt" — số liệu đã chốt theo chứng từ.
    const approvalMode = needsApproval && !locked;
    try {
      const confirmed = await confirmAction({
        title: approvalMode
          ? costHidden
            ? "Gửi yêu cầu bán — cần chủ duyệt"
            : "Gửi yêu cầu bán dưới giá thu"
          : "Kiểm tra giao dịch bán xe",
        description: approvalMode
          ? "Chủ cửa hàng sẽ nhận yêu cầu ở mục Chờ duyệt. Xe chưa bị bán và chưa ghi nhận doanh thu."
          : undefined,
        confirmLabel: approvalMode ? "Gửi yêu cầu duyệt" : "Xác nhận bán xe",
        cancelLabel: "Quay lại chỉnh sửa",
        summary: (
          <div className="sale-review-stack">
            {/* 1. Tên xe to rõ */}
            <div className="sale-confirm-vehicle-header">
              <h3 className="sale-confirm-vehicle-title">
                {(vehicle.vehicle_type && vehicle.vehicle_type !== "Chưa phân loại" && vehicle.vehicle_type !== "Xe chưa phân loại" ? vehicle.vehicle_type : "") ||
                  vehicle.license_plate ||
                  "Xe máy"}
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

            {/* 4. Tóm tắt nhanh khách hàng & thanh toán – siêu gọn gàng */}
            <div className="sale-confirm-meta-box">
              <div className="sale-confirm-meta-line">
                <span className="sale-confirm-meta-k">Khách mua:</span>
                <strong className="sale-confirm-meta-v">
                  {snapshot.customer_name || "Khách lẻ"}
                  {snapshot.customer_phone ? ` · ${snapshot.customer_phone}` : ""}
                </strong>
                {vehicle.internal_code && (
                  <span className="sale-confirm-meta-code-tag">
                    Mã <code>{vehicle.internal_code}</code>
                  </span>
                )}
              </div>
              <div className="sale-confirm-meta-line">
                <span className="sale-confirm-meta-k">Thu tiền:</span>
                <span className="sale-confirm-meta-v">
                  {paymentLabels[snapshot.payment_method]}
                  {snapshot.initial_payment < snapshot.sale_price && (
                    <> · Đã trả: <strong>{money(snapshot.initial_payment)}</strong></>
                  )}
                  {" · Ngày "}{dateLabel(snapshot.sale_date)}
                  {snapshot.due_date && snapshot.sale_price > snapshot.initial_payment && (
                    <span className="sale-confirm-meta-due"> · Hạn nợ: {dateLabel(snapshot.due_date)}</span>
                  )}
                </span>
              </div>
              {snapshot.notes && (
                <div className="sale-confirm-meta-notes">
                  <span className="sale-confirm-meta-k">Ghi chú:</span>
                  <span>{snapshot.notes}</span>
                </div>
              )}
            </div>

            {belowPriceNotice(
              snapshot.sale_price,
              "sale-confirm-below-cost",
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
      {locked && (
        <div className="notice success sale-transfer-lock" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          Ngân hàng đã nhận <strong>{money(receivedQr!.amount)}</strong>
          {receivedQr!.payer_name ? ` từ ${receivedQr!.payer_name}` : ""}. Biểu mẫu đã
          khóa để khớp chứng từ chuyển khoản — bạn chỉ còn kiểm tra và xác nhận bán xe.
        </div>
      )}
      {aiDraft && (
        <p className="notice">
          Bản nháp từ câu lệnh của Cà Rem: kiểm tra lại khách hàng, số điện thoại
          và giá bán trước khi lưu.
        </p>
      )}
      <OperationRecoveryNotice<string>
        userId={profile?.id} operation="sell_vehicle" scope={vehicle.id}
        onConfirmed={saleId => {
          draftState.complete();
          // Như onSuccess: chúc mừng và rời trang trước, cache refetch nền
          // sau — tránh màn "Xe chưa sẵn sàng để bán" loé lên khi xe vừa SOLD.
          celebrateSale();
          navigate(`/sales/${saleId}`, { replace: true });
          void client.invalidateQueries().catch(() => undefined);
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
              <Field
                label="Tên khách hàng"
                error={error("customer_name")}
                counter={{ value: form.watch("customer_name"), max: CHAR_LIMITS.name }}
              >
                <input
                  autoComplete="name"
                  maxLength={CHAR_LIMITS.name}
                  {...form.register("customer_name")}
                  disabled={locked}
                  placeholder="Khách lẻ (tùy chọn)"
                />
              </Field>
              <Field label="Số điện thoại" error={error("customer_phone")}>
                <input
                  type="tel"
                  autoComplete="tel"
                  maxLength={CHAR_LIMITS.phone}
                  {...form.register("customer_phone")}
                  disabled={locked}
                />
              </Field>
            </div>
          </Card>
          <Card>
            <h2 className="section-title">Giá bán & thanh toán</h2>
            {/* Hàng luôn hiển thị: giá bán và ngày bán. Cảnh báo lỗ bám ngay
                dưới ô giá, trong cùng thẻ — không đẩy ra ngoài thành dải rời. */}
            <div className="form-grid">
              <div className="sale-price-cell stack">
                <Field label="Bán với giá" error={error("sale_price")}>
                  <MoneyInput
                    aria-label="Bán với giá"
                    name={priceField.name}
                    ref={priceField.ref}
                    value={priceInput}
                    min={0}
                    required
                    disabled={locked}
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
                {lossAlert}
              </div>
              <Field label="Ngày bán *" error={error("sale_date")}>
                <DatePicker
                  aria-label="Ngày bán *"
                  value={form.watch("sale_date")}
                  disabled={locked}
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
            {/* Nút toggle mở rộng chi tiết thanh toán – độc lập, toàn chiều ngang, nét đứt nhã nhặn */}
            <Button
              type="button"
              variant="ghost"
              className="sale-payment-details-toggle"
              onClick={() => setShowPaymentDetails((v) => !v)}
              aria-expanded={showPaymentDetails || locked}
              disabled={locked}
            >
              {showPaymentDetails || locked ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              {showPaymentDetails || locked ? "Ẩn chi tiết thanh toán" : "Thêm chi tiết thanh toán (trả trước, hình thức, hạn nợ)"}
            </Button>

            {/* Fields stay mounted so "đã trả trước" attaches at first paint
                like "Bán với giá" (a late-mounted controlled money input lets
                react-hook-form write the NaN blank-sentinel into the DOM as
                the literal "NaN"); the toggle only collapses its visibility.
                Khi locked, chi tiết luôn mở để nhân viên đọc lại chứng từ. */}
            <div
              className="form-grid sale-payment-details"
              style={{ display: showPaymentDetails || locked ? undefined : "none" }}
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
                    disabled={locked}
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
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: "8px",
                      background: "var(--surface-sunken, #f8fafc)",
                      border: "1px solid var(--border-soft, #e2e8f0)",
                      fontWeight: 600,
                      fontSize: "14px",
                      color: receivedQr ? "var(--brand-emerald-dark, #047857)" : "var(--text-main, #0f172a)",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minHeight: "42px",
                    }}
                  >
                    {receivedQr ? (
                      <>
                        <CheckCircle2 size={16} /> Chuyển khoản (VietQR đã xác nhận)
                      </>
                    ) : (
                      "Tiền mặt (mặc định khi bán trực tiếp)"
                    )}
                  </div>
                </Field>
                <Field
                  label="Hạn thanh toán (nếu còn nợ)"
                  error={error("due_date")}
                >
                  <DatePicker
                    aria-label="Hạn thanh toán (nếu còn nợ)"
                    value={form.watch("due_date")}
                    min={form.watch("sale_date")}
                    disabled={locked}
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
            <Field
              label="Ghi chú"
              error={error("notes")}
              counter={{ value: form.watch("notes"), max: CHAR_LIMITS.notes }}
            >
              <textarea
                rows={3}
                maxLength={CHAR_LIMITS.notes}
                {...form.register("notes")}
                disabled={locked}
                placeholder="Điều kiện bàn giao, thỏa thuận với khách hàng…"
              />
            </Field>
          </Card>
          {awaitingApproval && (
            <div className="notice warning">
              <Clock size={15} />
              <span>
                Xe đang chờ chủ duyệt yêu cầu bán dưới giá thu — chưa bán được.
                Cần đổi số liệu thì rút yêu cầu rồi gửi lại.
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
              {/* Không lặp lại số lỗ trong tóm tắt — cảnh báo "Bán dưới giá thu"
                  đã đặt ngay dưới ô giá bán, một chỗ duy nhất, khó bỏ sót. */}
              <div className="summary-total">
                <dt>Còn phải thu</dt>
                <dd>
                  {paymentValid ? money(remaining) : "Kiểm tra số tiền"}
                </dd>
              </div>
            </dl>
          </Card>
        </aside>
        <Card className="sale-final-actions">
            <div className="sale-action-footer">
              {locked ? (
                <Button
                  type="submit"
                  className="full-width"
                  disabled={mutation.isPending || reviewing}
                >
                  <CheckCircle2 size={17} />
                  {mutation.isPending
                    ? "Đang hoàn tất…"
                    : "Kiểm tra & xác nhận bán xe"}
                </Button>
              ) : (
                <>
                  {/* Máy chủ chặn STAFF phát mã (can_financials chỉ OWNER/MANAGER), nên
                      nút cũng chỉ bày ra cho đúng nhóm đó — khỏi bấm rồi ăn lỗi quyền
                      ngay trước mặt khách. */}
                  {canFinance(profile) && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="full-width sale-aside-vietqr-btn"
                      onClick={handleOpenVietQr}
                      disabled={qrRequiresApproval}
                      title={qrRequiresApproval ? "Chờ chủ cửa hàng duyệt giao dịch trước khi thu tiền chuyển khoản." : undefined}
                    >
                      <QrCode size={15} /> Thanh toán chuyển khoản
                    </Button>
                  )}
                  {qrRequiresApproval && <p className="muted small">Chờ duyệt giao dịch trước khi tạo mã thu tiền.</p>}
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
                </>
              )}
              <Link
                className="button ghost full-width"
                to={`/vehicles/${vehicle.id}`}
              >
                Quay lại
              </Link>
            </div>
        </Card>
      </form>
      {showVietQrModal && (
        <VietQrPaymentModal
          vehicle={vehicle}
          amount={receivedQr?.amount ?? targetAmount}
          payerName={form.watch("customer_name").trim()}
          onClose={() => setShowVietQrModal(false)}
          onPaymentConfirmed={(confirmedRequest) => {
            applyVerifiedPayment(confirmedRequest);
            setShowVietQrModal(false);
          }}
        />
      )}
    </div>
  );
}
