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
import { buildVietQrEmvCoPayload, renderQrToDataUrl } from "@/lib/vietqr/emvco";
import type { VietQrPaymentRequest } from "@/types";

type ShopSettings = {
  bank_bin?: string;
  bank_account_no?: string;
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

function paymentQrPayload(request: VietQrPaymentRequest | null) {
  if (!request) return { payload: null, invalid: false };
  if (!request.transfer_content) return { payload: null, invalid: true };
  try {
    return {
      payload: buildVietQrEmvCoPayload({
        bankBin: request.bank_bin,
        accountNo: request.bank_account_no,
        amount: request.amount,
        description: request.transfer_content,
        accountName: request.bank_account_name,
      }),
      invalid: false,
    };
  } catch {
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
  const [, refreshClock] = useState(0);
  const [serverClock, setServerClock] = useState<{
    id: string;
    serverMs: number;
    monotonicMs: number;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(
      () => refreshClock((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<ShopSettings>("get_settings"),
  });
  const settings = settingsQuery.data;
  const isConfigured = !!(
    settings?.vietqr_enabled &&
    settings.bank_bin &&
    settings.bank_account_no
  );

  // Load the existing request before creating one. Reopening an expired request
  // must never create a fresh 15-minute window implicitly.
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
    const serverNow = Date.parse(data.server_now);
    setServerClock(
      Number.isFinite(serverNow)
        ? { id: data.id, serverMs: serverNow, monotonicMs: performance.now() }
        : null,
    );
  };
  const createMutation = useMutation({
    mutationFn: () =>
      api.createVietQrPaymentRequest({
        vehicle_id: vehicle.id,
        sale_id: saleId,
        amount,
        payer_name: payerName,
        contract_reference: saleCode,
      }),
    onSuccess: selectRequest,
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
    if (activeQuery.data) selectRequest(activeQuery.data);
    else createMutation.mutate();
  }, [
    network.online,
    isConfigured,
    activeQuery.isFetchedAfterMount,
    activeQuery.isSuccess,
    activeQuery.data,
    createMutation,
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
    const serverNow = Date.parse(requestQuery.data.server_now);
    setServerClock(
      Number.isFinite(serverNow)
        ? {
            id: requestQuery.data.id,
            serverMs: serverNow,
            monotonicMs: performance.now(),
          }
        : null,
    );
  }, [requestQuery.data, requestQuery.dataUpdatedAt]);

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

  // A monotonic clock preserves the server deadline even if the workstation's
  // date or timezone changes while this dialog is open.
  const serverNow = serverClock
    ? serverClock.serverMs + performance.now() - serverClock.monotonicMs
    : NaN;
  const expiresAt = request ? Date.parse(request.expires_at) : NaN;
  const replacementAt = request
    ? Date.parse(request.replace_available_at)
    : NaN;
  const hasServerTime =
    !!request && serverClock?.id === request.id && Number.isFinite(expiresAt);
  const remainingSeconds = hasServerTime
    ? Math.max(0, Math.ceil((expiresAt - serverNow) / 1_000))
    : 0;
  const cooldownSeconds =
    hasServerTime && Number.isFinite(replacementAt)
      ? Math.max(0, Math.ceil((replacementAt - serverNow) / 1_000))
      : 0;
  const expired =
    !!request &&
    (request.status === "EXPIRED" || (hasServerTime && remainingSeconds === 0));
  const canShowQr =
    !!request &&
    request.status === "PENDING" &&
    hasServerTime &&
    !expired &&
    !verifiedReceipt;
  const changedDetails =
    !!request &&
    (request.amount !== amount ||
      (!!payerName?.trim() && request.payer_name !== payerName.trim()));

  const replaceMutation = useMutation({
    mutationFn: () =>
      api.replaceVietQrPaymentRequest(request!.id, {
        amount,
        payer_name: payerName,
        contract_reference: saleCode,
      }),
    onSuccess: (data) => {
      selectRequest(data);
      toast.info("Đã tạo mã QR mới", {
        description: "Mã trước đã hết hiệu lực trên Cà Rem.",
      });
    },
  });
  const qrResult = paymentQrPayload(request);
  const qrPayload = qrResult.payload;
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
  const handleDownloadQr = () => {
    if (!canShowQr || !qrImage || qrImage.payload !== qrPayload || !request)
      return;
    const link = document.createElement("a");
    link.href = qrImage.url;
    link.download = `VietQR-${request.qr_reference.replace(/\s+/g, "_")}.png`;
    link.click();
    toast.success("Đã tải mã QR");
  };
  const acknowledgeReceipt = () => {
    if (!request || !verifiedReceipt) return;
    onPaymentConfirmed?.(request);
    onClose();
  };
  const selectedBank = request ? getBankByBin(request.bank_bin) : undefined;
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
              <strong>Chưa cấu hình tài khoản nhận tiền</strong>
              <p>
                Vào Cài đặt thanh toán để bật VietQR và chọn tài khoản ngân
                hàng.
              </p>
            </div>
            <Link className="button" to="/settings" onClick={onClose}>
              Cài đặt thanh toán <ArrowRight size={15} />
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
                    {qrImage?.payload === qrPayload ? (
                      <img
                        src={qrImage.url}
                        width={220}
                        height={220}
                        alt="Mã QR chuyển khoản"
                      />
                    ) : qrResult.invalid ? (
                      <p className="notice warning">
                        Thông tin mã QR cũ không hợp lệ. Hãy tạo mã mới để tiếp
                        tục.
                      </p>
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
                      onClick={handleDownloadQr}
                      disabled={!qrImage || qrImage.payload !== qrPayload}
                    >
                      <Download size={16} /> Tải mã QR
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
              <dl className="vietqr-detail-list">
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
                <div>
                  <dt>Người thanh toán</dt>
                  <dd>{request.payer_name}</dd>
                </div>
                <div>
                  <dt>Người nhận</dt>
                  <dd>{request.bank_account_name}</dd>
                </div>
                <div>
                  <dt>Ngân hàng</dt>
                  <dd>{selectedBank?.shortName || request.bank_name}</dd>
                </div>
                <div>
                  <dt>Số tài khoản</dt>
                  <dd>
                    {request.bank_account_no}
                    <Button
                      variant="ghost"
                      className="vietqr-copy-account"
                      aria-label="Sao chép số tài khoản"
                      onClick={() =>
                        void handleCopy(request.bank_account_no, "số tài khoản")
                      }
                    >
                      <Copy size={15} />
                    </Button>
                  </dd>
                </div>
              </dl>
              <div className="vietqr-transfer-content">
                <span>Nội dung chuyển khoản</span>
                <div>
                  <strong>{request.transfer_content}</strong>
                  <Button
                    variant="ghost"
                    aria-label="Sao chép nội dung chuyển khoản"
                    onClick={() =>
                      void handleCopy(
                        request.transfer_content,
                        "nội dung chuyển khoản",
                      )
                    }
                  >
                    <Copy size={16} />
                  </Button>
                </div>
              </div>
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
                  onClick={() => replaceMutation.mutate()}
                  disabled={
                    !network.online ||
                    replaceMutation.isPending ||
                    !hasServerTime ||
                    !Number.isFinite(replacementAt) ||
                    cooldownSeconds > 0
                  }
                >
                  <RefreshCw size={16} />{" "}
                  {replaceMutation.isPending
                    ? "Đang tạo mã mới…"
                    : cooldownSeconds > 0
                      ? `Tạo mã mới (${cooldownSeconds}s)`
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
