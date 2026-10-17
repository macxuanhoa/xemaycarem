import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Banknote,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Download,
  FileText,
  Info,
  Landmark,
  RefreshCw,
  User,
  WifiOff,
  X,
} from "lucide-react";
import { Button, ErrorState, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { readSaveEnvironment } from "@/lib/imageSave";
import { money } from "@/lib/format";
import { useNetworkStatus } from "@/lib/networkStatus";
import { toast } from "@/lib/toast";
import { useDialog } from "@/lib/useDialog";
import { getBankByBin } from "@/lib/vietqr/banks";
import { isMoneyMonitorUnavailable, isVerifiedReceipt, moneyPollMs, vietqrActiveQueryKey } from "./vietqrVerification";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { VietQrPaymentSuccess } from "./VietQrPaymentSuccess";
import {
  buildVietQrEmvCoPayload,
  buildVietQrQuickLink,
  renderQrToDataUrl,
} from "@/lib/vietqr/emvco";
import { dataUrlToBlob, renderQrCardImage } from "@/lib/vietqr/qrCardImage";
import {
  composeTransferCopyLine,
  selectQrTransferContent,
  transferContentFromPayload,
  type TransferContentFallback,
} from "@/lib/vietqr/transferContent";
import {
  isAboveNapasSingleTransfer,
  napasOverLimitHint,
} from "@/lib/vietqr/limits";
import type { VietQrPaymentRequest } from "@/types";

type ShopSettings = {
  bank_bin?: string;
  bank_name?: string;
  bank_account_no?: string;
  bank_account_name?: string;
  vietqr_enabled?: boolean;
};
type VehicleSummary = {
  id: string;
  license_plate?: string | null;
  internal_code?: string;
  vehicle_title?: string;
  vehicle_subtitle?: string;
  vehicle_type?: string;
};
const formatCountdown = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;

/** Vòng đếm 15 phút theo chuẩn thẻ QR của Cà Rem. */
const QR_LIFETIME_SECONDS = 15 * 60;
/** Dưới mốc này vòng chuyển sang cam "sắp hết hạn" để nhắc nhân viên phát lệnh. */
const QR_URGENT_SECONDS = 60;
const splitCountdown = (seconds: number) => {
  const safe = Math.max(0, seconds);
  return {
    minutes: Math.floor(safe / 60)
      .toString()
      .padStart(2, "0"),
    seconds: (safe % 60).toString().padStart(2, "0"),
  };
};

/* Hình xuyến thời gian: cung đỏ rút dần theo tỉ lệ còn lại, tâm đặt đồng hồ.
   Chỉ vẽ SVG tĩnh + transition 1s trên nét vẽ, không có vòng lặp animation. */
const RING_SIZE = 54;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function CountdownRing({
  ratio,
  tone,
}: {
  ratio: number;
  tone: "active" | "urgent" | "expired";
}) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const angle = ((-90 + 360 * clamped) * Math.PI) / 180;
  return (
    <svg
      className={`vietqr-clock-arc-svg vietqr-clock-arc-svg--${tone}`}
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      <circle
        className="vietqr-clock-track"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        strokeWidth={RING_STROKE}
      />
      <circle
        className="vietqr-clock-arc"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        strokeWidth={RING_STROKE}
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped)}
      />
      {clamped > 0 ? (
        <circle
          className="vietqr-clock-head"
          cx={RING_SIZE / 2 + RING_RADIUS * Math.cos(angle)}
          cy={RING_SIZE / 2 + RING_RADIUS * Math.sin(angle)}
          r={2.6}
        />
      ) : null}
    </svg>
  );
}

/** Đọc message từ lỗi RPC (Supabase trả PostgrestError dạng object có `.message`, không phải Error). */
const errorText = (error: unknown) =>
  error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error ?? "");

function paymentQrPayload(
  request: VietQrPaymentRequest | null,
  fallbackSettings: ShopSettings | null | undefined,
  memo: TransferContentFallback,
): {
  payload: string | null;
  imageUrl: string | null;
  description: string;
  invalid: boolean;
} {
  if (!request) {
    return { payload: null, imageUrl: null, description: "", invalid: false };
  }

  // Mã đối soát và tên xe dùng chung cho ảnh VietQR, payload, màn hình và Copy.
  const reference = (request.qr_reference || "").trim();
  const description = selectQrTransferContent(request, memo);
  // Lấy thông tin tài khoản: ưu tiên request, dự phòng sang settings cửa hàng
  const bankBin = (request.bank_bin || fallbackSettings?.bank_bin || "").trim();
  const accountNo = (
    request.bank_account_no ||
    fallbackSettings?.bank_account_no ||
    ""
  ).trim();
  const accountName = (
    request.bank_account_name ||
    fallbackSettings?.bank_account_name ||
    ""
  ).trim();
  // Mã đã lưu có thể còn memo dài theo mẫu cũ. Chỉ tái dùng khi nội dung khớp
  // đúng chuỗi đã chọn; nếu khác, dựng lại QR với cùng mã đối soát và tên xe.
  const embeddedContent = transferContentFromPayload(request.qr_payload);
  const embedded = embeddedContent === description ? request.qr_payload : null;

  // Ảnh VietQR chính thống (img.vietqr.io) + payload EMVCo đều nhúng ĐÚNG chuỗi
  // đang hiển thị. Cắt hoặc bỏ dấu là lệch đối soát.
  // `qr_only`: chỉ lấy mỗi ô mã từ ảnh chính thống, vì số tiền, nội dung và dấu
  // "Cà Rem" đã được mình vẽ thẳng vào ảnh thẻ ghép bên dưới — để lại template
  // full thẻ sẽ thành hai bộ chữ trùng nhau trong cùng một tấm ảnh.
  const quickLink = (content: string) => {
    try {
      return buildVietQrQuickLink(
        {
          bankBin,
          accountNo,
          amount: request.amount,
          description: content,
          accountName,
        },
        "qr_only",
      );
    } catch {
      return null;
    }
  };
  const emvco = (content: string) => {
    try {
      return buildVietQrEmvCoPayload({
        bankBin,
        accountNo,
        amount: request.amount,
        description: content,
        accountName,
      });
    } catch {
      return null;
    }
  };

  // Thiếu thông tin tài khoản: không vẽ được mã nào, nhưng nhân viên vẫn cần
  // đúng nội dung chuyển khoản để chuyển tay — giữ nguyên chuỗi đã chốt.
  if (!bankBin || !accountNo) {
    return embedded
      ? { payload: embedded, imageUrl: null, description, invalid: false }
      : { payload: null, imageUrl: null, description, invalid: true };
  }

  if (embedded) {
    return {
      payload: embedded,
      imageUrl: quickLink(description),
      description,
      invalid: false,
    };
  }

  const payload = emvco(description);
  if (payload) {
    return {
      payload,
      imageUrl: quickLink(description),
      description,
      invalid: false,
    };
  }

  // Hiếm gặp: memo không nhúng vừa payload. Rút về đúng mã đối soát cho CẢ HAI
  // chiều (mã và chữ) rồi mới báo lỗi — thà hiển thị ngắn còn hơn sai lệch.
  if (reference && reference !== description) {
    const shortPayload = emvco(reference);
    if (shortPayload) {
      return {
        payload: shortPayload,
        imageUrl: quickLink(reference),
        description: reference,
        invalid: false,
      };
    }
  }
  return { payload: null, imageUrl: null, description, invalid: true };
}

export function VietQrPaymentModal({
  vehicle,
  saleId,
  saleCode,
  payerName,
  amount,
  onClose,
  onPaymentConfirmed,
  onManualConfirm,
}: {
  vehicle: VehicleSummary;
  saleId?: string;
  saleCode?: string;
  payerName?: string;
  amount: number;
  onClose: () => void;
  onPaymentConfirmed?: (request: VietQrPaymentRequest) => void;
  /**
   * Đường nghiệp vụ khi KHÔNG có báo tiền tự động (webhook chưa cấu hình đúng, hoặc
   * tài khoản nhận đã đổi khác mã đang hiện): mở form thu tiền thường của đơn để Chủ
   * đối chiếu sao kê rồi lập đề nghị ghi thu. Chỉ trang nào đã có đơn bán (sale_id)
   * mới truyền được — không có đơn thì không có form để mở.
   */
  onManualConfirm?: (request: VietQrPaymentRequest) => void;
}) {
  const network = useNetworkStatus();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useDialog(true, onClose);
  const initialized = useRef(false);
  const [selectedRequest, setSelectedRequest] =
    useState<VietQrPaymentRequest | null>(null);
  const [qrImage, setQrImage] = useState<{
    payload: string;
    url: string;
  } | null>(null);
  const [qrError, setQrError] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  // P1-e: ảnh QR đã nằm sẵn trong cache có thể hoàn tất TRƯỚC khi React kịp gắn
  // onError/onLoad. Khi đó khung mã hiển thị ảnh vỡ mà `imageFailed` vẫn false,
  // nên nhánh dự phòng vẽ QR tại máy không bao giờ chạy — nhân viên đứng nhìn ô
  // trắng trước mặt khách. Callback ref đọc thẳng `complete`/`naturalWidth` của
  // phần tử ngay lúc nó được gắn vào cây.
  const attachRemoteQr = useCallback((node: HTMLImageElement | null) => {
    if (!node) return;
    if (node.complete && node.naturalWidth === 0) setImageFailed(true);
  }, []);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [saveOverlayUrl, setSaveOverlayUrl] = useState<string | null>(null);

  // Đếm ngược 15 phút (900 giây) liên tục từng giây ngay từ khi mở modal
  const [expiryTimestamp, setExpiryTimestamp] = useState<number>(
    () => Date.now() + 15 * 60 * 1000,
  );
  const [nowTime, setNowTime] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTime(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Chống spam: chỉ cách 3 giây nếu bấm tạo mới 3 lần liên tục
  const [recentCreations, setRecentCreations] = useState<number[]>([]);
  const [spamCooldownSeconds, setSpamCooldownSeconds] = useState(0);

  useEffect(() => {
    if (spamCooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setSpamCooldownSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [spamCooldownSeconds]);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<ShopSettings>("get_settings"),
  });
  const settings = settingsQuery.data;
  const isConfigured = Boolean(settings?.bank_bin && settings?.bank_account_no);

  // Tên trong danh mục xe; biển số, số khung và mã kho không thuộc memo.
  const memoContext = useMemo(
    () => ({
      vehicleName: vehicle.vehicle_type?.trim() || "",
    }),
    [vehicle.vehicle_type],
  );

  // Load the existing request before creating one.
  const activeQuery = useQuery({
    queryKey: vietqrActiveQueryKey(vehicle.id, saleId),
    queryFn: () => api.getActiveVietQrRequest(vehicle.id, saleId),
    enabled: isConfigured,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });

  const selectRequest = (data: VietQrPaymentRequest) => {
    setSelectedRequest(data);
    // Cập nhật mốc hết hạn: nếu server có expires_at hợp lệ trong tương lai thì dùng, nếu không cấp 15 phút mới
    const parsedExpires = data.expires_at ? Date.parse(data.expires_at) : NaN;
    if (Number.isFinite(parsedExpires) && parsedExpires > Date.now()) {
      setExpiryTimestamp(parsedExpires);
    } else {
      setExpiryTimestamp(Date.now() + 15 * 60 * 1000);
    }
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.createVietQrPaymentRequest({
        vehicle_id: vehicle.id,
        sale_id: saleId,
        amount,
        payer_name: payerName?.trim() || "Khách mua xe",
        contract_reference: saleCode,
      }),
    onSuccess: selectRequest,
  });

  const replaceMutation = useMutation({
    mutationFn: async () => {
      const targetId = selectedRequest?.id || activeQuery.data?.id;
      const details = {
        amount,
        payer_name: payerName?.trim() || "Khách mua xe",
        contract_reference: saleCode,
      };
      if (targetId) {
        try {
          return await api.replaceVietQrPaymentRequest(targetId, details);
        } catch (error) {
          // Lỗi chờ đổi mã/giới hạn phải báo thật: bịa một "mã thành công"
          // chỉ tồn tại ở máy khách sẽ bị vòng lặp polling 5 giây ghi đè bằng
          // mã cũ trên server, khiến cảnh báo "biểu mẫu đã thay đổi" không
          // bao giờ biến mất dù đã bấm Tạo mã mới.
          const message = errorText(error);
          if (
            /VIETQR_REPLACEMENT_COOLDOWN|VIETQR_RATE_LIMITED|VIETQR_FUNDS_ALREADY_RECEIVED/i.test(
              message,
            )
          )
            throw error;
          // Mã cũ đã bị thay/hủy ở nơi khác thì lập mã mới theo đúng biểu mẫu.
        }
      }
      return api.createVietQrPaymentRequest({
        vehicle_id: vehicle.id,
        sale_id: saleId,
        ...details,
      });
    },
    onSuccess: (data) => {
      selectRequest(data);
      // Chỉ báo nhẹ: vòng đếm 15 phút đã hiển thị ngay trong modal nên
      // không lặp lại "có hiệu lực 15 phút" gây rườm rà.
      toast.success("Đã cập nhật mã QR");
    },
    onError: async (error) => {
      // Server đang có mã mới hơn màn hình này: theo đúng mã thật hiện hành.
      if (
        /VIETQR_REPLACE_REQUIRED|VIETQR_REPLACEMENT_CONFLICT|VIETQR_REQUEST_NOT_FOUND/i.test(
          errorText(error),
        )
      ) {
        const latest = await activeQuery.refetch();
        if (latest.data) selectRequest(latest.data);
        return;
      }
      // Đang chờ hết thời gian chống spam hoặc giới hạn tần suất: KHÔNG bật hộp
      // lỗi to. Vòng tự động cập nhật sẽ phát lại ngay khi hết chờ, chỉ giữ hint
      // nhỏ inline.
      if (
        /VIETQR_REPLACEMENT_COOLDOWN|VIETQR_RATE_LIMITED/i.test(
          errorText(error),
        )
      ) {
        return;
      }
      // Tự làm mới khi mở modal thất bại: vẫn hiển thị mã hiện có kèm lý do,
      // không để modal trắng.
      if (!selectedRequest && activeQuery.data) selectRequest(activeQuery.data);
    },
  });

  useEffect(() => {
    if (
      initialized.current ||
      !network.online ||
      !isConfigured ||
      !activeQuery.isFetchedAfterMount ||
      !activeQuery.isSuccess
    )
      return;
    initialized.current = true;
    if (activeQuery.data) {
      const serverNow = Date.parse(activeQuery.data.server_now);
      const expiresAt = Date.parse(activeQuery.data.expires_at);
      const isExpired =
        activeQuery.data.status === "EXPIRED" ||
        (Number.isFinite(expiresAt) &&
          Number.isFinite(serverNow) &&
          expiresAt <= serverNow);
      const detailsMatch =
        activeQuery.data.amount === amount &&
        (!payerName || activeQuery.data.payer_name === payerName.trim());
      const isQrValid = !paymentQrPayload(
        activeQuery.data,
        settings,
        memoContext,
      ).invalid;
      const isReceived =
        activeQuery.data.status === "RECEIVED" ||
        activeQuery.data.status === "CONFIRMED";

      if (isReceived) {
        selectRequest(activeQuery.data);
      } else if (
        !isExpired &&
        detailsMatch &&
        activeQuery.data.status === "PENDING" &&
        isQrValid
      ) {
        selectRequest(activeQuery.data);
      } else {
        // Tự động làm mới mã QR để luôn hiện mã QR 15 phút hợp lệ
        replaceMutation.mutate();
      }
    } else {
      createMutation.mutate();
    }
  }, [
    network.online,
    isConfigured,
    activeQuery.isFetchedAfterMount,
    activeQuery.isSuccess,
    activeQuery.data,
    amount,
    payerName,
    settings,
    memoContext,
    createMutation,
    replaceMutation,
  ]);

  const requestQuery = useQuery({
    queryKey: ["vietqr-request", selectedRequest?.id],
    queryFn: () => api.getVietQrPaymentRequest(selectedRequest!.id),
    enabled: !!selectedRequest && network.online,
    // Nhịp chậm khi server đã báo mã này không có đường tự xác minh tiền.
    refetchInterval: (state) => moneyPollMs(state.state.data ?? selectedRequest),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    staleTime: 0,
    retry: false,
  });
  const request =
    requestQuery.data?.id === selectedRequest?.id
      ? (requestQuery.data ?? selectedRequest)
      : selectedRequest;
  useEffect(() => {
    if (!requestQuery.data) return;
    const parsedExpires = requestQuery.data.expires_at
      ? Date.parse(requestQuery.data.expires_at)
      : NaN;
    if (Number.isFinite(parsedExpires) && parsedExpires > Date.now()) {
      setExpiryTimestamp(parsedExpires);
    }
  }, [requestQuery.data]);

  const verifiedReceipt = isVerifiedReceipt(request);
  const matchQuery = useQuery({
    queryKey: ["vietqr-match", request?.id],
    queryFn: () => api.getVietQrMatchingStatus(request!.id),
    enabled:
      !!request &&
      !verifiedReceipt &&
      request.status !== "CANCELLED" &&
      network.online,
    refetchInterval: (state) =>
      moneyPollMs(request, state.state.data?.monitoring_available),
    refetchIntervalInBackground: false,
    retry: false,
  });
  // Server trả monitoring_available = false ⇒ webhook không thể báo tiền về cho mã
  // này (chưa cấu hình đúng, hoặc tài khoản nhận đã đổi khác mã đang hiện). Vòng 5
  // giây vì thế hạ xuống nhịp chậm ở trên, và giao diện đổi hẳn sang chế độ "hỏi lại
  // Cà Rem" thay vì hứa "tự động kiểm tra" một điều sẽ không bao giờ xảy ra.
  const monitorUnavailable = isMoneyMonitorUnavailable(
    request,
    matchQuery.data?.monitoring_available,
  );
  // P1-c: thông báo "đã nhận tiền" KHÔNG còn nằm trong modal nữa. Modal bị mount
  // theo cờ showVietQr của trang, nên bất cứ lần tắt cửa sổ nào cũng cắt luôn cả
  // vòng xác minh. Việc báo nhận tiền dời lên useVietQrPaymentWatcher ở cấp trang
  // (dùng chung một mã cache với activeQuery nên không nhân đôi gọi server), modal
  // chỉ việc hiển thị trạng thái do server trả về.

  // Đếm ngược 15 phút thực tế, giảm từng giây một cách mượt mà và chính xác
  const remainingSeconds = Math.max(
    0,
    Math.ceil((expiryTimestamp - nowTime) / 1000),
  );
  const expired =
    !!request && (request.status === "EXPIRED" || remainingSeconds === 0);
  // Nút "Đã hoàn tất giao dịch" chỉ hiện khi vòng tự xác minh đang vô dụng với mã
  // này VÀ trang gọi đã có đơn bán để mở form thu tiền. Không có đơn thì không có
  // chỗ ghi thu, nên không bày nút dẫn vào đường cụt.
  const manualConfirmOffered =
    !!onManualConfirm &&
    !verifiedReceipt &&
    (monitorUnavailable || expired || request?.status === "CANCELLED");
  const changedDetails =
    !!request &&
    (request.amount !== amount ||
      (!!payerName?.trim() && request.payer_name !== payerName.trim()));
  // Chỉ vẽ mã khi bản ghi ĐANG KHỚP biểu mẫu. Nếu nhân viên vừa đổi số tiền/tên,
  // mã còn PENDING trên server mang số liệu CŨ; phát cho khách quét là thu sai
  // tiền. Trong khoảnh khắc chờ tạo lại (server đã bỏ cooldown cho đổi thông tin
  // nên cửa sổ này rất ngắn) ta ẩn mã, không trình bày một mã sai số tiền.
  const canShowQr =
    !!request &&
    (request.status === "PENDING" || !request.status) &&
    remainingSeconds > 0 &&
    !verifiedReceipt &&
    !changedDetails;

  const replaceAvailableMs = request?.replace_available_at
    ? Date.parse(request.replace_available_at)
    : 0;
  const serverCooldownSeconds = Number.isFinite(replaceAvailableMs)
    ? Math.max(0, Math.ceil((replaceAvailableMs - nowTime) / 1000))
    : 0;
  const cooldownSeconds = Math.max(serverCooldownSeconds, spamCooldownSeconds);

  // Tự động tạo lại mã khi biểu mẫu đổi (số tiền / tên người trả). Server đã bỏ 60
  // giây chờ cho trường hợp đổi thông tin, nên máy khách không đợi theo
  // serverCooldownSeconds nữa — chỉ còn tôn trọng ổ khóa chống spam tại máy
  // (spamCooldownSeconds). Khóa theo bộ (mã đang hiện + số tiền + tên) để mỗi lần
  // đổi chỉ phát ĐÚNG MỘT lượt; nếu server từ chối (giới hạn theo giờ) thì không
  // dồn dập gọi lại cho tới khi thông tin đổi tiếp. Debounce nhẹ để không phát giữa
  // chừng khi người dùng còn đang gõ số tiền.
  const reissue = replaceMutation.mutate;
  const reissuePending = replaceMutation.isPending;
  const reissueKey = `${request?.id ?? ""}|${amount}|${payerName?.trim() ?? ""}`;
  const lastReissueKey = useRef<string | null>(null);
  useEffect(() => {
    if (!changedDetails || verifiedReceipt || expired) return;
    if (!network.online || reissuePending || spamCooldownSeconds > 0) return;
    if (lastReissueKey.current === reissueKey) return;
    lastReissueKey.current = reissueKey;
    const timer = window.setTimeout(() => reissue(), 600);
    return () => window.clearTimeout(timer);
  }, [
    changedDetails,
    verifiedReceipt,
    expired,
    network.online,
    reissuePending,
    spamCooldownSeconds,
    reissue,
    reissueKey,
  ]);

  const handleCreateNewQr = () => {
    if (!network.online || replaceMutation.isPending || cooldownSeconds > 0)
      return;

    const now = Date.now();
    // Giữ các lần bấm trong vòng 10 giây gần nhất
    const recent = recentCreations.filter((t) => now - t < 10000);
    const updated = [...recent, now];

    // Nếu bấm tạo mới 3 lần liên tục trong 10 giây: khóa 3 giây
    if (updated.length >= 3) {
      setSpamCooldownSeconds(3);
      setRecentCreations([]);
      toast.info("Vui lòng đợi 3 giây", {
        description: "Bạn đã tạo mã 3 lần liên tục.",
      });
    } else {
      setRecentCreations(updated);
    }

    replaceMutation.mutate();
  };

  const qrResult = paymentQrPayload(request, settings, memoContext);
  const qrPayload = qrResult.payload;
  const qrImageUrl = qrResult.imageUrl;
  // Footer danh thiếp (số tiền + chữ ký "Cà Rem") chỉ đặt dưới một ô QR đã thực
  // sự hiện ra — ảnh VietQR chính thống hoặc QR vẽ tại máy. Lúc đang tải, lỗi
  // hay mã không hợp lệ thì không có chỗ để ghép, khỏi hở một hàng chữ lơ lửng.
  const qrVisible =
    !qrResult.invalid &&
    ((qrImageUrl && !imageFailed) ||
      (!!qrImage && qrImage.payload === qrPayload));

  const bankBin = request?.bank_bin || settings?.bank_bin || "";
  const bankConfig = getBankByBin(bankBin);
  const displayBankName =
    bankConfig?.shortName ||
    request?.bank_name ||
    settings?.bank_name ||
    "Ngân hàng";
  const displayAccountNo =
    request?.bank_account_no || settings?.bank_account_no || "";
  const displayAccountName =
    request?.bank_account_name || settings?.bank_account_name || "";
  // Điều ngân hàng tự điền khi quét mã = điều màn hình hiển thị = điều nút sao
  // chép trả ra: đúng chuỗi đã nhúng vào payload/addInfo, không dựng lại.
  const displayTransferContent = qrResult.description;

  /**
   * Liệu cho tấm ảnh thẻ chuyển khoản: số tiền, nội dung, tài khoản nhận. Màn
   * hình, tệp lưu và ảnh gửi cho khách cùng lấy một bộ số liệu này.
   */
  const cardModel = useMemo(
    () => ({
      amountLabel:
        request?.amount == null ? "" : money(request?.amount),
      transferContent: displayTransferContent,
      bankName: displayBankName,
      accountNo: displayAccountNo,
      accountName: displayAccountName,
      // Chữ "Cà Rem" rải quanh mã theo nhánh ngẫu nhiên CÓ CHỦ ĐÍCH: cùng một mã
      // thì ảnh không đổi bố cục mỗi lần vòng kiểm tra tiền chạy lại.
      seedKey: `${request?.qr_reference ?? ""}|${request?.amount ?? 0}|${displayTransferContent}`,
    }),
    [
      request?.amount,
      request?.qr_reference,
      displayTransferContent,
      displayBankName,
      displayAccountNo,
      displayAccountName,
    ],
  );
  // Một lần bấm chép cả câu: số tiền + nội dung. Không còn chép riêng từng cái.
  const transferCopyLine = composeTransferCopyLine(
    cardModel.amountLabel,
    displayTransferContent,
  );

  // Mã mới → ưu tiên ảnh VietQR chính thống; chỉ vẽ QR nội bộ khi ảnh lỗi
  useEffect(() => {
    setImageFailed(false);
  }, [qrImageUrl]);

  useEffect(() => {
    if (!qrPayload || !canShowQr) return;
    if (qrImageUrl && !imageFailed) return;
    let current = true;
    setQrError(false);
    // Vẽ 1:1 với ô QR trong ảnh thẻ ghép để không phóng đại lại module.
    void renderQrToDataUrl(qrPayload, 480)
      .then((url) => {
        if (current) setQrImage({ payload: qrPayload, url });
      })
      .catch(() => {
        if (current) setQrError(true);
      });
    return () => {
      current = false;
    };
  }, [qrPayload, canShowQr, qrImageUrl, imageFailed]);

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      window.setTimeout(() => {
        setCopiedField((prev) => (prev === label ? null : prev));
      }, 2000);
      toast.success(`Đã sao chép ${label}`);
    } catch {
      toast.error("Chưa thể sao chép", {
        description: "Hãy chọn và sao chép thông tin trực tiếp.",
      });
    }
  };

  const saveSource =
    canShowQr && !qrResult.invalid
      ? qrImageUrl && !imageFailed
        ? qrImageUrl
        : qrImage?.payload === qrPayload
          ? qrImage.url
          : null
      : null;
  const [preparedQr, setPreparedQr] = useState<{
    source: string;
    file: File;
    preview: string;
    /** false = ghép hỏng: màn hình lùi về ảnh thô kèm hàng chữ HTML bên dưới. */
    composited: boolean;
  } | null>(null);
  const [savingQr, setSavingQr] = useState(false);

  // Gom ảnh và ghép thẻ TRƯỚC khi bấm, để iOS còn giữ hiệu lực cú chạm khi share.
  useEffect(() => {
    if (!saveSource) return;
    let current = true;
    const controller = new AbortController();
    void (async () => {
      let rawUrl = saveSource;
      try {
        if (!rawUrl.startsWith("data:")) {
          const response = await fetch(rawUrl, { signal: controller.signal });
          if (!response.ok) throw new Error(String(response.status));
          const blob = await response.blob();
          rawUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        }
        if (!current) return;
        // Số tiền và nội dung chuyển khoản đi vào THẲNG TRONG ẢNH: người nhận
        // nhìn tấm ảnh là biết chuyển bao nhiêu, ghi chữ gì — khỏi copy từng cái.
        try {
          const card = await renderQrCardImage(rawUrl, cardModel);
          if (current)
            setPreparedQr({
              source: saveSource,
              file: new File([card.blob], "VietQR.png", { type: "image/png" }),
              preview: card.dataUrl,
              composited: true,
            });
        } catch {
          // Canvas từ chối ghép (máy lạ, ảnh bị nhiễm CORS): thà trả ảnh thô còn
          // hơn không có gì để lưu. Hàng chữ HTML dưới mã sẽ hiện lại.
          if (current)
            setPreparedQr({
              source: saveSource,
              file: new File([dataUrlToBlob(rawUrl)], "VietQR.png", {
                type: "image/png",
              }),
              preview: rawUrl,
              composited: false,
            });
        }
      } catch {
        if (current) {
          if (saveSource === qrImageUrl) setImageFailed(true);
          else setQrError(true);
        }
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [saveSource, qrImageUrl, cardModel]);

  // Ảnh đã ghép xong cho đúng mã đang hiển thị? Không thì màn hình còn dùng ảnh thô.
  const qrCard =
    preparedQr && preparedQr.source === saveSource ? preparedQr : null;
  const qrDisplaySource = qrCard?.preview ?? saveSource;
  const amountInQrImage = qrCard?.composited === true;

  const handleDownloadQr = async () => {
    if (!canShowQr || !request || savingQr || !qrCard) return;
    const fileName = `VietQR-${(request.qr_reference || "thanh_toan").replace(/\s+/g, "_")}.png`;
    const file = new File([qrCard.file], fileName, { type: "image/png" });
    if (readSaveEnvironment().phone) {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        setSavingQr(true);
        try {
          await navigator.share({ files: [file] });
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError"))
            setSaveOverlayUrl(qrCard.preview);
        } finally {
          setSavingQr(false);
        }
      } else setSaveOverlayUrl(qrCard.preview);
      return;
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const acknowledgeReceipt = () => {
    if (!request || !verifiedReceipt) return;
    onPaymentConfirmed?.(request);
    onClose();
  };
  /**
   * Khách báo đã chuyển xong nhưng mã này không có báo tiền tự động để xác minh
   * (webhook chưa cấu hình đúng, tài khoản nhận đã đổi, hoặc mã đã hết hạn). Modal
   * KHÔNG đặt trạng thái "đã thu" nào ở đây — không có đường nào cho trạng thái tự
   * xưng ở máy khách. Chỉ đóng cửa sổ QR và mở form thu tiền thường của đơn, nơi
   * Chủ/Quản lý đối chiếu sao kê rồi lập đề nghị ghi thu (PENDING, chưa đụng số dư).
   */
  const askManualCompletion = async () => {
    if (!request || !onManualConfirm) return;
    const ok = await confirmAction({
      title: "Ghi nhận khách đã chuyển khoản?",
      entity: request.qr_reference,
      description:
        "Cà Rem không tự kiểm tra được tiền cho mã này. Thao tác này KHÔNG trừ công nợ: nó mở form thu tiền để đối chiếu sao kê, và tiền chỉ vào sổ khi Chủ/Quản lý xác minh.",
      confirmLabel: "Mở form thu tiền",
      cancelLabel: "Thôi, chờ đã",
    });
    if (!ok) return;
    onManualConfirm(request);
    onClose();
  };
  const status = verifiedReceipt
    ? {
        tone: "success",
        icon: CheckCircle2,
        title: "Đã nhận tiền vào tài khoản",
        detail: "Đã khớp tài khoản nhận, số tiền và nội dung chuyển khoản.",
      }
    : !network.online
      ? {
          tone: "warning",
          icon: WifiOff,
          title: "Tạm dừng kiểm tra kết nối",
          detail:
            "Chưa thể xác minh tiền vào tài khoản. Hệ thống sẽ kiểm tra khi có mạng.",
        }
      : monitorUnavailable
        ? {
            // Không còn kênh báo tiền tự động ⇒ mọi lời hứa "tự động kiểm tra" ở
            // đây đều sai sự thật. Khách vẫn quét được mã; người bán tự hỏi lại Cà
            // Rem, rồi đi đường ghi thu thủ công nếu đã lập đơn.
            tone: "warning",
            icon: AlertTriangle,
            title: "Cà Rem chưa bật báo tiền tự động cho mã này",
            detail:
              expired || request?.status === "CANCELLED"
                ? "Mã này không còn hiệu lực và cũng không có báo tiền tự động. Khách đã chuyển thì hỏi lại Cà Rem tiền đã về chưa."
                : "Đã tắt kiểm tra tự động. Khách vẫn quét mã bình thường; khách báo đã chuyển xong thì hỏi lại Cà Rem tiền đã về chưa.",
          }
        : expired || request?.status === "CANCELLED"
          ? {
              tone: "warning",
              icon: Clock,
              title: expired ? "Mã QR đã hết hạn" : "Mã QR đã được thay thế",
              detail:
                "Chưa có khoản tiền được xác minh cho mã này. Chuyển tiền trễ cần được đối soát.",
            }
        : requestQuery.isError || matchQuery.isError
            ? {
                tone: "warning",
                icon: AlertTriangle,
                title: "Chưa kiểm tra được giao dịch",
                detail:
                  "Chưa thể xác nhận thanh toán. Hệ thống đang thử kiểm tra lại.",
              }
            : matchQuery.data?.state === "REVIEW"
              ? {
                  tone: "warning",
                  icon: AlertTriangle,
                  title: "Giao dịch cần đối soát",
                  detail:
                    "Thông tin chuyển tiền chưa khớp. Chưa ghi nhận thanh toán thành công.",
                }
              : {
                  tone: "pending",
                  icon: Clock,
                  title: "Chưa nhận được tiền",
                  detail: "Tự động kiểm tra thông báo từ ngân hàng.",
                };
  const StatusIcon = status.icon;

  // Ba trạng thái của đồng hồ: đang đếm / sắp hết hạn (< 1 phút) / đã hết hạn.
  const clockTone: "active" | "urgent" | "expired" =
    !canShowQr || remainingSeconds === 0
      ? "expired"
      : remainingSeconds <= QR_URGENT_SECONDS
        ? "urgent"
        : "active";
  const clockDigits = splitCountdown(remainingSeconds);

  return (
    <div
      className="dialog-backdrop vietqr-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={`dialog-panel vietqr-modal-panel${verifiedReceipt ? " vietqr-modal-panel--success" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="vietqr-ambient" aria-hidden="true">
          <span className="vietqr-ambient-photo" />
          <span className="vietqr-ambient-scrim" />
          <span className="vietqr-ambient-grain" />
          {/* Chữ ký "Cà Rem" viết tay phủ nền tối như hoa văn chống giả — chỉ là
              chrome của hộp thoại, không nằm trong ảnh tải về. */}
          <span className="vietqr-ambient-marks">
            {Array.from({ length: 160 }).map((_, index) => (
              <em key={index}>Cà Rem</em>
            ))}
          </span>
          <span className="vietqr-ambient-sign">
            <em>Cà Rem</em>
            <em>Uy Tín Tạo Niềm Tin</em>
          </span>
        </div>

        <div className="vietqr-modal-heading">
          <span
            className="vietqr-brand-badge"
            role="img"
            aria-label="Logo Cà Rem"
          />
          <div className="vietqr-heading-text">
            <h2 id={titleId}>
              {verifiedReceipt
                ? "Hoàn tất thanh toán"
                : "Thanh toán chuyển khoản"}
            </h2>
            <p id={descriptionId}>
              {verifiedReceipt
                ? "Cà Rem · Giao dịch đã được xác minh"
                : "Cà Rem · Mã QR có hiệu lực 15 phút"}
            </p>
          </div>
          <Button
            variant="ghost"
            className="vietqr-close"
            aria-label="Đóng hộp thoại"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </div>
        {settingsQuery.isError && (
          <div className="vietqr-state stack">
            <ErrorState error={settingsQuery.error} />
            <Button
              variant="secondary"
              onClick={() => void settingsQuery.refetch()}
              disabled={!network.online}
            >
              Thử tải lại cấu hình
            </Button>
          </div>
        )}
        {settingsQuery.isSuccess && !isConfigured && (
          <div className="vietqr-state stack">
            <div className="notice warning">
              <strong>Chưa thiết lập tài khoản nhận tiền</strong>
              <p>
                Vào Cài đặt để thêm thông tin tài khoản ngân hàng nhận tiền.
              </p>
            </div>
            <Link className="button" to="/settings" onClick={onClose}>
              Cài đặt tài khoản <ArrowRight size={15} />
            </Link>
          </div>
        )}
        {!request &&
          (settingsQuery.isPending ||
            (isConfigured &&
              (activeQuery.isPending ||
                createMutation.isPending ||
                replaceMutation.isPending))) && (
            <div className="vietqr-state">
              <Loading variant="compact" label="Đang kiểm tra mã thanh toán…" />
            </div>
          )}
        {!request && activeQuery.isError && (
          <div className="vietqr-state stack">
            <ErrorState error={activeQuery.error} />
            <Button
              variant="secondary"
              onClick={() => void activeQuery.refetch()}
              disabled={!network.online}
            >
              Thử kiểm tra lại mã QR
            </Button>
          </div>
        )}
        {!request && createMutation.isError && (
          <div className="vietqr-state stack">
            <ErrorState error={createMutation.error} />
            <Button
              variant="secondary"
              onClick={() => createMutation.mutate()}
              disabled={!network.online || createMutation.isPending}
            >
              Thử tạo lại mã QR
            </Button>
          </div>
        )}
        {request &&
          (verifiedReceipt ? (
            <VietQrPaymentSuccess
              amount={request.amount}
              reference={request.qr_reference}
              transferContent={displayTransferContent}
              bankName={displayBankName}
              accountNo={displayAccountNo}
              accountName={displayAccountName}
              onAcknowledge={acknowledgeReceipt}
            />
          ) : (
            <div className="vietqr-content">
              <div
                className={`vietqr-bank-status vietqr-bank-status--${status.tone}`}
                role="status"
                aria-live="polite"
              >
                <StatusIcon size={18} aria-hidden="true" />
                <div className="vietqr-bank-status-text">
                  <strong>{status.title}</strong>
                  <p>{status.detail}</p>
                </div>
              </div>

              {amount > 0 && isAboveNapasSingleTransfer(amount) && (
                <div className="notice warning vietqr-limit-notice" role="note">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <div>
                    <strong>Số tiền lớn — kiểm tra hạn mức ngân hàng</strong>
                    <p>{napasOverLimitHint()}</p>
                  </div>
                </div>
              )}

              {!verifiedReceipt && (
                <div className="vietqr-display-box">
                  {/* Đồng hồ xuyến: cùng một khối cho cả ba trạng thái
                    đang đếm / sắp hết hạn / đã hết hạn. */}
                  <div className={`vietqr-clock vietqr-clock--${clockTone}`}>
                    <span className="vietqr-clock-dial">
                      <CountdownRing
                        ratio={remainingSeconds / QR_LIFETIME_SECONDS}
                        tone={clockTone}
                      />
                      {clockTone === "expired" ? (
                        <RefreshCw size={17} aria-hidden="true" />
                      ) : (
                        <Clock size={17} aria-hidden="true" />
                      )}
                    </span>
                    <div className="vietqr-clock-body">
                      <span className="vietqr-clock-label">
                        {clockTone === "expired"
                          ? "Mã QR đã mất hiệu lực"
                          : "Mã QR sẽ hết hạn sau"}
                      </span>
                      <span className="vietqr-clock-readout">
                        <span
                          className="vietqr-countdown"
                          role="timer"
                          aria-label={`Thời gian còn lại ${formatCountdown(remainingSeconds)}`}
                        >
                          <strong aria-hidden="true">
                            {clockDigits.minutes}
                          </strong>
                          <strong
                            className="vietqr-clock-sep"
                            aria-hidden="true"
                          >
                            :
                          </strong>
                          <strong aria-hidden="true">
                            {clockDigits.seconds}
                          </strong>
                        </span>
                        <span className="vietqr-clock-units" aria-hidden="true">
                          <b>PHÚT</b>
                          <b />
                          <b>GIÂY</b>
                        </span>
                      </span>
                    </div>
                  </div>

                  {canShowQr ? (
                    <>
                      {qrResult.invalid ? (
                        <div className="vietqr-invalid-box">
                          <p className="notice warning">
                            Chưa có đủ thông tin tài khoản hợp lệ để tạo mã QR.
                          </p>
                          <Button
                            variant="secondary"
                            onClick={handleCreateNewQr}
                            disabled={
                              replaceMutation.isPending ||
                              cooldownSeconds > 0 ||
                              !network.online
                            }
                          >
                            <RefreshCw
                              size={14}
                              className={
                                replaceMutation.isPending ? "spin" : ""
                              }
                            />
                            {replaceMutation.isPending
                              ? "Đang tạo mã mới…"
                              : cooldownSeconds > 0
                                ? `Thử lại (${cooldownSeconds}s)`
                                : "Thử tạo lại mã"}
                          </Button>
                        </div>
                      ) : qrDisplaySource ? (
                        <div
                          className={`vietqr-qr-frame${amountInQrImage
                            ? " vietqr-qr-frame--poster"
                            : " vietqr-qr-frame--card"}`}
                        >
                          <span
                            className="vietqr-qr-corner vietqr-qr-corner--tl"
                            aria-hidden="true"
                          />
                          <span
                            className="vietqr-qr-corner vietqr-qr-corner--tr"
                            aria-hidden="true"
                          />
                          <span
                            className="vietqr-qr-corner vietqr-qr-corner--bl"
                            aria-hidden="true"
                          />
                          <span
                            className="vietqr-qr-corner vietqr-qr-corner--br"
                            aria-hidden="true"
                          />
                          {/* Ảnh ghép đã là một tấm thẻ hoàn chỉnh: mã QR, số tiền,
                              nội dung và dấu "Cà Rem" nằm trong ảnh nên thấy sao
                              lưu vậy. Chỉ ảnh thô mới cần báo lỗi nạp ảnh. */}
                          <img
                            ref={attachRemoteQr}
                            src={qrDisplaySource}
                            width={amountInQrImage ? 272 : 220}
                            alt="Mã QR chuyển khoản"
                            onError={
                              qrDisplaySource === qrImageUrl
                                ? () => setImageFailed(true)
                                : undefined
                            }
                          />
                        </div>
                      ) : qrError ? (
                        <p className="notice warning">
                          Chưa hiển thị được mã QR. Hãy đóng và mở lại để thử
                          lại.
                        </p>
                      ) : (
                        <Loading variant="compact" label="Đang tải mã QR…" />
                      )}

                      {/* Hàng chữ dự phòng: chỉ khi ảnh ghép chưa thành công. */}
                      {qrVisible && !amountInQrImage && (
                        <div className="vietqr-qr-cardfoot">
                          <div className="vietqr-qr-foot-row">
                            <span className="vietqr-qr-foot-amt">
                              {money(request.amount)}
                            </span>
                            <span
                              className="vietqr-qr-sign"
                              aria-hidden="true"
                            >
                              Cà Rem
                            </span>
                          </div>
                          <p
                            className="vietqr-qr-foot-nd"
                            title={displayTransferContent}
                          >
                            <span className="vietqr-qr-foot-nd-label">ND</span>
                            <b className="vietqr-qr-foot-nd-text">
                              {displayTransferContent}
                            </b>
                          </p>
                        </div>
                      )}

                      <Button
                        variant="secondary"
                        className="vietqr-download"
                        onClick={() => void handleDownloadQr()}
                        disabled={!canShowQr || !qrCard || savingQr}
                      >
                        <Download size={15} />{" "}
                        {savingQr ? "Đang mở bảng lưu…" : "Lưu ảnh QR"}
                      </Button>
                    </>
                  ) : (
                    <div className="vietqr-unavailable">
                      {changedDetails && !expired ? (
                        <>
                          <RefreshCw
                            size={26}
                            aria-hidden="true"
                            className="spin"
                          />
                          <strong>
                            Đang tạo lại mã theo thông tin vừa sửa…
                          </strong>
                          <span>
                            Số tiền hoặc người trả đã đổi — mã mới sẽ hiện ngay khi
                            tạo xong.
                          </span>
                        </>
                      ) : (
                        <>
                          <Clock size={26} aria-hidden="true" />
                          <strong>
                            {expired
                              ? "Mã này đã hết hạn"
                              : "Mã QR tạm thời không khả dụng"}
                          </strong>
                          <span>Tạo mã mới để tiếp tục chuyển khoản.</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {changedDetails && !verifiedReceipt && !expired && (
                <p
                  className="vietqr-autoupdate-hint"
                  role="status"
                  aria-live="polite"
                >
                  <RefreshCw
                    size={13}
                    aria-hidden="true"
                    className={spamCooldownSeconds > 0 ? "" : "spin"}
                  />
                  {spamCooldownSeconds > 0
                    ? `Đã thay đổi thông tin — mã sẽ tự cập nhật sau ${spamCooldownSeconds} giây.`
                    : "Đang cập nhật mã theo thông tin mới…"}
                </p>
              )}

              {/* Thẻ kính mờ: thông tin chuyển khoản theo đúng thứ tự chuẩn ngân hàng.
                  Số tiền không còn nút chép riêng — một bấm ở hàng dưới chép cả câu. */}
              <div className="vietqr-details-card">
                <div className="vietqr-detail-row vietqr-detail-row--amount">
                  <span className="vietqr-detail-icon" aria-hidden="true">
                    <Banknote size={16} />
                  </span>
                  <span className="vietqr-detail-key">Số tiền thanh toán</span>
                  <span className="vietqr-detail-val">
                    <strong className="vietqr-amount-value">
                      {money(request.amount)}
                    </strong>
                  </span>
                </div>

                <div className="vietqr-detail-row">
                  <span className="vietqr-detail-icon" aria-hidden="true">
                    <FileText size={16} />
                  </span>
                  <span className="vietqr-detail-key">
                    Nội dung chuyển khoản
                  </span>
                  <span className="vietqr-transfer-badge">
                    Tự điền khi quét
                  </span>
                </div>
                <div className="vietqr-transfer-box">
                  <strong className="vietqr-transfer-text">
                    {displayTransferContent}
                  </strong>
                  <Button
                    variant="ghost"
                    className="vietqr-copy-btn"
                    aria-label="Sao chép số tiền và nội dung chuyển khoản"
                    onClick={() =>
                      void handleCopy(
                        transferCopyLine,
                        "số tiền và nội dung chuyển khoản",
                      )
                    }
                    title="Chép cả số tiền lẫn nội dung — một lần là đủ"
                  >
                    {copiedField === "số tiền và nội dung chuyển khoản" ? (
                      <Check size={14} className="vietqr-copied-icon" />
                    ) : (
                      <Copy size={14} />
                    )}
                  </Button>
                </div>

                <dl className="vietqr-detail-list">
                  <div className="vietqr-detail-row">
                    <dt>
                      <span className="vietqr-detail-icon" aria-hidden="true">
                        <Landmark size={16} />
                      </span>
                      Ngân hàng
                    </dt>
                    <dd>{displayBankName}</dd>
                  </div>
                  <div className="vietqr-detail-row">
                    <dt>
                      <span className="vietqr-detail-icon" aria-hidden="true">
                        <CreditCard size={16} />
                      </span>
                      Số tài khoản
                    </dt>
                    <dd>
                      <span className="vietqr-acc-no">{displayAccountNo}</span>
                      {displayAccountNo ? (
                        <Button
                          variant="ghost"
                          className="vietqr-copy-btn"
                          aria-label="Sao chép số tài khoản"
                          onClick={() =>
                            void handleCopy(displayAccountNo, "số tài khoản")
                          }
                          title="Sao chép số tài khoản"
                        >
                          {copiedField === "số tài khoản" ? (
                            <Check size={13} className="vietqr-copied-icon" />
                          ) : (
                            <Copy size={13} />
                          )}
                        </Button>
                      ) : null}
                    </dd>
                  </div>
                  <div className="vietqr-detail-row">
                    <dt>
                      <span className="vietqr-detail-icon" aria-hidden="true">
                        <User size={16} />
                      </span>
                      Chủ tài khoản
                    </dt>
                    <dd>{displayAccountName || "Chưa có tên chủ tài khoản"}</dd>
                  </div>
                </dl>
              </div>

              {replaceMutation.isError &&
                !/VIETQR_REPLACEMENT_COOLDOWN|VIETQR_RATE_LIMITED/i.test(
                  errorText(replaceMutation.error),
                ) && <ErrorState error={replaceMutation.error} />}

              <div className="vietqr-actions">
                <Button
                  variant="secondary"
                  className="vietqr-btn-ghost"
                  onClick={onClose}
                >
                  <ArrowLeft size={15} /> Quay lại
                </Button>
                {manualConfirmOffered && (
                  <Button
                    variant="secondary"
                    className="vietqr-btn-manual"
                    onClick={() => void askManualCompletion()}
                  >
                    <Check size={16} /> Đã hoàn tất giao dịch
                  </Button>
                )}
                {verifiedReceipt ? (
                  <Button
                    className="vietqr-btn-confirm"
                    onClick={acknowledgeReceipt}
                  >
                    <CheckCircle2 size={16} /> Xác nhận và đóng
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    className="vietqr-btn-reissue"
                    onClick={handleCreateNewQr}
                    disabled={
                      !network.online ||
                      replaceMutation.isPending ||
                      cooldownSeconds > 0
                    }
                  >
                    <RefreshCw
                      size={15}
                      className={replaceMutation.isPending ? "spin" : ""}
                    />{" "}
                    {replaceMutation.isPending
                      ? "Đang tạo mã mới…"
                      : cooldownSeconds > 0
                        ? `Tạo mã mới (${cooldownSeconds}s)`
                        : "Tạo mã mới"}
                  </Button>
                )}
              </div>

              <p className="vietqr-footnote">
                <span className="vietqr-secure">
                  <Info size={12} aria-hidden="true" /> Giao dịch an toàn · Bảo
                  mật tuyệt đối
                </span>
                {!verifiedReceipt && (
                  <small>
                    {monitorUnavailable
                      ? "Đóng hoặc mở lại không gia hạn mã. Mã vẫn quét được; Cà Rem xác nhận tiền bằng đối chiếu sao kê thủ công."
                      : "Đóng hoặc mở lại không gia hạn mã. Cà Rem chỉ xác nhận khi ngân hàng báo tiền đã vào đúng tài khoản."}
                  </small>
                )}
              </p>
            </div>
          ))}
      </div>

      {saveOverlayUrl && (
        <div
          className="vietqr-save-overlay"
          role="dialog"
          aria-label="Lưu ảnh QR"
          onClick={() => setSaveOverlayUrl(null)}
        >
          <div
            className="vietqr-save-card"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="vietqr-save-close"
              onClick={() => setSaveOverlayUrl(null)}
              aria-label="Đóng"
            >
              <X size={20} />
            </button>
            <img
              src={saveOverlayUrl}
              alt="Mã QR thanh toán"
              className="vietqr-save-img"
            />
            <p className="vietqr-save-hint">
              <strong>Nhấn giữ vào ảnh</strong> và chọn{" "}
              <strong>“Lưu hình ảnh”</strong> để lưu vào Photos / Bộ sưu tập.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
