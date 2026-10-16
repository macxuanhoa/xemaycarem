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
import { vietqrActiveQueryKey } from "./vietqrVerification";
import {
  buildVietQrEmvCoPayload,
  buildVietQrQuickLink,
  renderQrToDataUrl,
} from "@/lib/vietqr/emvco";
import { downloadQrDataUrl } from "@/lib/qrcode";
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
  payerName,
  onClose,
  onPaymentConfirmed,
}: {
  vehicle: VehicleSummary;
  saleId?: string;
  saleCode?: string;
  amount: number;
  payerName?: string;
  onClose: () => void;
  onPaymentConfirmed?: (confirmedRequest: VietQrPaymentRequest) => void;
}) {
  const client = useQueryClient();
  // Vỏ cũ (nền 011a138): panel noir định danh bằng aria-labelledby — giữ nguyên
  // luồng Mac, chỉ mặc định hiển thị ảnh thẻ VietQR chính thống có avt chủ tài
  // khoản như bản cũ, mã QR trơn lùi về nút "Mã QR đơn".
  const titleId = useId();
  const descriptionId = useId();
  const [request, setRequest] = useState<VietQrPaymentRequest | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [viewCardMode, setViewCardMode] = useState(true);
  const [supersededWarning, setSupersededWarning] = useState(false);
  // StrictMode dev effects chạy hai lượt; nếu không chốt, một lần mở cửa sổ
  // sẽ POST create hai lần — server replay thì vô hại nhưng để máy lẻ một
  // lượt hỏi là nghĩa vụ của client.
  const issuanceStarted = useRef(false);

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
        payer_name: payerName,
        qr_payload: emvCo,
      });
    },
    onSuccess: (data) => {
      if (!data) return;
      setRequest(data);
      if (data.superseded) {
        setSupersededWarning(true);
      }
      // Vòng theo dõi cấp trang (useVietQrPaymentWatcher) nhìn bằng cache
      // ["vietqr-active", ...] còn modal Mac chỉ poll matching status của riêng
      // nó. Vừa phát hành mã phải báo watcher tỉnh dậy: nếu không, đóng cửa sổ
      // QR giữa chừng là tiền về thật cũng không còn ai hỏi server nữa.
      void client.invalidateQueries({
        queryKey: vietqrActiveQueryKey(vehicle.id, saleId ?? null),
      });
    },
  });

  // Tự động tạo mã QR khi settings đã tải xong
  useEffect(() => {
    if (
      !issuanceStarted.current &&
      settingsQuery.isSuccess &&
      isConfigured &&
      !request &&
      !createMutation.isPending
    ) {
      issuanceStarted.current = true;
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
      description: request.transfer_content || request.qr_reference,
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
        const confirmed: VietQrPaymentRequest = {
          ...request,
          status: "CONFIRMED",
          payment_id: paymentId,
        };
        setRequest(confirmed);
        onPaymentConfirmed?.(confirmed);
      }
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

  // Tiền về được server tự phát hiện qua webhook. Modal chỉ hỏi "đã ghi nhận chưa"
  // — không bao giờ hỏi lại số tiền, để không lộ giá cho người không có quyền.
  const matchQuery = useQuery({
    queryKey: ["vietqr-match", request?.id],
    queryFn: () => api.getVietQrMatchingStatus(request!.id),
    enabled: !!request && request.status === "PENDING",
    refetchInterval: 6_000,
  });
  const bankState = matchQuery.data?.state;

  // Máy chắc chắn thì máy làm: tiền khớp tuyệt đối trên mã do chủ tạo đã tự vào sổ,
  // màn hình này chỉ việc chuyển sang trạng thái hoàn tất.
  const moneyRecorded = request?.status === "CONFIRMED" || bankState === "RECORDED";
  const moneyPendingApproval = bankState === "MATCHED";
  const moneyNeedsALook = bankState === "REVIEW";

  // Tiền về đổi trạng thái → mọi màn hình đang mở (đơn, công nợ, dashboard, phiếu thu
  // chờ ghi nhận) phải vẽ lại ngay, không chờ người dùng tải lại trang.
  useEffect(() => {
    if (!bankState || bankState === "NONE") return;
    void Promise.all([
      client.invalidateQueries({ queryKey: ["sale"] }),
      client.invalidateQueries({ queryKey: ["sales"] }),
      client.invalidateQueries({ queryKey: ["receivables"] }),
      client.invalidateQueries({ queryKey: ["dashboard"] }),
      client.invalidateQueries({ queryKey: ["payment-receipts"] }),
      client.invalidateQueries({
        queryKey: vietqrActiveQueryKey(vehicle.id, saleId ?? null),
      }),
    ]);
  }, [bankState, client, vehicle.id, saleId]);

  const handleConfirmPayment = async () => {
    if (!request) return;
    const ok = await confirmAction({
      title: "Xác nhận tiền đã vào tài khoản?",
      description: `Kiểm tra ứng dụng ngân hàng đã nhận đúng số tiền ${money(request.amount)} với nội dung "${request.transfer_content || request.qr_reference}" trước khi xác nhận.`,
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
    downloadQrDataUrl(
      qrDataUrl,
      `VietQR-${request.qr_reference.replace(/\s+/g, "_")}.png`,
    );
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
            description: request.transfer_content || request.qr_reference,
            accountName: request.bank_account_name,
          },
          "default2",
        )
      : null;

  return (
    <div
      className="dialog-backdrop vietqr-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="dialog-panel vietqr-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        {/* Vỏ cũ: nền ảnh noir thương hiệu Cà Rem (giữ quyết định "bề mặt noir
            cố định cho cả Light lẫn Dark" — xem docs/DECISIONS.md). */}
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
                  được hệ thống tự động hủy hiệu lực. Nếu khách đã chuyển vào mã cũ,
                  số tiền đó sẽ hiện trên đơn hàng để chủ cửa hàng ghi nhận.
                </span>
              </div>
            )}

            {/* Trạng thái: hoàn tất khi tiền đã vào sổ, kể cả khi máy tự làm */}
            {moneyRecorded ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "16px",
                  borderRadius: "10px",
                  background: "rgba(16, 185, 129, 0.1)",
                  border: "1px solid rgba(16, 185, 129, 0.35)",
                }}
                role="status"
              >
                <CheckCircle2 size={26} style={{ flexShrink: 0, color: "#059669" }} />
                <div>
                  <strong style={{ fontSize: "1.0625rem", color: "#047857" }}>
                    Đã nhận đủ {money(request.amount)}
                  </strong>
                  <p className="small" style={{ margin: "4px 0 0", color: "#047857" }}>
                    {matchQuery.data?.sender_name ? `${matchQuery.data.sender_name} · ` : ""}
                    {matchQuery.data?.transfer_at
                      ? new Date(matchQuery.data.transfer_at).toLocaleString("vi-VN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          day: "2-digit",
                          month: "2-digit",
                        }) + " · "
                      : ""}
                    Tiền đã vào tài khoản và được ghi vào đơn
                    {saleCode ? ` ${saleCode}` : ""}.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    // Màn điện thoại 375px: nhãn chờ và chip đơn phải tự xuống
                    // dòng thay vì đẩy panel tràn ngang.
                    flexWrap: "wrap",
                    gap: "4px 10px",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    background: "rgba(245, 158, 11, 0.1)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      color: "#b45309",
                    }}
                  >
                    <Clock size={16} /> Đang chờ khách chuyển khoản
                  </span>
                  <span className="small muted">
                    {saleCode
                      ? `Đơn ${saleCode}`
                      : vehicle.license_plate
                        ? `Biển ${vehicle.license_plate}`
                        : vehicle.internal_code || "Bán xe"}
                  </span>
                </div>

                {(moneyPendingApproval || moneyNeedsALook) && (
                  <div
                    className="notice"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      fontSize: "0.8125rem",
                      border: moneyNeedsALook
                        ? "1px solid rgba(245,158,11,0.4)"
                        : "1px solid rgba(16,185,129,0.35)",
                      background: moneyNeedsALook
                        ? "rgba(245,158,11,0.08)"
                        : "rgba(16,185,129,0.08)",
                      color: moneyNeedsALook ? "#92400e" : "#047857",
                    }}
                    role="status"
                  >
                    {moneyNeedsALook ? (
                      <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
                    ) : (
                      <CheckCircle2 size={18} style={{ flexShrink: 0, marginTop: 1 }} />
                    )}
                    <span>
                      {moneyPendingApproval ? (
                        <>
                          <strong>Tiền đã về</strong> — khớp mã{" "}
                          <code>{request.qr_reference}</code>. Đang chờ chủ cửa hàng
                          ghi nhận vào đơn.
                        </>
                      ) : (
                        <>
                          <strong>Tiền về chưa khớp</strong> — số chuyển thực tế khác
                          số trên mã. Bạn kiểm tra lại rồi ghi nhận phần đã nhận trên
                          đơn hàng.
                        </>
                      )}
                    </span>
                  </div>
                )}
              </>
            )}


            {/* Tiền đã về rồi thì không đưa mã QR cho khách quét nữa */}
            {!(moneyRecorded || moneyPendingApproval) && (
              <>
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
                      alt="Mã QR chuyển khoản"
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

                  {/* Toggle chế độ xem thẻ / mã đơn — màn 375px không được tràn ngang */}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "center",
                      gap: 8,
                      marginTop: 12,
                    }}
                  >
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
                        {request.transfer_content || request.qr_reference}
                      </strong>
                    </div>
                    <Button
                      variant="secondary"
                      className="small"
                      onClick={() =>
                        handleCopy(
                          request.transfer_content || request.qr_reference,
                          "Nội dung chuyển khoản",
                        )
                      }
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
                  * Khách quét mã và chuyển tiền bằng App ngân hàng. Hệ thống tự nghe
                  tiền về từ ngân hàng: khớp đúng là tự ghi vào đơn và màn hình này
                  chuyển sang trạng thái hoàn tất, không ai phải bấm gì.
                </p>
              </>
            )}

            {confirmMutation.isError && <ErrorState error={confirmMutation.error} />}

            {/* Các nút hành động */}
            <div className="form-actions" style={{ marginTop: 4, flexWrap: "wrap" }}>
              {moneyRecorded ? (
                <>
                  <Button variant="secondary" onClick={onClose}>
                    Đóng
                  </Button>
                  {saleId && (
                    <Link className="button" to={`/sales/${saleId}`} onClick={onClose}>
                      Xem đơn hàng <ArrowRight size={15} />
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    disabled={confirmMutation.isPending || cancelMutation.isPending}
                    onClick={onClose}
                  >
                    Đóng
                  </Button>
                  {/* Đường lùi cho cửa hàng chưa nối ngân hàng: vẫn tự tay ghi nhận được. */}
                  <button
                    type="button"
                    className="button ghost"
                    disabled={confirmMutation.isPending}
                    onClick={handleConfirmPayment}
                  >
                    <CheckCircle2 size={15} />
                    {confirmMutation.isPending
                      ? "Đang ghi nhận…"
                      : "Tôi đã thấy tiền vào app ngân hàng"}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
