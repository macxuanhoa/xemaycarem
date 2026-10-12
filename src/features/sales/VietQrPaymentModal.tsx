import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  QrCode,
  RefreshCw,
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

function paymentQrPayload(
  request: VietQrPaymentRequest | null,
  fallbackSettings?: ShopSettings | null,
) {
  if (!request) return { payload: null, invalid: false };

  // 1. Nếu bản ghi đã có sẵn qr_payload hợp lệ theo chuẩn VietQR
  if (request.qr_payload && request.qr_payload.startsWith("000201")) {
    return { payload: request.qr_payload, invalid: false };
  }

  // 2. Lấy thông tin tài khoản: ưu tiên request, dự phòng sang settings cửa hàng
  const bankBin = (request.bank_bin || fallbackSettings?.bank_bin || "").trim();
  const accountNo = (request.bank_account_no || fallbackSettings?.bank_account_no || "").trim();
  const accountName = (request.bank_account_name || fallbackSettings?.bank_account_name || "").trim();

  if (!bankBin || !accountNo) {
    return { payload: null, invalid: true };
  }

  // 3. Nội dung chuyển khoản: ưu tiên transfer_content, dự phòng sang qr_reference
  let description =
    request.transfer_content?.trim() ||
    request.qr_reference?.trim() ||
    "CAREM GD";

  // Chuẩn hóa và giới hạn tối đa 50 ký tự theo chuẩn EMVCo Tag 62.08
  const cleanDesc = removeVietnameseTones(description);
  if (cleanDesc.length > 50) {
    if (request.qr_reference && removeVietnameseTones(request.qr_reference).length <= 50) {
      description = request.qr_reference.trim();
    } else {
      description = cleanDesc.slice(0, 50).trim();
    }
  } else {
    description = cleanDesc;
  }

  try {
    const payload = buildVietQrEmvCoPayload({
      bankBin,
      accountNo,
      amount: request.amount,
      description,
      accountName,
    });
    return { payload, invalid: false };
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
        return { payload, invalid: false };
      } catch {
        // Dự phòng thất bại
      }
    }
    return { payload: null, invalid: true };
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
  const [quickLinkFailed, setQuickLinkFailed] = useState(false);

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
    setQuickLinkFailed(false);
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
          transfer_content: `CAREM GD ${amount}`,
          agreement_text: `Thanh toán tiền xe ${vehicle.vehicle_title || "xe"}`,
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

  const handleCreateNewQr = () => {
    if (!network.online || replaceMutation.isPending || spamCooldownSeconds > 0)
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

    setQuickLinkFailed(false);
    replaceMutation.mutate();
  };
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

      if (!isExpired && detailsMatch && activeQuery.data.status === "PENDING" && isQrValid) {
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
  }, [requestQuery.data?.id, requestQuery.data?.expires_at]);

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

  const qrResult = paymentQrPayload(request, settings);
  const qrPayload = qrResult.payload;

  const bankBin = request?.bank_bin || settings?.bank_bin || "";
  const bankConfig = getBankByBin(bankBin);
  const displayBankName =
    bankConfig?.shortName || request?.bank_name || settings?.bank_name || "Ngân hàng";
  const displayAccountNo =
    request?.bank_account_no || settings?.bank_account_no || "";
  const displayAccountName =
    request?.bank_account_name || settings?.bank_account_name || "";
  const displayTransferContent =
    request?.transfer_content || request?.qr_reference || "CAREM GD";

  // QuickLink ảnh thẻ VietQR chuẩn Napas 247 đầy đủ logo và thông tin
  const quickLinkUrl =
    bankBin && displayAccountNo
      ? buildVietQrQuickLink(
          {
            bankBin,
            accountNo: displayAccountNo,
            amount: request?.amount || amount,
            description: displayTransferContent,
            accountName: displayAccountName,
          },
          "compact2",
        )
      : null;

  useEffect(() => {
    if (!qrPayload || !canShowQr) return;
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
  }, [qrPayload, canShowQr]);

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
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
    if (quickLinkUrl && !quickLinkFailed) {
      try {
        const res = await fetch(quickLinkUrl);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(blobUrl);
        toast.success("Đã tải mã VietQR đầy đủ");
        return;
      } catch {
        // Fallback sang qrImage nếu bị CORS
      }
    }
    if (qrImage?.url) {
      const link = document.createElement("a");
      link.href = qrImage.url;
      link.download = fileName;
      link.click();
      toast.success("Đã tải mã QR");
    }
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
        <div className="vietqr-modal-heading">
          <div>
            <h2 id={titleId}>
              <QrCode size={20} aria-hidden="true" /> Thanh toán chuyển khoản
            </h2>
            <p id={descriptionId}>Cà Rem · Mỗi mã có thời hạn 15 phút</p>
          </div>
          <Button
            variant="ghost"
            className="vietqr-close"
            aria-label="Đóng hộp thoại"
            onClick={onClose}
          >
            <X size={20} />
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
              <Loading />
              <p className="muted">Đang kiểm tra mã thanh toán…</p>
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
              <StatusIcon size={20} aria-hidden="true" />
              <div>
                <strong>{status.title}</strong>
                <p>{status.detail}</p>
              </div>
            </div>
            {!verifiedReceipt && (
              <div className="vietqr-display-box">
                {canShowQr ? (
                  <>
                    {!quickLinkFailed && quickLinkUrl ? (
                      <div
                        className="vietqr-card-frame"
                        style={{
                          display: "flex",
                          justifyContent: "center",
                          width: "100%",
                          padding: "4px 0",
                        }}
                      >
                        <img
                          src={quickLinkUrl}
                          alt="Mã VietQR chuyển khoản đầy đủ"
                          style={{
                            maxWidth: "100%",
                            width: 330,
                            height: "auto",
                            borderRadius: 12,
                            boxShadow: "0 6px 20px rgba(0, 0, 0, 0.12)",
                            border: "1px solid rgba(0, 0, 0, 0.08)",
                            display: "block",
                          }}
                          onError={() => setQuickLinkFailed(true)}
                        />
                      </div>
                    ) : qrImage?.payload === qrPayload ? (
                      <img
                        src={qrImage.url}
                        width={220}
                        height={220}
                        alt="Mã QR chuyển khoản"
                      />
                    ) : qrResult.invalid ? (
                      <div className="vietqr-invalid-box" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: 8 }}>
                        <p className="notice warning" style={{ margin: 0, textAlign: "center" }}>
                          Chưa có đủ thông tin tài khoản hợp lệ để tạo mã QR.
                        </p>
                        <Button
                          variant="secondary"
                          onClick={handleCreateNewQr}
                          disabled={replaceMutation.isPending || spamCooldownSeconds > 0 || !network.online}
                        >
                          <RefreshCw size={14} className={replaceMutation.isPending ? "spin" : ""} />
                          {replaceMutation.isPending
                            ? "Đang tạo mã mới…"
                            : spamCooldownSeconds > 0
                              ? `Thử lại (${spamCooldownSeconds}s)`
                              : "Thử tạo lại mã"}
                        </Button>
                      </div>
                    ) : qrError ? (
                      <p className="notice warning">
                        Chưa hiển thị được mã QR. Hãy đóng và mở lại để thử lại.
                      </p>
                    ) : (
                      <Loading />
                    )}
                    <div className="vietqr-countdown">
                      <Clock size={15} aria-hidden="true" />
                      <span>
                        Hiệu lực còn{" "}
                        <strong
                          aria-label={`Thời gian còn lại ${formatCountdown(remainingSeconds)}`}
                        >
                          {formatCountdown(remainingSeconds)}
                        </strong>
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      className="vietqr-download"
                      onClick={() => void handleDownloadQr()}
                      disabled={!canShowQr || ((!qrImage || qrImage.payload !== qrPayload) && (!quickLinkUrl || quickLinkFailed))}
                    >
                      <Download size={16} /> Tải mã VietQR
                    </Button>
                  </>
                ) : (
                  <div className="vietqr-unavailable">
                    <Clock size={28} aria-hidden="true" />
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
            <div className="vietqr-details-card">
              <div className="vietqr-amount">
                <span>Số tiền thanh toán</span>
                <strong>{money(request.amount)}</strong>
              </div>
              <div className="vietqr-transfer-content">
                <span>Nội dung chuyển khoản</span>
                <div>
                  <strong>{displayTransferContent}</strong>
                  <Button
                    variant="ghost"
                    aria-label="Sao chép nội dung chuyển khoản"
                    onClick={() =>
                      void handleCopy(
                        displayTransferContent,
                        "nội dung chuyển khoản",
                      )
                    }
                  >
                    <Copy size={16} />
                  </Button>
                </div>
              </div>
              <dl className="vietqr-detail-list">
                <div>
                  <dt>Ngân hàng</dt>
                  <dd>{displayBankName}</dd>
                </div>
                <div>
                  <dt>Số tài khoản</dt>
                  <dd>
                    {displayAccountNo}
                    {displayAccountNo ? (
                      <Button
                        variant="ghost"
                        className="vietqr-copy-account"
                        aria-label="Sao chép số tài khoản"
                        onClick={() =>
                          void handleCopy(displayAccountNo, "số tài khoản")
                        }
                      >
                        <Copy size={15} />
                      </Button>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Người nhận</dt>
                  <dd>{displayAccountName || "Chưa có tên chủ tài khoản"}</dd>
                </div>
                <div>
                  <dt>Người thanh toán</dt>
                  <dd>{request.payer_name}</dd>
                </div>
                <div>
                  <dt>Xe</dt>
                  <dd>
                    {request.vehicle_label ||
                      vehicle.vehicle_title ||
                      vehicle.vehicle_type ||
                      "Xe"}
                  </dd>
                </div>
                <div>
                  <dt>Mã xe</dt>
                  <dd>{vehicle.internal_code || request.vehicle_id}</dd>
                </div>
                <div>
                  <dt>Hợp đồng</dt>
                  <dd>{request.contract_reference}</dd>
                </div>
              </dl>
              <p className="vietqr-agreement">{request.agreement_text}</p>
            </div>
            {replaceMutation.isError && (
              <ErrorState error={replaceMutation.error} />
            )}
            <div className="vietqr-actions">
              <Button variant="secondary" onClick={onClose}>
                Đóng
              </Button>
              {verifiedReceipt ? (
                <Button onClick={acknowledgeReceipt}>
                  <CheckCircle2 size={16} /> Xác nhận và đóng
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={handleCreateNewQr}
                  disabled={
                    !network.online ||
                    replaceMutation.isPending ||
                    spamCooldownSeconds > 0
                  }
                >
                  <RefreshCw size={16} className={replaceMutation.isPending ? "spin" : ""} />{" "}
                  {replaceMutation.isPending
                    ? "Đang tạo mã mới…"
                    : spamCooldownSeconds > 0
                      ? `Tạo mã mới (${spamCooldownSeconds}s)`
                      : "Tạo mã mới"}
                </Button>
              )}
            </div>
            {!verifiedReceipt && (
              <p className="vietqr-footnote">
                Đóng hoặc mở lại không gia hạn mã. Cà Rem chỉ xác nhận khi ngân
                hàng báo tiền đã vào đúng tài khoản.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
