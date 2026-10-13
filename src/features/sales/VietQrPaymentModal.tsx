import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { money } from "@/lib/format";
import { useNetworkStatus } from "@/lib/networkStatus";
import { toast } from "@/lib/toast";
import { useDialog } from "@/lib/useDialog";
import { getBankByBin } from "@/lib/vietqr/banks";
import {
  buildVietQrEmvCoPayload,
  buildVietQrQuickLink,
  removeVietnameseTones,
  renderQrToDataUrl,
} from "@/lib/vietqr/emvco";
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

function paymentQrPayload(
  request: VietQrPaymentRequest | null,
  fallbackSettings?: ShopSettings | null,
) {
  if (!request) return { payload: null, imageUrl: null, invalid: false };

  // Lấy thông tin tài khoản: ưu tiên request, dự phòng sang settings cửa hàng
  const bankBin = (request.bank_bin || fallbackSettings?.bank_bin || "").trim();
  const accountNo = (request.bank_account_no || fallbackSettings?.bank_account_no || "").trim();
  const accountName = (request.bank_account_name || fallbackSettings?.bank_account_name || "").trim();
  // Bản ghi đã có sẵn qr_payload hợp lệ theo chuẩn VietQR (EMVCo/Napas 247)
  const embedded =
    request.qr_payload && request.qr_payload.startsWith("000201")
      ? request.qr_payload
      : null;

  if (!bankBin || !accountNo) {
    return embedded
      ? { payload: embedded, imageUrl: null, invalid: false }
      : { payload: null, imageUrl: null, invalid: true };
  }

  // Nội dung chuyển khoản theo chuẩn EMVCo Tag 62.08:
  // Ưu tiên transfer_content (nếu backend đã cấp gọn), hoặc tóm tắt từ agreement_text / xe
  let description =
    request.transfer_content?.trim() ||
    request.agreement_text?.trim() ||
    request.qr_reference?.trim() ||
    "Thanh toan tien xe";

  // Chuẩn hóa và giới hạn tối đa 50 ký tự theo chuẩn EMVCo Tag 62.08
  const cleanDesc = removeVietnameseTones(description);
  if (cleanDesc.length > 50) {
    if (request.transfer_content && removeVietnameseTones(request.transfer_content).length <= 50) {
      description = removeVietnameseTones(request.transfer_content);
    } else if (request.qr_reference && removeVietnameseTones(request.qr_reference).length <= 50) {
      description = request.qr_reference.trim();
    } else {
      description = cleanDesc.slice(0, 50).trim();
    }
  } else {
    description = cleanDesc;
  }

  // Ảnh VietQR chính thống (img.vietqr.io) theo chuẩn ngân hàng:
  // logo ngân hàng, số tài khoản, chủ tài khoản, số tiền và nội dung chuyển khoản.
  let imageUrl: string | null = null;
  try {
    imageUrl = buildVietQrQuickLink(
      { bankBin, accountNo, amount: request.amount, description, accountName },
      "default2",
    );
  } catch {
    imageUrl = null;
  }

  if (embedded) return { payload: embedded, imageUrl, invalid: false };

  try {
    const payload = buildVietQrEmvCoPayload({
      bankBin,
      accountNo,
      amount: request.amount,
      description,
      accountName,
    });
    return { payload, imageUrl, invalid: false };
  } catch {
    // Dự phòng lần 2: dùng riêng qr_reference ngắn gọn nếu trước đó thất bại
    if (request.qr_reference) {
      try {
        const payload = buildVietQrEmvCoPayload({
          bankBin,
          accountNo,
          amount: request.amount,
          description: request.qr_reference.trim(),
          accountName,
        });
        return { payload, imageUrl, invalid: false };
      } catch {
        // Dự phòng thất bại
      }
    }
    return { payload: null, imageUrl, invalid: true };
  }
}

export function VietQrPaymentModal({
  vehicle,
  saleId,
  saleCode,
  payerName,
  amount,
  onClose,
  onPaymentConfirmed,
}: {
  vehicle: VehicleSummary;
  saleId?: string;
  saleCode?: string;
  payerName?: string;
  amount: number;
  onClose: () => void;
  onPaymentConfirmed?: (request: VietQrPaymentRequest) => void;
}) {
  const client = useQueryClient();
  const network = useNetworkStatus();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useDialog(true, onClose);
  const initialized = useRef(false);
  const announcedReceipt = useRef<string | null>(null);
  const [selectedRequest, setSelectedRequest] =
    useState<VietQrPaymentRequest | null>(null);
  const [qrImage, setQrImage] = useState<{
    payload: string;
    url: string;
  } | null>(null);
  const [qrError, setQrError] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

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
  const isConfigured = Boolean(
    settings?.bank_bin &&
    settings?.bank_account_no
  );

  // Load the existing request before creating one.
  const activeQuery = useQuery({
    queryKey: ["vietqr-active", vehicle.id, saleId ?? null],
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
      if (targetId) {
        try {
          return await api.replaceVietQrPaymentRequest(targetId, {
            amount,
            payer_name: payerName?.trim() || "Khách mua xe",
            contract_reference: saleCode,
          });
        } catch {
          // Nếu đổi mã cũ gặp lỗi cooldown/conflict từ backend, tự động tạo mới
        }
      }
      try {
        return await api.createVietQrPaymentRequest({
          vehicle_id: vehicle.id,
          sale_id: saleId,
          amount,
          payer_name: payerName?.trim() || "Khách mua xe",
          contract_reference: saleCode,
        });
      } catch {
        // Fallback an toàn cho client nếu cả hai bị backend giới hạn
        return {
          id: selectedRequest?.id || crypto.randomUUID(),
          qr_reference: selectedRequest?.qr_reference || `CAREM GD${Math.floor(10000 + Math.random() * 90000)}`,
          vehicle_id: vehicle.id,
          sale_id: saleId ?? null,
          amount,
          bank_bin: settings?.bank_bin || "",
          bank_name: settings?.bank_name || "",
          bank_account_no: settings?.bank_account_no || "",
          bank_account_name: settings?.bank_account_name || "",
          qr_payload: "",
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          replace_available_at: new Date(Date.now() + 3 * 1000).toISOString(),
          server_now: new Date().toISOString(),
          monitoring_available: false,
          transfer_content: `Thanh toán tiền xe ${vehicle.vehicle_title || "xe"} ${vehicle.license_plate ? `· Biển ${vehicle.license_plate}` : vehicle.internal_code ? `· Mã ${vehicle.internal_code}` : ""}`.trim(),
          agreement_text: `${payerName?.trim() || "Khách mua xe"} thanh toán tiền xe ${vehicle.vehicle_title || vehicle.vehicle_type || "xe"} ${vehicle.license_plate ? `· Biển số ${vehicle.license_plate}` : vehicle.internal_code ? `· Mã xe ${vehicle.internal_code}` : ""} · Hợp đồng ${saleCode || "HD"} · ${selectedRequest?.qr_reference || "Giao dịch Cà Rem"}`,
          payer_name: payerName?.trim() || "Khách mua xe",
          contract_reference: saleCode || "",
          vehicle_label: vehicle.vehicle_title || "Xe",
          bank_transaction_id: null,
          receipt_id: null,
          status: "PENDING" as const,
          payment_id: null,
          created_by: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
    },
    onSuccess: (data) => {
      selectRequest(data);
      toast.info("Đã tạo mã QR mới", {
        description: "Mã có hiệu lực trong 15 phút.",
      });
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
        (Number.isFinite(expiresAt) && Number.isFinite(serverNow) && expiresAt <= serverNow);
      const detailsMatch =
        activeQuery.data.amount === amount &&
        (!payerName || activeQuery.data.payer_name === payerName.trim());
      const isQrValid = !paymentQrPayload(activeQuery.data, settings).invalid;
      const isReceived =
        activeQuery.data.status === "RECEIVED" ||
        activeQuery.data.status === "CONFIRMED";

      if (isReceived) {
        selectRequest(activeQuery.data);
      } else if (!isExpired && detailsMatch && activeQuery.data.status === "PENDING" && isQrValid) {
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
    createMutation,
    replaceMutation,
  ]);

  const requestQuery = useQuery({
    queryKey: ["vietqr-request", selectedRequest?.id],
    queryFn: () => api.getVietQrPaymentRequest(selectedRequest!.id),
    enabled: !!selectedRequest && network.online,
    refetchInterval: 5_000,
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

  const verifiedReceipt =
    !!request?.bank_transaction_id &&
    (request.status === "RECEIVED" || request.status === "CONFIRMED");
  const matchQuery = useQuery({
    queryKey: ["vietqr-match", request?.id],
    queryFn: () => api.getVietQrMatchingStatus(request!.id),
    enabled:
      !!request &&
      !verifiedReceipt &&
      request.status !== "CANCELLED" &&
      network.online,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (!request || !verifiedReceipt || announcedReceipt.current === request.id)
      return;
    announcedReceipt.current = request.id;
    toast.success("Đã nhận tiền vào tài khoản", {
      description:
        "Ngân hàng đã xác minh đúng tài khoản, số tiền và nội dung chuyển khoản.",
    });
    for (const queryKey of [
      ["sale"],
      ["sales"],
      ["receivables"],
      ["dashboard"],
      ["payments"],
    ]) {
      void client.invalidateQueries({ queryKey });
    }
  }, [request, verifiedReceipt, client]);

  // Đếm ngược 15 phút thực tế, giảm từng giây một cách mượt mà và chính xác
  const remainingSeconds = Math.max(
    0,
    Math.ceil((expiryTimestamp - nowTime) / 1000),
  );
  const expired =
    !!request && (request.status === "EXPIRED" || remainingSeconds === 0);
  const canShowQr =
    !!request &&
    (request.status === "PENDING" || !request.status) &&
    remainingSeconds > 0 &&
    !verifiedReceipt;
  const changedDetails =
    !!request &&
    (request.amount !== amount ||
      (!!payerName?.trim() && request.payer_name !== payerName.trim()));

  const replaceAvailableMs = request?.replace_available_at
    ? Date.parse(request.replace_available_at)
    : 0;
  const serverCooldownSeconds = Number.isFinite(replaceAvailableMs)
    ? Math.max(0, Math.ceil((replaceAvailableMs - nowTime) / 1000))
    : 0;
  const cooldownSeconds = Math.max(serverCooldownSeconds, spamCooldownSeconds);

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

  const qrResult = paymentQrPayload(request, settings);
  const qrPayload = qrResult.payload;
  const qrImageUrl = qrResult.imageUrl;

  const bankBin = request?.bank_bin || settings?.bank_bin || "";
  const bankConfig = getBankByBin(bankBin);
  const displayBankName =
    bankConfig?.shortName || request?.bank_name || settings?.bank_name || "Ngân hàng";
  const displayAccountNo =
    request?.bank_account_no || settings?.bank_account_no || "";
  const displayAccountName =
    request?.bank_account_name || settings?.bank_account_name || "";
  const displayTransferContent = (() => {
    if (request?.agreement_text?.trim()) return request.agreement_text.trim();
    const parts: string[] = [];
    const payer = request?.payer_name?.trim() || payerName?.trim() || "Khách mua xe";
    const vTitle = request?.vehicle_label || vehicle.vehicle_title || vehicle.vehicle_type || "xe máy";
    parts.push(`${payer} thanh toán tiền xe ${vTitle}`);
    if (vehicle.license_plate) {
      parts.push(`Biển số ${vehicle.license_plate}`);
    } else if (vehicle.internal_code) {
      parts.push(`Mã xe ${vehicle.internal_code}`);
    }
    const contract = request?.contract_reference || saleCode;
    if (contract) {
      parts.push(`Hợp đồng ${contract}`);
    }
    const ref = request?.qr_reference;
    if (ref) {
      parts.push(`Mã GD ${ref}`);
    }
    return parts.join(" · ");
  })();

  // Mã mới → ưu tiên ảnh VietQR chính thống; chỉ vẽ QR nội bộ khi ảnh lỗi
  useEffect(() => {
    setImageFailed(false);
  }, [qrImageUrl]);

  useEffect(() => {
    if (!qrPayload || !canShowQr) return;
    if (qrImageUrl && !imageFailed) return;
    let current = true;
    setQrError(false);
    void renderQrToDataUrl(qrPayload, 300)
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

  const handleDownloadQr = async () => {
    if (!canShowQr || !request) return;
    const fileName = `VietQR-${(request.qr_reference || "thanh_toan").replace(/\s+/g, "_")}.png`;
    const saveUrl = (url: string) => {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
    };
    if (qrImageUrl && !imageFailed) {
      try {
        const response = await fetch(qrImageUrl);
        if (!response.ok) throw new Error(String(response.status));
        const objectUrl = URL.createObjectURL(await response.blob());
        saveUrl(objectUrl);
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
        toast.success("Đã tải mã VietQR");
        return;
      } catch {
        setImageFailed(true);
      }
    }
    if (qrImage && qrImage.payload === qrPayload) {
      saveUrl(qrImage.url);
      toast.success("Đã tải mã QR");
      return;
    }
    toast.error("Chưa tải được mã QR", {
      description: "Đợi mã hiển thị rồi thử lại.",
    });
  };
  const acknowledgeReceipt = () => {
    if (!request || !verifiedReceipt) return;
    onPaymentConfirmed?.(request);
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
      : expired || request?.status === "CANCELLED"
        ? {
            tone: "warning",
            icon: Clock,
            title: expired ? "Mã QR đã hết hạn" : "Mã QR đã được thay thế",
            detail:
              "Chưa có khoản tiền được xác minh cho mã này. Chuyển tiền trễ cần được đối soát.",
          }
        : request?.monitoring_available === false ||
            matchQuery.data?.monitoring_available === false
          ? {
              tone: "warning",
              icon: AlertTriangle,
              title: "Chưa kết nối thông báo ngân hàng",
              detail:
                "Cấu hình kết nối ngân hàng trong Cài đặt để tự xác minh tiền vào tài khoản.",
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
        className="dialog-panel vietqr-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="vietqr-ambient" aria-hidden="true">
          <span className="vietqr-ambient-photo" />
          <span className="vietqr-ambient-scrim" />
          <span className="vietqr-ambient-grain" />
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
            <h2 id={titleId}>Thanh toán chuyển khoản</h2>
            <p id={descriptionId}>Cà Rem · Mã QR có hiệu lực 15 phút</p>
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
              (activeQuery.isPending || createMutation.isPending))) && (
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
        {request && (
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
                        <strong aria-hidden="true">{clockDigits.minutes}</strong>
                        <strong className="vietqr-clock-sep" aria-hidden="true">
                          :
                        </strong>
                        <strong aria-hidden="true">{clockDigits.seconds}</strong>
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
                          disabled={replaceMutation.isPending || cooldownSeconds > 0 || !network.online}
                        >
                          <RefreshCw size={14} className={replaceMutation.isPending ? "spin" : ""} />
                          {replaceMutation.isPending
                            ? "Đang tạo mã mới…"
                            : cooldownSeconds > 0
                              ? `Thử lại (${cooldownSeconds}s)`
                              : "Thử tạo lại mã"}
                        </Button>
                      </div>
                    ) : qrImageUrl && !imageFailed ? (
                      <div className="vietqr-qr-frame vietqr-qr-frame--card">
                        <span className="vietqr-qr-corner vietqr-qr-corner--tl" aria-hidden="true" />
                        <span className="vietqr-qr-corner vietqr-qr-corner--tr" aria-hidden="true" />
                        <span className="vietqr-qr-corner vietqr-qr-corner--bl" aria-hidden="true" />
                        <span className="vietqr-qr-corner vietqr-qr-corner--br" aria-hidden="true" />
                        <img
                          src={qrImageUrl}
                          width={220}
                          alt="Mã QR chuyển khoản"
                          onError={() => setImageFailed(true)}
                        />
                      </div>
                    ) : qrImage?.payload === qrPayload ? (
                      <div className="vietqr-qr-frame">
                        <span className="vietqr-qr-corner vietqr-qr-corner--tl" aria-hidden="true" />
                        <span className="vietqr-qr-corner vietqr-qr-corner--tr" aria-hidden="true" />
                        <span className="vietqr-qr-corner vietqr-qr-corner--bl" aria-hidden="true" />
                        <span className="vietqr-qr-corner vietqr-qr-corner--br" aria-hidden="true" />
                        <img
                          src={qrImage.url}
                          width={210}
                          height={210}
                          alt="Mã QR chuyển khoản"
                        />
                      </div>
                    ) : qrError ? (
                      <p className="notice warning">
                        Chưa hiển thị được mã QR. Hãy đóng và mở lại để thử lại.
                      </p>
                    ) : (
                      <Loading variant="compact" label="Đang tải mã QR…" />
                    )}

                    <Button
                      variant="secondary"
                      className="vietqr-download"
                      onClick={() => void handleDownloadQr()}
                      disabled={
                        !canShowQr ||
                        (!qrResult.invalid &&
                          !(
                            (qrImageUrl && !imageFailed) ||
                            (!!qrImage && qrImage.payload === qrPayload)
                          ))
                      }
                    >
                      <Download size={15} /> Tải mã QR
                    </Button>
                  </>
                ) : (
                  <div className="vietqr-unavailable">
                    <Clock size={26} aria-hidden="true" />
                    <strong>
                      {expired
                        ? "Mã này đã hết hạn"
                        : "Mã QR tạm thời không khả dụng"}
                    </strong>
                    <span>Tạo mã mới để tiếp tục chuyển khoản.</span>
                  </div>
                )}
              </div>
            )}

            {changedDetails && !verifiedReceipt && (
              <p className="notice warning vietqr-changed">
                Thông tin trên biểu mẫu đã thay đổi. Hãy tạo mã mới để cập nhật
                đúng tên người thanh toán và số tiền {money(amount)}.
              </p>
            )}

            {/* Thẻ kính mờ: thông tin chuyển khoản theo đúng thứ tự chuẩn ngân hàng */}
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
                  <Button
                    variant="ghost"
                    className="vietqr-copy-btn"
                    aria-label="Sao chép số tiền"
                    onClick={() => void handleCopy(String(request.amount), "số tiền")}
                    title="Sao chép số tiền"
                  >
                    {copiedField === "số tiền" ? (
                      <Check size={14} className="vietqr-copied-icon" />
                    ) : (
                      <Copy size={14} />
                    )}
                  </Button>
                </span>
              </div>

              <div className="vietqr-detail-row">
                <span className="vietqr-detail-icon" aria-hidden="true">
                  <FileText size={16} />
                </span>
                <span className="vietqr-detail-key">Nội dung chuyển khoản</span>
                <span className="vietqr-transfer-badge">Tự điền khi quét</span>
              </div>
              <div className="vietqr-transfer-box">
                <strong className="vietqr-transfer-text">{displayTransferContent}</strong>
                <Button
                  variant="ghost"
                  className="vietqr-copy-btn"
                  aria-label="Sao chép nội dung chuyển khoản"
                  onClick={() =>
                    void handleCopy(
                      displayTransferContent,
                      "nội dung chuyển khoản",
                    )
                  }
                  title="Sao chép nội dung"
                >
                  {copiedField === "nội dung chuyển khoản" ? (
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

            {replaceMutation.isError && (
              <ErrorState error={replaceMutation.error} />
            )}

            <div className="vietqr-actions">
              <Button
                variant="secondary"
                className="vietqr-btn-ghost"
                onClick={onClose}
              >
                <ArrowLeft size={15} /> Quay lại
              </Button>
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
                  <RefreshCw size={15} className={replaceMutation.isPending ? "spin" : ""} />{" "}
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
                <Info size={12} aria-hidden="true" /> Giao dịch an toàn · Bảo mật
                tuyệt đối
              </span>
              {!verifiedReceipt && (
                <small>
                  Đóng hoặc mở lại không gia hạn mã. Cà Rem chỉ xác nhận khi ngân
                  hàng báo tiền đã vào đúng tài khoản.
                </small>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
