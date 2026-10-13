import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, CreditCard, Landmark, QrCode } from "lucide-react";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { VIETNAM_BANKS, getBankByBin } from "@/lib/vietqr/banks";
import {
  buildVietQrQuickLink,
  removeVietnameseTones,
} from "@/lib/vietqr/emvco";

type BankSettings = {
  bank_bin?: string;
  bank_name?: string;
  bank_account_no?: string;
  bank_account_name?: string;
  vietqr_enabled?: boolean;
};

export function PaymentSettingsCard({
  onSaved,
}: {
  onSaved?: (msg: string) => void;
}) {
  const client = useQueryClient();
  const [bankBin, setBankBin] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNo, setAccountNo] = useState("");
  const [accountName, setAccountName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [previewQrUrl, setPreviewQrUrl] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<BankSettings>("get_settings"),
  });

  useEffect(() => {
    if (!q.data || dirty) return;
    setBankBin(q.data.bank_bin || "");
    setBankName(q.data.bank_name || "");
    setAccountNo(q.data.bank_account_no || "");
    setAccountName(q.data.bank_account_name || "");
  }, [q.data, dirty]);

  // Cập nhật preview QR chính thống VietQR mỗi khi thông tin thay đổi hợp lệ
  useEffect(() => {
    if (!bankBin || !accountNo) {
      setPreviewQrUrl(null);
      return;
    }
    try {
      setPreviewQrUrl(
        buildVietQrQuickLink(
          {
            bankBin,
            accountNo,
            description: "CAREM TEST",
            accountName,
          },
          "qr_only",
        ),
      );
    } catch {
      setPreviewQrUrl(null);
    }
  }, [bankBin, accountNo, accountName]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const cleanBin = bankBin.trim();
      const cleanNo = accountNo.trim();
      const cleanName = removeVietnameseTones(accountName).toUpperCase().trim();

      if (!cleanBin) {
        throw new Error("Vui lòng chọn ngân hàng.");
      }
      if (!cleanNo) {
        throw new Error("Vui lòng nhập số tài khoản.");
      }
      if (!cleanName) {
        throw new Error("Vui lòng nhập tên chủ tài khoản.");
      }

      return api.call("save_settings", {
        p_data: {
          vietqr_enabled: true,
          bank_bin: cleanBin,
          bank_name: bankName.trim(),
          bank_account_no: cleanNo,
          bank_account_name: cleanName,
        },
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["settings"] });
      setDirty(false);
      toast.success("Đã lưu tài khoản nhận tiền.");
      onSaved?.("Đã lưu tài khoản nhận tiền.");
    },
  });

  const isConfigured = Boolean(
    q.data?.bank_bin &&
    q.data?.bank_account_no &&
    q.data?.bank_account_name
  );

  const selectedBank = getBankByBin(bankBin);

  const handleSelectBank = (bin: string) => {
    setDirty(true);
    setBankBin(bin);
    const bank = getBankByBin(bin);
    if (bank) {
      setBankName(bank.shortName);
    }
  };

  const handleAccountNameChange = (val: string) => {
    setDirty(true);
    setAccountName(removeVietnameseTones(val).toUpperCase());
  };

  return (
    <Card className="stack">
      <div className="row between wrap gap-sm">
        <div>
          <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CreditCard size={18} /> Tài khoản nhận tiền
          </h2>
          <p className="muted small">
            Dùng để nhận tiền chuyển khoản và tạo mã QR khi bán xe.
          </p>
        </div>
        <div>
          {isConfigured ? (
            <span
              className="badge badge-success"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <CheckCircle2 size={14} /> Đang hoạt động
            </span>
          ) : (
            <span
              className="badge badge-warning"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <AlertCircle size={14} /> Chưa thiết lập
            </span>
          )}
        </div>
      </div>

      <div className="payment-settings-grid">
        <div className="payment-settings-form">
          <Field label="Ngân hàng">
            <select
              value={bankBin}
              onChange={(e) => handleSelectBank(e.target.value)}
            >
              <option value="">-- Chọn ngân hàng --</option>
              <optgroup label="Ngân hàng phổ biến">
                {VIETNAM_BANKS.filter((b) => b.isPopular).map((b) => (
                  <option key={b.bin} value={b.bin}>
                    {b.shortName} — {b.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Ngân hàng khác">
                {VIETNAM_BANKS.filter((b) => !b.isPopular).map((b) => (
                  <option key={b.bin} value={b.bin}>
                    {b.shortName} — {b.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>

          <Field label="Số tài khoản">
            <input
              type="text"
              maxLength={40}
              placeholder="Nhập số tài khoản"
              value={accountNo}
              onChange={(e) => {
                setDirty(true);
                setAccountNo(e.target.value.trim());
              }}
            />
          </Field>

          <Field label="Chủ tài khoản">
            <input
              type="text"
              maxLength={120}
              placeholder="NGUYỄN VĂN A"
              value={accountName}
              onChange={(e) => handleAccountNameChange(e.target.value)}
            />
          </Field>

          {saveMutation.isError && <ErrorState error={saveMutation.error} />}

          <div style={{ marginTop: 4 }}>
            <Button
              disabled={saveMutation.isPending || (!dirty && isConfigured)}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Đang lưu…" : "Lưu thay đổi"}
            </Button>
          </div>
        </div>

        <div className="bank-card-visual" aria-label="Xem trước thẻ tài khoản">
          <div className="bank-card-header">
            <div className="bank-card-brand">
              <div className="bank-card-brand-icon">
                <Landmark size={18} />
              </div>
              <span className="bank-card-brand-name">
                {selectedBank?.shortName || bankName || "Tài khoản nhận"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.85, fontSize: "11px", fontWeight: 600 }}>
              <QrCode size={14} /> VietQR
            </div>
          </div>

          <div className="bank-card-body">
            <div className="bank-card-number-label">Số tài khoản</div>
            <div className="bank-card-number">
              {accountNo || "•••• •••• ••••"}
            </div>
          </div>

          <div className="bank-card-footer">
            <div>
              <div className="bank-card-holder-label">Chủ tài khoản</div>
              <div className="bank-card-holder-name">
                {accountName || "CHƯA THIẾT LẬP"}
              </div>
            </div>

            {previewQrUrl ? (
              <div className="bank-card-qr-box" title="Mã QR quét thanh toán">
                <img
                  src={previewQrUrl}
                  alt="Mã QR"
                  className="bank-card-qr-img"
                />
              </div>
            ) : (
              <div className="bank-card-qr-placeholder" title="Mã QR hiển thị khi đủ thông tin">
                <QrCode size={28} />
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
