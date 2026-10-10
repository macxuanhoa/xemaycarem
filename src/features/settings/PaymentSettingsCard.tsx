import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { VIETNAM_BANKS, getBankByBin } from "@/lib/vietqr/banks";
import {
  buildVietQrEmvCoPayload,
  removeVietnameseTones,
  renderQrToDataUrl,
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
  const [enabled, setEnabled] = useState(false);
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
    setEnabled(!!q.data.vietqr_enabled);
    setBankBin(q.data.bank_bin || "");
    setBankName(q.data.bank_name || "");
    setAccountNo(q.data.bank_account_no || "");
    setAccountName(q.data.bank_account_name || "");
  }, [q.data, dirty]);

  // Cập nhật preview QR mỗi khi thông tin thay đổi hợp lệ
  useEffect(() => {
    if (!bankBin || !accountNo) {
      setPreviewQrUrl(null);
      return;
    }
    try {
      const payload = buildVietQrEmvCoPayload({
        bankBin,
        accountNo,
        amount: 100000,
        description: "CAREM TEST",
        accountName,
      });
      renderQrToDataUrl(payload, 200)
        .then((url) => {
          setPreviewQrUrl(url);
        })
        .catch(() => {
          setPreviewQrUrl(null);
        });
    } catch {
      setPreviewQrUrl(null);
    }
  }, [bankBin, accountNo, accountName]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const cleanBin = bankBin.trim();
      const cleanNo = accountNo.trim();
      const cleanName = removeVietnameseTones(accountName).toUpperCase().trim();

      if (enabled && (!cleanBin || !cleanNo || !cleanName)) {
        throw new Error(
          "Vui lòng chọn ngân hàng, nhập số tài khoản và tên chủ tài khoản trước khi bật VietQR.",
        );
      }

      return api.call("save_settings", {
        p_data: {
          vietqr_enabled: enabled,
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
      toast.success("Đã lưu cấu hình tài khoản nhận tiền.");
      onSaved?.("Đã lưu cấu hình tài khoản nhận tiền VietQR.");
    },
  });

  const isConfigured = !!(
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
    // Tự động chuyển in hoa không dấu chuẩn ngân hàng
    setAccountName(removeVietnameseTones(val).toUpperCase());
  };

  return (
    <Card className="stack">
      <div className="row between wrap gap-sm">
        <div>
          <h2 className="section-title">Tài khoản nhận tiền (VietQR)</h2>
          <p className="muted">
            Cấu hình tài khoản ngân hàng để hệ thống tự động sinh mã VietQR động
            theo từng giao dịch bán xe và thu tiền.
          </p>
        </div>
        <div>
          {isConfigured && q.data?.vietqr_enabled ? (
            <span className="badge badge-success" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <CheckCircle2 size={14} /> VietQR đang bật
            </span>
          ) : (
            <span className="badge badge-warning" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <AlertCircle size={14} /> Chưa cấu hình tài khoản nhận tiền
            </span>
          )}
        </div>
      </div>

      <div className="vietqr-enable-box" style={{ background: "var(--surface-sunken, #f8fafc)", padding: "16px", borderRadius: "8px", border: "1px solid var(--border-soft, #e2e8f0)" }}>
        <label className="checkbox-label" style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setDirty(true);
              setEnabled(e.target.checked);
            }}
          />
          <span>Bật tính năng thanh toán chuyển khoản bằng VietQR động</span>
        </label>
        <p className="muted" style={{ margin: "6px 0 0 28px", fontSize: "0.875rem" }}>
          Khi bật, màn hình Bán xe và Thu tiền sẽ có nút &quot;Tạo mã VietQR&quot; tự
          động gán số tiền và nội dung chuyển khoản duy nhất cho khách quét.
        </p>
      </div>

      <div className="form-grid">
        <Field label="Ngân hàng nhận tiền *">
          <select
            value={bankBin}
            onChange={(e) => handleSelectBank(e.target.value)}
          >
            <option value="">-- Chọn ngân hàng thụ hưởng --</option>
            <optgroup label="Ngân hàng phổ biến">
              {VIETNAM_BANKS.filter((b) => b.isPopular).map((b) => (
                <option key={b.bin} value={b.bin}>
                  {b.shortName} - {b.name} ({b.bin})
                </option>
              ))}
            </optgroup>
            <optgroup label="Các ngân hàng khác">
              {VIETNAM_BANKS.filter((b) => !b.isPopular).map((b) => (
                <option key={b.bin} value={b.bin}>
                  {b.shortName} - {b.name} ({b.bin})
                </option>
              ))}
            </optgroup>
          </select>
        </Field>

        <Field label="Mã BIN ngân hàng (6 số)">
          <input
            type="text"
            maxLength={10}
            value={bankBin}
            placeholder="Ví dụ: 970422"
            onChange={(e) => {
              setDirty(true);
              setBankBin(e.target.value.trim());
            }}
          />
        </Field>
      </div>

      <div className="form-grid">
        <Field label="Số tài khoản nhận tiền *">
          <input
            type="text"
            maxLength={40}
            placeholder="Nhập số tài khoản ngân hàng"
            value={accountNo}
            onChange={(e) => {
              setDirty(true);
              setAccountNo(e.target.value.trim());
            }}
          />
        </Field>

        <Field label="Tên chủ tài khoản (in hoa không dấu) *">
          <input
            type="text"
            maxLength={120}
            placeholder="Ví dụ: NGUYEN VAN A"
            value={accountName}
            onChange={(e) => handleAccountNameChange(e.target.value)}
          />
        </Field>
      </div>

      {/* Xem trước mẫu QR nếu có thông tin */}
      {previewQrUrl && bankBin && accountNo && (
        <div
          className="vietqr-preview-panel"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "20px",
            background: "var(--surface-raised, #ffffff)",
            padding: "16px",
            borderRadius: "8px",
            border: "1px dashed var(--border-soft, #cbd5e1)",
          }}
        >
          <img
            src={previewQrUrl}
            alt="Mã VietQR kiểm tra mẫu"
            style={{ width: 120, height: 120, borderRadius: 6, border: "1px solid #e2e8f0" }}
          />
          <div className="stack" style={{ gap: 4, fontSize: "0.875rem" }}>
            <span style={{ fontWeight: 600, color: "var(--text-main, #0f172a)" }}>
              Xem trước cấu hình VietQR mẫu
            </span>
            <span className="muted">
              Ngân hàng: <strong>{selectedBank ? selectedBank.shortName : bankName || bankBin}</strong> ({bankBin})
            </span>
            <span className="muted">
              Số tài khoản: <strong>{accountNo}</strong>
            </span>
            <span className="muted">
              Chủ tài khoản: <strong>{accountName || "Chưa nhập"}</strong>
            </span>
            <small style={{ color: "var(--brand-emerald-dark, #059669)", marginTop: 4 }}>
              ✓ Mã QR EMVCo hợp lệ, mọi app ngân hàng có thể quét được.
            </small>
          </div>
        </div>
      )}

      {saveMutation.isError && <ErrorState error={saveMutation.error} />}

      <div className="form-actions">
        <Button
          disabled={saveMutation.isPending || (!dirty && isConfigured)}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Đang lưu cấu hình…" : "Lưu cấu hình tài khoản nhận tiền"}
        </Button>
      </div>
    </Card>
  );
}
