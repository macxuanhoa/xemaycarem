import { useEffect, useMemo, useRef, useState } from "react";
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
import { buildVietQrQuickLink, removeVietnameseTones } from "@/lib/vietqr/emvco";

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
}: {
  value: string;
  onSelect: (bin: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const commit = (bin: string) => {
    onSelect(bin);
    setOpen(false);
    setQuery("");
    setActive(-1);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((p) => Math.min(p + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((p) => Math.max(p - 1, 0));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && results[active]) {
        e.preventDefault();
        commit(results[active].bin);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

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
            aria-controls="bank-picker-listbox"
            aria-autocomplete="list"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(-1);
            }}
            onKeyDown={handleKey}
          />
          <button
            type="button"
            className="bank-picker-cancel"
            onClick={() => setOpen(false)}
          >
            Hủy
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="bank-picker-trigger"
          aria-haspopup="listbox"
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
        <ul id="bank-picker-listbox" className="bank-picker-list" role="listbox">
          {results.length === 0 && (
            <li className="bank-picker-empty" role="option" aria-disabled>
              Không tìm thấy ngân hàng phù hợp.
            </li>
          )}
          {results.map((b, idx) => (
            <li
              key={b.bin}
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

  // Trạng thái ảnh QR xem trước: chỉ nạp khi thông tin hợp lệ, có debounce và
  // có phản hồi loading/lỗi — tránh "thẻ bị lỗi" khi ảnh từ img.vietqr.io chậm
  // hoặc trả về hỏng.
  const [qrState, setQrState] = useState<"idle" | "loading" | "ready" | "error">("idle");
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

  // Nạp ảnh QR sau 450ms ngừng gõ — giảm số request và hết cảnh nhấp nháy.
  useEffect(() => {
    const bin = bankBin.trim();
    const no = accountNo.trim();
    if (!bin || !no) {
      setPreviewQrUrl(null);
      setQrState("idle");
      return;
    }
    setQrState("loading");
    const t = window.setTimeout(() => {
      try {
        setPreviewQrUrl(
          buildVietQrQuickLink(
            { bankBin: bin, accountNo: no, description: "CAREM TEST", accountName },
            "qr_only",
          ),
        );
      } catch {
        setPreviewQrUrl(null);
        setQrState("error");
      }
    }, 450);
    return () => window.clearTimeout(t);
  }, [bankBin, accountNo, accountName]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const cleanBin = bankBin.trim();
      const cleanNo = accountNo.trim();
      const cleanName = removeVietnameseTones(accountName).toUpperCase().trim();

      if (!cleanBin) throw new Error("Vui lòng chọn ngân hàng.");
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
          <Field label="Ngân hàng">
            <BankPicker value={bankBin} onSelect={handleSelectBank} />
          </Field>

          <Field label="Số tài khoản">
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

          <Field label="Chủ tài khoản">
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
                disabled={saveMutation.isPending || (!dirty && isConfigured)}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? "Đang lưu…" : "Lưu thay đổi"}
              </Button>
            </div>
          </div>
        </div>

        <div className="bank-card-visual" aria-label="Xem trước thẻ tài khoản nhận tiền">
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
              {previewQrUrl && qrState !== "error" ? (
                <>
                  {qrState === "loading" && (
                    <span className="bank-card-qr-spinner" aria-hidden>
                      <Loader2 size={18} />
                    </span>
                  )}
                  <img
                    src={previewQrUrl}
                    alt="Mã QR thanh toán xem trước"
                    className={"bank-card-qr-img" + (qrState === "ready" ? " is-ready" : "")}
                    loading="lazy"
                    onLoad={() => setQrState("ready")}
                    onError={() => setQrState("error")}
                  />
                </>
              ) : qrState === "error" ? (
                <span
                  className="bank-card-qr-placeholder is-error"
                  title="Không tải được mã QR xem trước — kiểm tra kết nối mạng"
                  role="img"
                >
                  <TriangleAlert size={20} />
                </span>
              ) : (
                <span className="bank-card-qr-placeholder" title="Mã QR hiển thị khi đủ thông tin">
                  <QrCode size={24} />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
