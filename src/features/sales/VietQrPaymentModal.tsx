import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Image as ImageIcon,
  QrCode,
  X,
} from "lucide-react";
import { Button, ErrorState, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { getBankByBin } from "@/lib/vietqr/banks";
import {
  buildVietQrEmvCoPayload,
  buildVietQrQuickLink,
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

export function VietQrPaymentModal({
  vehicle,
  saleId,
  saleCode,
  amount,
  onClose,
  onPaymentConfirmed,
}: {
  vehicle: VehicleSummary;
  saleId?: string;
  saleCode?: string;
  amount: number;
  onClose: () => void;
  onPaymentConfirmed?: (paymentIdOrRef: string) => void;
}) {
  const client = useQueryClient();
  const [request, setRequest] = useState<VietQrPaymentRequest | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [viewCardMode, setViewCardMode] = useState(false);
  const [supersededWarning, setSupersededWarning] = useState(false);

  // 1. Kiểm tra cấu hình ngân hàng của cửa hàng
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<ShopSettings>("get_settings"),
  });

  const settings = settingsQuery.data;
  const isConfigured = !!(
    settings?.vietqr_enabled &&
    settings?.bank_bin &&
    settings?.bank_account_no
  );

  // 2. Mutation tạo hoặc lấy yêu cầu VietQR động
  const createMutation = useMutation({
    mutationFn: async () => {
      if (!isConfigured) return null;
      // Sinh payload EMVCo tạm thời phía client
      const emvCo = buildVietQrEmvCoPayload({
        bankBin: settings.bank_bin!,
        accountNo: settings.bank_account_no!,
        amount,
        description: "CAREM DRAFT",
        accountName: settings.bank_account_name,
      });

      return api.createVietQrPaymentRequest({
        vehicle_id: vehicle.id,
        sale_id: saleId,
        amount,
        qr_payload: emvCo,
      });
    },
    onSuccess: (data) => {
      if (!data) return;
      setRequest(data);
      if (data.superseded) {
        setSupersededWarning(true);
      }
    },
  });

  // Tự động tạo mã QR khi settings đã tải xong
  useEffect(() => {
    if (settingsQuery.isSuccess && isConfigured && !request && !createMutation.isPending) {
      createMutation.mutate();
    }
  }, [settingsQuery.isSuccess, isConfigured, request, createMutation]);

  // 3. Render mã QR khi có request hợp lệ
  useEffect(() => {
    if (!request || !settings?.bank_bin || !settings?.bank_account_no) return;

    const payload = buildVietQrEmvCoPayload({
      bankBin: request.bank_bin,
      accountNo: request.bank_account_no,
      amount: request.amount,
      description: request.qr_reference,
      accountName: request.bank_account_name,
    });

    renderQrToDataUrl(payload, 300)
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(null));
  }, [request, settings]);

  // 4. Mutation xác nhận đã nhận tiền
  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!request) throw new Error("Chưa có yêu cầu thanh toán hợp lệ.");
      return api.confirmVietQrPayment({
        qr_request_id: request.id,
        notes: `Khách quét chuyển khoản VietQR ${request.qr_reference}`,
      });
    },
    onSuccess: async (paymentId) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["sale"] }),
        client.invalidateQueries({ queryKey: ["sales"] }),
        client.invalidateQueries({ queryKey: ["receivables"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      toast.success("Đã xác nhận tiền vào tài khoản thành công!");
      if (request) {
        setRequest({ ...request, status: "CONFIRMED", payment_id: paymentId });
      }
      onPaymentConfirmed?.(paymentId);
    },
  });

  // 5. Mutation hủy yêu cầu QR
  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!request) return;
      return api.cancelVietQrPaymentRequest(request.id, "USER_CLOSED_MODAL");
    },
    onSuccess: () => {
      toast.info("Đã hủy yêu cầu thanh toán VietQR.");
      onClose();
    },
  });

  // Live-match: soi xem webhook ngân hàng đã phát hiện tiền về cho QR này chưa.
  // Chỉ hiển thị trạng thái (không lộ số tiền từ phía ngân hàng) — chống suy luận giá.
  const matchQuery = useQuery({
    queryKey: ["vietqr-match", request?.id],
    queryFn: () => api.getVietQrMatchingStatus(request!.id),
    enabled: !!request && request.status === "PENDING",
    refetchInterval: 15_000,
  });
  const bankState = matchQuery.data?.state;

  const handleConfirmPayment = async () => {
    if (!request) return;
    const ok = await confirmAction({
      title: "Xác nhận tiền đã vào tài khoản?",
      description: `Kiểm tra ứng dụng ngân hàng đã nhận đúng số tiền ${money(request.amount)} với nội dung "${request.qr_reference}" trước khi xác nhận.`,
      confirmLabel: "Đã nhận tiền, xác nhận",
      cancelLabel: "Chưa nhận được, kiểm tra lại",
    });
    if (ok) {
      confirmMutation.mutate();
    }
  };
  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    toast.success(`Đã sao chép ${label}: ${text}`);
  };

  const handleDownloadQr = () => {
    if (!qrDataUrl || !request) return;
    const link = document.createElement("a");
    link.href = qrDataUrl;
    link.download = `VietQR-${request.qr_reference.replace(/\s+/g, "_")}.png`;
    link.click();
    toast.success("Đã tải mã QR về máy.");
  };

  const selectedBank = settings?.bank_bin ? getBankByBin(settings.bank_bin) : undefined;
  const quickLinkUrl =
    request && settings?.bank_bin && settings?.bank_account_no
      ? buildVietQrQuickLink(
          {
            bankBin: request.bank_bin,
            accountNo: request.bank_account_no,
            amount: request.amount,
            description: request.qr_reference,
            accountName: request.bank_account_name,
          },
          "compact2",
        )
      : null;

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="dialog-panel vietqr-modal-panel"
        style={{ width: "min(520px, 100%)", padding: "20px" }}
      >
        <div className="row between gap-sm" style={{ marginBottom: "16px" }}>
          <div>
            <h2 className="section-title" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <QrCode size={20} color="var(--brand-emerald-dark, #059669)" />
              Thanh toán VietQR động
            </h2>
            <p className="muted small" style={{ margin: "2px 0 0" }}>
              Cà Rem CRM · Quét mã chuyển nhanh Napas 24/7
            </p>
          </div>
          <button
            type="button"
            className="button ghost"
            style={{ padding: "6px" }}
            aria-label="Đóng hộp thoại"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        {/* Chưa cấu hình tài khoản nhận tiền */}
        {settingsQuery.isSuccess && !isConfigured && (
          <div className="stack" style={{ gap: 14 }}>
            <div
              className="notice warning"
              style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "14px" }}
            >
              <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>Chưa cấu hình tài khoản nhận tiền</strong>
                <p style={{ margin: "4px 0 0", fontSize: "0.875rem" }}>
                  Để tự tạo mã VietQR theo từng giao dịch, chủ cửa hàng cần vào
                  Cài đặt để cấu hình thông tin ngân hàng và bật tính năng VietQR.
                </p>
              </div>
            </div>
            <div className="form-actions" style={{ marginTop: 8 }}>
              <Button variant="secondary" onClick={onClose}>
                Đóng
              </Button>
              <Link className="button" to="/settings" onClick={onClose}>
                Vào Cài đặt thanh toán <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        )}

        {/* Đang tải cấu hình hoặc đang tạo mã */}
        {(settingsQuery.isPending || createMutation.isPending) && (
          <div style={{ padding: "30px 0", textAlign: "center" }}>
            <Loading />
            <p className="muted" style={{ marginTop: 10 }}>Đang tạo mã VietQR động theo giao dịch…</p>
          </div>
        )}

        {/* Lỗi tạo mã */}
        {createMutation.isError && (
          <div className="stack">
            <ErrorState error={createMutation.error} />
            <Button variant="secondary" onClick={() => createMutation.mutate()}>
              Thử tạo lại mã QR
            </Button>
          </div>
        )}

        {/* Đã có request VietQR hợp lệ */}
        {request && (
          <div className="stack" style={{ gap: 16 }}>
            {/* Cảnh báo hủy QR cũ nếu số tiền vừa thay đổi */}
            {supersededWarning && (
              <div
                className="notice warning"
                style={{ fontSize: "0.8125rem", padding: "10px 12px", display: "flex", gap: 8, alignItems: "flex-start" }}
              >
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  <strong>Số tiền thanh toán đã thay đổi:</strong> Mã VietQR cũ đã
                  được hệ thống tự động hủy hiệu lực. Nếu khách quét mã cũ, hãy đối
                  soát thủ công.
                </span>
              </div>
            )}

            {/* Trạng thái thanh toán */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                borderRadius: "6px",
                background: request.status === "CONFIRMED" ? "rgba(16, 185, 129, 0.1)" : "rgba(245, 158, 11, 0.1)",
                border: `1px solid ${request.status === "CONFIRMED" ? "rgba(16, 185, 129, 0.3)" : "rgba(245, 158, 11, 0.3)"}`,
              }}
            >
              <span style={{ fontSize: "0.875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6, color: request.status === "CONFIRMED" ? "#047857" : "#b45309" }}>
                {request.status === "CONFIRMED" ? (
                  <>
                    <CheckCircle2 size={16} /> Đã nhận tiền thành công
                  </>
                ) : (
                  <>
                    <Clock size={16} /> Đang chờ khách quét mã & chuyển khoản
                  </>
                )}
              </span>
              <span className="small muted">
                {saleCode ? `Đơn ${saleCode}` : (vehicle.license_plate ? `Biển ${vehicle.license_plate}` : vehicle.internal_code || "Bán xe")}
              </span>
            </div>

            {/* Cờ hiệu đối soát ngân hàng — xác nhận webhook đã thấy tiền về */}
            {request.status === "PENDING" && bankState && bankState !== "NONE" && (
              <div
                className="notice"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  fontSize: "0.8125rem",
                  border: "1px solid rgba(16,185,129,0.35)",
                  background: "rgba(16,185,129,0.08)",
                  color: "#047857",
                }}
                role="status"
              >
                <CheckCircle2 size={18} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {bankState === "MATCHED" && (
                    <>
                      <strong>Ngân hàng báo tiền đã về</strong> và khớp mã{" "}
                      <code>{request.qr_reference}</code>. Bạn có thể bấm xác nhận
                      ghi nhận, hoặc để đối soát tự động xử lý.
                    </>
                  )}
                  {bankState === "REVIEW" && (
                    <>
                      <strong>Đã thấy giao dịch nhưng cần rà soát</strong> (có thể
                      lệch số tiền). Hãy kiểm tra lại trước khi ghi nhận.
                    </>
                  )}
                  {bankState === "RECORDED" && (
                    <>
                      <strong>Giao dịch này đã được ghi nhận</strong> qua đối soát
                      ngân hàng. Không cần xác nhận thủ công lần nữa.
                    </>
                  )}
                </span>
              </div>
            )}

            {/* Vùng hiển thị QR Code */}
            <div
              className="vietqr-display-box"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                background: "#ffffff",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid var(--border-soft, #e2e8f0)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.04)",
              }}
            >
              {viewCardMode && quickLinkUrl ? (
                <img
                  src={quickLinkUrl}
                  alt="Thẻ VietQR có logo"
                  style={{ width: "100%", maxWidth: 320, borderRadius: 8 }}
                />
              ) : qrDataUrl ? (
                <div style={{ textAlign: "center" }}>
                  <img
                    src={qrDataUrl}
                    alt="Mã VietQR động"
                    style={{ width: 220, height: 220, margin: "0 auto", display: "block" }}
                  />
                  <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: 4 }}>
                    Quét bằng ứng dụng của bất kỳ ngân hàng nào
                  </div>
                </div>
              ) : (
                <Loading />
              )}

              {/* Toggle chế độ xem thẻ / mã đơn */}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  className={`button ghost small ${!viewCardMode ? "active" : ""}`}
                  style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                  onClick={() => setViewCardMode(false)}
                >
                  <QrCode size={13} /> Mã QR đơn
                </button>
                {quickLinkUrl && (
                  <button
                    type="button"
                    className={`button ghost small ${viewCardMode ? "active" : ""}`}
                    style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                    onClick={() => setViewCardMode(true)}
                  >
                    <ImageIcon size={13} /> Thẻ có logo ngân hàng
                  </button>
                )}
                <button
                  type="button"
                  className="button ghost small"
                  style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                  onClick={handleDownloadQr}
                >
                  <Download size={13} /> Tải mã QR
                </button>
              </div>
            </div>

            {/* Thông tin chuyển khoản chi tiết */}
            <div
              className="vietqr-details-card"
              style={{
                background: "var(--surface-sunken, #f8fafc)",
                padding: "14px",
                borderRadius: "8px",
                border: "1px solid var(--border-soft, #e2e8f0)",
                fontSize: "0.875rem",
              }}
            >
              {/* Số tiền cần thanh toán */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingBottom: "10px",
                  borderBottom: "1px solid #e2e8f0",
                  marginBottom: "10px",
                }}
              >
                <span style={{ color: "#64748b" }}>Số tiền thanh toán:</span>
                <strong style={{ fontSize: "1.25rem", color: "var(--brand-emerald-dark, #059669)", fontVariantNumeric: "tabular-nums" }}>
                  {money(request.amount)}
                </strong>
              </div>

              {/* Nội dung chuyển khoản duy nhất */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingBottom: "10px",
                  borderBottom: "1px solid #e2e8f0",
                  marginBottom: "10px",
                }}
              >
                <div>
                  <span style={{ color: "#64748b", display: "block", fontSize: "0.75rem" }}>
                    Nội dung chuyển khoản (bắt buộc):
                  </span>
                  <strong style={{ fontSize: "1rem", color: "#0f172a", letterSpacing: "0.5px" }}>
                    {request.qr_reference}
                  </strong>
                </div>
                <Button
                  variant="secondary"
                  className="small"
                  onClick={() => handleCopy(request.qr_reference, "Nội dung chuyển khoản")}
                >
                  <Copy size={13} /> Sao chép
                </Button>
              </div>

              {/* Ngân hàng và số tài khoản */}
              <div className="stack" style={{ gap: 6, fontSize: "0.8125rem", color: "#334155" }}>
                <div className="row between">
                  <span className="muted">Ngân hàng thụ hưởng:</span>
                  <strong>{selectedBank ? selectedBank.shortName : request.bank_name}</strong>
                </div>
                <div className="row between">
                  <span className="muted">Số tài khoản:</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <strong>{request.bank_account_no}</strong>
                    <button
                      type="button"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "#64748b" }}
                      aria-label="Sao chép số tài khoản"
                      onClick={() => handleCopy(request.bank_account_no, "Số tài khoản")}
                    >
                      <Copy size={12} />
                    </button>
                  </span>
                </div>
                <div className="row between">
                  <span className="muted">Chủ tài khoản:</span>
                  <strong>{request.bank_account_name}</strong>
                </div>
              </div>
            </div>

            {/* Lưu ý nghiệp vụ */}
            <p className="muted small" style={{ margin: 0, lineHeight: 1.4 }}>
              * Khách quét mã chuyển tiền qua App ngân hàng. Sau khi kiểm tra tiền
              đã vào tài khoản, chủ cửa hàng bấm nút bên dưới để hoàn tất ghi nhận.
            </p>

            {confirmMutation.isError && <ErrorState error={confirmMutation.error} />}

            {/* Các nút hành động */}
            <div className="form-actions" style={{ marginTop: 4 }}>
              <Button
                variant="secondary"
                disabled={confirmMutation.isPending || cancelMutation.isPending}
                onClick={onClose}
              >
                Đóng
              </Button>

              {request.status !== "CONFIRMED" && (
                <Button
                  disabled={confirmMutation.isPending}
                  onClick={handleConfirmPayment}
                >
                  <CheckCircle2 size={16} />
                  {confirmMutation.isPending ? "Đang ghi nhận…" : "Xác nhận đã nhận tiền"}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
