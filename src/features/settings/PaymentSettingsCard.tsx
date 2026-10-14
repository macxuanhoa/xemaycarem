import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  CreditCard,
  Landmark,
  Loader2,
  RotateCcw,
  Search,
  TriangleAlert,
  QrCode,
} from "lucide-react";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { VIETNAM_BANKS, getBankByBin, searchBanks, type BankInfo } from "@/lib/vietqr/banks";
import { removeVietnameseTones, renderQrToDataUrl } from "@/lib/vietqr/emvco";
import {
  hasBankSettingsErrors,
  validateBankSettings,
} from "@/lib/vietqr/settingsValidation";

/**
 * Mã xem trước ở Cài đặt KHÔNG được quét để trả tiền. Bản cũ gọi
 * img.vietqr.io với đúng số tài khoản + tên chủ tài khoản thật, nên ai quét
 * được màn hình là chuyển tiền vào cửa hàng với nội dung "CAREM TEST" —
 * giao dịch lạc vào UNMATCHED, và mỗi lần xem trước còn đẩy thông tin tài
 * khoản riêng của OWNER sang một bên thứ ba. Mã minh hoạ giờ vẽ tại máy trên
 * một chuỗi tĩnh, không phải payload EMVCo/Napas.
 */
const DEMO_QR_TEXT = "Cà Rem · Mã minh họa giao diện — không dùng để thanh toán";

type BankSettings = {
  bank_bin?: string;
  bank_name?: string;
  bank_account_no?: string;
  bank_account_name?: string;
  vietqr_enabled?: boolean;
};

/** Gấp 4 chữ số để số tài khoản dễ đọc trên thẻ xem trước. */
function groupAccount(raw: string): string {
  const digits = raw.replace(/\s+/g, "");
  return digits.replace(/(.{4})(?=.)/g, "$1 ");
}

/** So khớp không phân biệt dấu tiếng Việt cho ô tìm ngân hàng. */
function fold(text: string): string {
  return removeVietnameseTones(text).toLowerCase().trim();
}

/**
 * Bộ chọn ngân hàng dạng combobox có tìm kiếm — thay cho <select> 40+ mục
 * rất khó dùng trên điện thoại. Người dùng gõ sẽ lọc ngay theo tên viết tắt,
 * tên đầy đủ, mã BIN hoặc mã ngân hàng (bỏ qua dấu tiếng Việt).
 */
function BankPicker({
  value,
  onSelect,
  invalid,
}: {
  value: string;
  onSelect: (bin: string) => void;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const selected = getBankByBin(value);

  const results = useMemo<BankInfo[]>(() => {
    const q = query.trim();
    if (!q) return VIETNAM_BANKS;
    return searchBanks(q).length
      ? searchBanks(q)
      : VIETNAM_BANKS.filter(
          (b) => fold(b.shortName).includes(fold(q)) || fold(b.name).includes(fold(q)),
        );
  }, [query]);

  // Đóng là trả lại tiêu điểm cho nút trigger — nếu không, bàn phím mất con trỏ
  // đúng chỗ người dùng vừa rời khỏi (WCAG 2.4.3).
  const closePicker = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setActive(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) closePicker(true);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, closePicker]);

  const commit = (bin: string) => {
    onSelect(bin);
    setOpen(false);
    setQuery("");
    setActive(-1);
    triggerRef.current?.focus();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((p) => Math.min(p + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((p) => Math.max(p - 1, 0));
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(results.length ? 0 : -1);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(results.length ? results.length - 1 : -1);
    } else if (e.key === "Enter") {
      if (open && active >= 0 && results[active]) {
        e.preventDefault();
        commit(results[active].bin);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePicker(true);
    }
  };

  const activeBank = active >= 0 ? results[active] : undefined;

  return (
    <div className="bank-picker" ref={boxRef}>
      {open ? (
        <div className="bank-picker-search">
          <Search size={15} className="bank-picker-search-icon" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            className="bank-picker-input"
            placeholder="Tìm ngân hàng…"
            value={query}
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeBank ? optionId(active) : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(-1);
            }}
            onKeyDown={handleKey}
          />
          <button
            type="button"
            className="bank-picker-cancel"
            onClick={() => closePicker(true)}
          >
            Hủy
          </button>
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="bank-picker-trigger"
          aria-haspopup="listbox"
          aria-expanded={false}
          aria-label={
            selected ? `Ngân hàng nhận tiền: ${selected.shortName}` : "Chọn ngân hàng nhận tiền"
          }
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          {selected ? (
            <>
              <span className="bank-picker-mark">{selected.code.slice(0, 2)}</span>
              <span className="bank-picker-name">{selected.shortName}</span>
            </>
          ) : (
            <span className="bank-picker-placeholder">— Chọn ngân hàng —</span>
          )}
          <ChevronDown size={16} className="bank-picker-chevron" aria-hidden />
        </button>
      )}

      {open && (
        <ul id={listboxId} className="bank-picker-list" role="listbox" aria-label="Ngân hàng">
          {results.length === 0 && (
            // Không phải một lựa chọn: gán role="option" biến thông báo "không có
            // kết quả" thành mục mà trình đọc màn hình báo là chọn được.
            <li className="bank-picker-empty" role="presentation" aria-disabled="true">
              Không tìm thấy ngân hàng phù hợp.
            </li>
          )}
          {results.map((b, idx) => (
            <li
              key={b.bin}
              id={optionId(idx)}
              role="option"
              aria-selected={b.bin === value}
              className={
                "bank-picker-option" +
                (idx === active ? " is-active" : "") +
                (b.bin === value ? " is-selected" : "")
              }
              onPointerDown={(e) => {
                e.preventDefault();
                commit(b.bin);
              }}
              onMouseEnter={() => setActive(idx)}
            >
              <span className="bank-picker-mark" aria-hidden>
                {b.code.slice(0, 2)}
              </span>
              <span className="bank-picker-option-text">
                <span className="bank-picker-option-name">{b.shortName}</span>
                <span className="bank-picker-option-full">{b.name}</span>
              </span>
              <span className="bank-picker-option-bin">{b.bin}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Bộ đếm kết quả + mục đang gợi ý: người dùng bàn phím không nhìn thấy
          danh sách nên phải được đọc lên mỗi lần gõ. */}
      <span className="sr-only" role="status" aria-live="polite">
        {open
          ? results.length === 0
            ? "Không tìm thấy ngân hàng phù hợp."
            : `${results.length} ngân hàng. ${activeBank ? `Đang gợi ý ${activeBank.shortName}.` : "Dùng phím mũi tên để chọn."}`
          : ""}
      </span>
      {invalid && !selected ? <span className="sr-only">Chưa chọn ngân hàng nhận tiền.</span> : null}
    </div>
  );
}

function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const run = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`Đã sao chép ${label}.`);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Không sao chép được. Hãy chọn và copy thủ công.");
    }
  };
  return (
    <button type="button" className="pay-copy-chip" onClick={() => void run()} title={`Sao chép ${label}`}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Đã copy" : "Copy"}
    </button>
  );
}

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
  // Chỉ báo lỗi sau khi người dùng thực sự bấm Lưu — gạch đỏ trước khi họ kịp
  // gõ xong khiến biểu mẫu như đang mắng người điền.
  const [showErrors, setShowErrors] = useState(false);

  // Mã xem trước: vẽ tại máy (không phải mã thanh toán), chỉ hiện khi đã đủ
  // thông tin, có debounce và có trạng thái loading/lỗi rõ ràng.
  const [qrState, setQrState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [demoQrUrl, setDemoQrUrl] = useState<string | null>(null);

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

  // Vẽ mã minh hoạ sau 450ms ngừng gõ — giảm số lần vẽ lại, hết cảnh nhấp nháy.
  // Chuỗi vẽ là DEMO_QR_TEXT tĩnh: số tài khoản thật không rời khỏi máy, và
  // không có thiết bị nào quét màn hình này mà chuyển được tiền.
  useEffect(() => {
    const bin = bankBin.trim();
    const no = accountNo.trim();
    if (!bin || !no) {
      setDemoQrUrl(null);
      setQrState("idle");
      return;
    }
    setQrState("loading");
    let alive = true;
    const t = window.setTimeout(() => {
      void renderQrToDataUrl(DEMO_QR_TEXT, 240)
        .then((url) => {
          if (!alive) return;
          setDemoQrUrl(url);
          // Data URL đã giải mã xong: không phụ thuộc onLoad (sự kiện có thể đã
          // chạy trước khi React kịp gắn trình nghe — ảnh/cache bị kẹt spinner).
          setQrState("ready");
        })
        .catch(() => {
          if (!alive) return;
          setDemoQrUrl(null);
          setQrState("error");
        });
    }, 450);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [bankBin, accountNo]);

  const fieldErrors = validateBankSettings({
    bankBin,
    accountNo,
    accountName: removeVietnameseTones(accountName).toUpperCase(),
  });
  const invalid = hasBankSettingsErrors(fieldErrors);

  const saveMutation = useMutation({
    mutationFn: () => {
      const cleanBin = bankBin.trim();
      const cleanNo = accountNo.trim();
      const cleanName = removeVietnameseTones(accountName).toUpperCase().trim();

      if (!cleanBin) throw new Error("Vui lòng chọn ngân hàng nhận tiền.");
      if (!cleanNo) throw new Error("Vui lòng nhập số tài khoản.");
      if (!cleanName) throw new Error("Vui lòng nhập tên chủ tài khoản.");

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
      setShowErrors(false);
      toast.success("Đã lưu tài khoản nhận tiền.");
      onSaved?.("Đã lưu tài khoản nhận tiền.");
    },
  });

  const isConfigured = Boolean(
    q.data?.bank_bin && q.data?.bank_account_no && q.data?.bank_account_name,
  );

  const selectedBank = getBankByBin(bankBin);

  const handleSelectBank = (bin: string) => {
    setDirty(true);
    setBankBin(bin);
    const bank = getBankByBin(bin);
    if (bank) setBankName(bank.shortName);
  };

  const handleReset = () => {
    if (!q.data) return;
    setBankBin(q.data.bank_bin || "");
    setBankName(q.data.bank_name || "");
    setAccountNo(q.data.bank_account_no || "");
    setAccountName(q.data.bank_account_name || "");
    setDirty(false);
    setShowErrors(false);
  };

  const handleSave = () => {
    setShowErrors(true);
    // Không gửi lên server một cấu hình còn thiếu: server sẽ báo
    // VIETQR_CONFIG_REQUIRED chung chung, còn nhân viên cần biết đúng trường nào.
    if (invalid) return;
    saveMutation.mutate();
  };

  return (
    <Card className="stack paycard">
      <header className="paycard-head">
        <div className="paycard-head-text">
          <h2 className="section-title paycard-title">
            <span className="paycard-title-icon" aria-hidden>
              <CreditCard size={18} />
            </span>
            Tài khoản nhận tiền
          </h2>
          <p className="muted small paycard-sub">
            Dùng để nhận tiền chuyển khoản và tạo mã QR khi bán xe.
          </p>
        </div>
        <span
          className={
            "paycard-status " + (isConfigured ? "is-ok" : "is-warn")
          }
        >
          {isConfigured ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
          {isConfigured ? "Đang hoạt động" : "Chưa thiết lập"}
        </span>
      </header>

      <div className="payment-settings-grid">
        <div className="payment-settings-form">
          <Field label="Ngân hàng" error={showErrors ? fieldErrors.bankBin : undefined}>
            <BankPicker
              value={bankBin}
              onSelect={handleSelectBank}
              invalid={showErrors && Boolean(fieldErrors.bankBin)}
            />
          </Field>

          <Field
            label="Số tài khoản"
            error={showErrors ? fieldErrors.accountNo : undefined}
          >
            <div className="pay-input-wrap">
              <input
                type="text"
                inputMode="numeric"
                maxLength={40}
                placeholder="Ví dụ: 1234567890"
                value={accountNo}
                onChange={(e) => {
                  setDirty(true);
                  setAccountNo(e.target.value.replace(/[^\d]/g, ""));
                }}
              />
              {accountNo && <CopyChip text={accountNo} label="số tài khoản" />}
            </div>
          </Field>

          <Field
            label="Chủ tài khoản"
            error={showErrors ? fieldErrors.accountName : undefined}
          >
            <input
              type="text"
              maxLength={120}
              placeholder="NGUYEN VAN A"
              value={accountName}
              onChange={(e) => {
                setDirty(true);
                setAccountName(removeVietnameseTones(e.target.value).toUpperCase());
              }}
            />
            <span className="pay-hint">Tên in hoa, không dấu — khớp đúng tên trên tài khoản ngân hàng.</span>
          </Field>

          {saveMutation.isError && <ErrorState error={saveMutation.error} />}

          <div className="paycard-actions">
            <span className={"pay-unsaved" + (dirty ? " is-dirty" : "")}>
              {dirty ? "Có thay đổi chưa lưu" : "Đã đồng bộ"}
            </span>
            <div className="paycard-actions-btns">
              {dirty && (
                <Button variant="ghost" onClick={handleReset} disabled={saveMutation.isPending}>
                  <RotateCcw size={15} /> Hoàn tác
                </Button>
              )}
              <Button
                disabled={q.isPending || saveMutation.isPending || !dirty}
                onClick={handleSave}
                title={
                  q.isPending
                    ? "Đang tải cấu hình hiện tại"
                    : !dirty
                      ? "Chưa có thay đổi nào để lưu"
                      : undefined
                }
              >
                {saveMutation.isPending
                  ? "Đang lưu…"
                  : q.isPending && !q.data
                    ? "Đang tải…"
                    : "Lưu thay đổi"}
              </Button>
            </div>
          </div>
        </div>

        <div
          className="bank-card-visual"
          role="group"
          aria-label="Xem trước thẻ tài khoản nhận tiền"
        >
          <div className="bank-card-sheen" aria-hidden />
          <div className="bank-card-header">
            <div className="bank-card-brand">
              <div className="bank-card-brand-icon" aria-hidden>
                <Landmark size={18} />
              </div>
              <span className="bank-card-brand-name">
                {selectedBank?.shortName || bankName || "Tài khoản nhận"}
              </span>
            </div>
            <span className="bank-card-vietqr">
              <QrCode size={13} /> VietQR
            </span>
          </div>

          <div className="bank-card-body">
            <div className="bank-card-number-label">Số tài khoản</div>
            <div className="bank-card-number">
              {accountNo ? groupAccount(accountNo) : "•••• •••• ••••"}
            </div>
          </div>

          <div className="bank-card-footer">
            <div className="bank-card-holder">
              <div className="bank-card-holder-label">Chủ tài khoản</div>
              <div className="bank-card-holder-name">
                {accountName || "CHƯA THIẾT LẬP"}
              </div>
            </div>

            <div className="bank-card-qr">
              <div className="bank-card-qr-tile">
                {demoQrUrl && qrState !== "error" ? (
                  <>
                    {qrState === "loading" && (
                      <span className="bank-card-qr-spinner" aria-hidden>
                        <Loader2 size={18} />
                      </span>
                    )}
                    <img
                      src={demoQrUrl}
                      alt="Mã QR minh họa giao diện, không dùng để thanh toán"
                      className={"bank-card-qr-img" + (qrState === "ready" ? " is-ready" : "")}
                      onError={() => setQrState("error")}
                    />
                  </>
                ) : qrState === "error" ? (
                  <span
                    className="bank-card-qr-placeholder is-error"
                    title="Chưa vẽ được mã minh họa — hãy thử lại"
                    role="img"
                    aria-label="Chưa vẽ được mã minh họa"
                  >
                    <TriangleAlert size={20} />
                  </span>
                ) : (
                  <span
                    className="bank-card-qr-placeholder"
                    title="Mã minh họa hiển thị khi đã đủ thông tin"
                    aria-hidden
                  >
                    <QrCode size={24} />
                  </span>
                )}
              </div>
              {/* Nhãn tại chỗ: chỉ nhìn thoáng qua cũng biết đây không phải mã
                  thật — tránh ai đó mở Cài đặt rồi quay chụp đem đi chuyển tiền. */}
              <span className="bank-card-qr-demo">Minh họa · không thanh toán</span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
