import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleX,
  Plug,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { canFinance } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { Button, Card, ErrorState, Field, Loading } from "@/components/ui";

/**
 * Màn "Thanh toán & Đối soát" cho chủ cửa hàng — chuyên trách KẾT NỐI ngân hàng:
 * trạng thái thật, nút kiểm tra endpoint và cài đặt nâng cao.
 * Tài khoản nhận tiền và hàng đợi đối soát đã có tab/trang riêng trong sidebar
 * nên KHÔNG lặp lại ở đây; số liệu đối soát chỉ được hỏi ngầm để làm bằng
 * chứng cho trạng thái kết nối.
 * Nguyên tắc: mọi trạng thái đều suy từ tín hiệu THẬT (RPC + probe Edge + số
 * giao dịch đối soát). Không bao giờ tuyên bố "thành công" chỉ vì endpoint trả
 * CONFIGURED — phải có bằng chứng webhook thực sự được nhận và ghi nhận.
 */

type Health = "CONFIGURED" | "NOT_CONFIGURED" | "UNREACHABLE";

/** Bốn ô số liệu đối soát — tái dùng đúng trạng thái backend, không bịa. */
const RECON_BUCKETS = [
  { key: "MATCHED_PENDING", label: "Chờ xác nhận", hint: "Khớp mã, cần người xác nhận thu tiền" },
  { key: "MANUAL_REVIEW", label: "Cần rà soát", hint: "Chưa tự khớp, phải xem tay" },
  { key: "UNMATCHED", label: "Chưa khớp", hint: "Tiền về nhưng không đọc được mã" },
  { key: "RECORDED", label: "Đã ghi nhận", hint: "Đã chính thức ghi vào sổ" },
] as const;

type ReconStatus = (typeof RECON_BUCKETS)[number]["key"];

export type ConnectionTone = "neutral" | "info" | "success" | "warning" | "danger";

export type ConnectionInput = {
  provider: string;
  accountConfigured: boolean;
  webhookEnabled: boolean;
  health: Health | null;
  /** null = chưa kiểm (không khẳng định); true/false = đã có/không có giao dịch thật về. */
  anyTxnReceived: boolean | null;
};

export type ConnectionStatus = { tone: ConnectionTone; label: string; hint: string };

/**
 * Suy trạng thái kết nối trung thực. Tách thành hàm thuần để unit test không cần DOM.
 * Thứ tự ưu tiên: chưa chọn nhà cung cấp → chưa có tài khoản → lỗi endpoint →
 * đang tạm dừng → chưa kiểm thử → thiếu secret → đã nhận webhook → mới cấu hình.
 */
export function deriveConnectionStatus(i: ConnectionInput): ConnectionStatus {
  if (!i.provider)
    return { tone: "neutral", label: "Chưa thiết lập", hint: "Chọn nhà cung cấp trong phần Cài đặt nâng cao." };
  if (!i.accountConfigured)
    return { tone: "neutral", label: "Chưa thiết lập", hint: "Khai báo tài khoản nhận tiền trước khi bật kết nối." };
  if (i.health === "UNREACHABLE")
    return { tone: "danger", label: "Đang gặp lỗi", hint: "Không gọi được endpoint. Kiểm tra mạng hoặc triển khai Edge Function." };
  if (!i.webhookEnabled)
    return { tone: "warning", label: "Đã tạm dừng", hint: "Bật webhook trong Cài đặt nâng cao để nhận giao dịch." };
  if (i.health === "NOT_CONFIGURED")
    return { tone: "danger", label: "Đang gặp lỗi", hint: "Endpoint sống nhưng chưa có secret nhà cung cấp trên server." };
  if (i.health === "CONFIGURED" && i.anyTxnReceived === true)
    return { tone: "success", label: "Đã kiểm thử nhận webhook", hint: "Endpoint + secret OK và đã có giao dịch thật chảy về." };
  if (i.health === "CONFIGURED")
    return { tone: "info", label: "Đã cấu hình, chưa kiểm thử", hint: "Endpoint + secret OK; chờ một giao dịch thật để xác nhận." };
  return { tone: "info", label: "Đã cấu hình, chưa kiểm thử", hint: "Bấm Kiểm tra kết nối để xác minh endpoint." };
}

export type CheckState = "done" | "pending" | "fail" | "unknown";
export type CheckItem = { label: string; state: CheckState; note: string };

/** Danh sách 5 tầng kiểm chứng — mỗi tầng một tín hiệu thật riêng, không gộp. */
export function buildChecklist(
  i: ConnectionInput,
  counts: { matched: number; recorded: number },
): CheckItem[] {
  const edge: CheckState =
    i.health === "UNREACHABLE" ? "fail" : i.health ? "done" : "unknown";
  const secret: CheckState =
    i.health === "CONFIGURED" ? "done" : i.health === "NOT_CONFIGURED" ? "fail" : "unknown";
  const received: CheckState =
    i.anyTxnReceived === true ? "done" : i.anyTxnReceived === false ? "pending" : "unknown";
  const matched: CheckState =
    counts.matched > 0 ? "done" : i.anyTxnReceived ? "pending" : "unknown";
  const recorded: CheckState =
    counts.recorded > 0 ? "done" : i.anyTxnReceived ? "pending" : "unknown";
  return [
    { label: "Điểm cuối hoạt động", state: edge, note: "Edge Function phản hồi khi được gọi." },
    { label: "Khóa bảo mật đã cài", state: secret, note: "Secret ký xác thực nằm an toàn trên server." },
    { label: "Đã nhận giao dịch thật", state: received, note: "Ít nhất một lần tiền thật chảy về hệ thống." },
    { label: "Đối soát khớp mã", state: matched, note: "Có giao dịch khớp đúng mã tham chiếu đang chờ." },
    { label: "Đã ghi nhận khoản thu", state: recorded, note: "Có khoản thu chính thức được ghi vào sổ." },
  ];
}

/** Payload lưu phần nâng cao — CHỈ 3 cờ kết nối thanh toán. */
export function buildAdvancedSavePayload(a: {
  provider: string;
  webhookEnabled: boolean;
  autoMatch: boolean;
}) {
  return {
    bank_provider: a.provider,
    bank_webhook_enabled: a.webhookEnabled,
    bank_auto_match_enabled: a.autoMatch,
  };
}

function StatusPill({ tone, label }: { tone: ConnectionTone; label: string }) {
  return <span className={`pa-status tone-${tone}`}>{label}</span>;
}

function CheckDot({ state }: { state: CheckState }) {
  const Icon = state === "done" ? CheckCircle2 : state === "fail" ? CircleX : state === "pending" ? TriangleAlert : CircleDashed;
  return <Icon size={16} className={`pa-check-dot s-${state}`} aria-hidden />;
}

export function PaymentAutomationCard({ onOpenPayment }: { onOpenPayment?: () => void }) {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [health, setHealth] = useState<Health | null>(null);
  const [probing, setProbing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Phần nâng cao: state tạm, đối chiếu với DB qua dirty.
  const [provider, setProvider] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [autoMatch, setAutoMatch] = useState(true);
  const [dirty, setDirty] = useState(false);

  const stateQuery = useQuery({
    queryKey: ["bank-webhook-state"],
    queryFn: () => api.getBankWebhookState(),
  });
  const canRecon = canFinance(profile);
  const recon = useQuery({
    queryKey: ["bank-recon-summary"],
    enabled: canRecon,
    // Một lượt gọi nhẹ (limit 1) cho từng trạng thái để lấy tổng thật, không poll.
    queryFn: async () => {
      const entries = await Promise.all(
        RECON_BUCKETS.map(async (b) => {
          const res = await api.listBankTransactions({ status: b.key, limit: 1 });
          return [b.key, res.total ?? 0] as const;
        }),
      );
      const byStatus = Object.fromEntries(entries) as Record<ReconStatus, number>;
      const grand = await api.listBankTransactions({ limit: 1 });
      return { byStatus, totalAll: grand.total ?? 0 };
    },
  });

  useEffect(() => {
    if (!stateQuery.data || dirty) return;
    setProvider(stateQuery.data.provider ?? "");
    setWebhookEnabled(!!stateQuery.data.webhook_enabled);
    setAutoMatch(stateQuery.data.auto_match_enabled ?? true);
  }, [stateQuery.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      api.call("save_settings", {
        p_data: buildAdvancedSavePayload({ provider, webhookEnabled, autoMatch }),
      }),
    onSuccess: () => {
      setDirty(false);
      void client.invalidateQueries({ queryKey: ["settings"] });
      void client.invalidateQueries({ queryKey: ["bank-webhook-state"] });
      toast.success("Đã lưu cấu hình kết nối ngân hàng.");
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const probe = async () => {
    setProbing(true);
    setHealth(null);
    const result = await api.checkBankWebhookHealth();
    setHealth(result);
    if (canRecon) void client.invalidateQueries({ queryKey: ["bank-recon-summary"] });
    setProbing(false);
  };

  const askToggleWebhook = async (next: boolean) => {
    const ok = next
      ? await confirmAction({
          title: "Bật nhận giao dịch tự động?",
          description:
            "Hệ thống sẽ bắt đầu tiếp nhận các khoản tiền webhook đẩy về để đối soát. Chỉ ghi nhận khi người có quyền xác nhận.",
          confirmLabel: "Bật webhook",
          cancelLabel: "Thôi",
        })
      : await confirmAction({
          title: "Tạm dừng nhận giao dịch?",
          description:
            "Ngưng tiếp nhận dữ liệu mới từ ngân hàng. Lịch sử đối soát và các mã VietQR đang chờ vẫn nguyên vẹn.",
          confirmLabel: "Tạm dừng",
          cancelLabel: "Giữ bật",
        });
    if (!ok) return;
    setDirty(true);
    setWebhookEnabled(next);
  };

  const askProvider = async (next: string) => {
    const ok = await confirmAction({
      title: "Đổi nhà cung cấp kết nối?",
      description:
        "Nhà cung cấp phải khớp với webhook đang bật ngoài ngân hàng. Nếu secret chưa cấu hình cho nhà cung cấp mới, kết nối sẽ báo lỗi cho tới khi bổ sung.",
      confirmLabel: "Đổi nhà cung cấp",
      cancelLabel: "Giữ nguyên",
    });
    if (!ok) return;
    setDirty(true);
    setProvider(next);
  };

  const st = stateQuery.data;
  const blocked = st ? !st.account_configured : false;
  const counts = recon.data;
  const anyTxnReceived: boolean | null = counts ? counts.totalAll > 0 : null;
  const conn = deriveConnectionStatus({
    provider: st?.provider ?? "",
    accountConfigured: !!st?.account_configured,
    webhookEnabled: !!st?.webhook_enabled,
    health,
    anyTxnReceived,
  });
  const checklist = buildChecklist(
    {
      provider: st?.provider ?? "",
      accountConfigured: !!st?.account_configured,
      webhookEnabled: !!st?.webhook_enabled,
      health,
      anyTxnReceived,
    },
    {
      matched: counts ? counts.byStatus.MATCHED_PENDING + counts.byStatus.MANUAL_REVIEW : 0,
      recorded: counts ? counts.byStatus.RECORDED : 0,
    },
  );

  if (stateQuery.isPending) {
    return (
      <Card className="stack">
        <Loading />
      </Card>
    );
  }
  if (stateQuery.error && !st) {
    return (
      <Card className="stack">
        <ErrorState error={stateQuery.error} retry={() => void stateQuery.refetch()} />
      </Card>
    );
  }

  return (
    <div className="stack payment-automation">
      {/* KHỐI DUY NHẤT — KẾT NỐI NGÂN HÀNG (tài khoản & đối soát có trang riêng) */}
      <Card className="stack">
        <div className="row between wrap gap-sm">
          <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Plug size={18} /> Kết nối ngân hàng
          </h2>
          <StatusPill tone={conn.tone} label={conn.label} />
        </div>
        <p className="pa-conn-hint">{conn.hint}</p>
        {!st?.account_configured && onOpenPayment && (
          <p className="muted small" style={{ margin: 0 }}>
            Webhook chỉ bật được sau khi khai báo tài khoản nhận tiền ở tab "Tài khoản nhận tiền".
          </p>
        )}

        <div className="row between wrap gap-sm">
          <Button onClick={() => void probe()} disabled={probing} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Activity size={15} /> {probing ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
          </Button>
          <Button variant="ghost" onClick={() => setAdvancedOpen((v) => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Cài đặt nâng cao <ChevronDown size={15} style={{ transform: advancedOpen ? "rotate(180deg)" : "none", transition: "transform .15s ease" }} />
          </Button>
        </div>
      </Card>

      {/* CÀI ĐẶT NÂNG CAO (giữ chức năng thật, có xác nhận) */}
      {advancedOpen && (
        <Card className="stack pa-advanced">
          <h2 className="section-title">Cài đặt nâng cao</h2>

          <div className="form-grid">
            <Field label="Nhà cung cấp giao dịch ngân hàng">
              <select value={provider} onChange={(e) => void askProvider(e.target.value)}>
                <option value="">— Chưa dùng —</option>
                <option value="SEPAY">SePay</option>
                <option value="CASSO">Casso</option>
              </select>
            </Field>
            <div className="field">
              <label>Tài khoản nhận</label>
              <p className="muted small" style={{ margin: "6px 0 0" }}>
                {st?.account_configured ? (
                  <><CheckCircle2 size={14} style={{ color: "#047857", verticalAlign: "-2px" }} /> Đã cấu hình</>
                ) : (
                  <><TriangleAlert size={14} style={{ color: "#b45309", verticalAlign: "-2px" }} /> Chưa có — webhook không bật được</>
                )}
              </p>
            </div>
          </div>

          <div className="settings-field-group">
            <label className="settings-switch-card">
              <div className="settings-switch-content">
                <span className="settings-switch-title">Bật webhook ngân hàng</span>
                <span className="settings-switch-desc">Nhận tự động giao dịch chuyển khoản để đưa vào hàng đợi đối soát.</span>
              </div>
              <input
                type="checkbox"
                disabled={blocked}
                checked={webhookEnabled}
                onChange={(e) => void askToggleWebhook(e.target.checked)}
              />
            </label>
            {blocked && (
              <p className="notice warning small" style={{ margin: 0 }}>
                Không bật được webhook khi chưa có tài khoản nhận tiền.
              </p>
            )}
            <label className="settings-switch-card">
              <div className="settings-switch-content">
                <span className="settings-switch-title">Tự động khớp mã tham chiếu</span>
                <span className="settings-switch-desc">Khi tắt, mọi giao dịch về đều rơi vào hàng đợi rà soát thủ công.</span>
              </div>
              <input
                type="checkbox"
                checked={autoMatch}
                onChange={(e) => {
                  setDirty(true);
                  setAutoMatch(e.target.checked);
                }}
              />
            </label>
          </div>

          {/* Chẩn đoán kỹ thuật — chỉ hiện khi mở nâng cao. Secret không bao giờ hiển thị. */}
          <ul className="pa-checklist">
            {checklist.map((c) => (
              <li key={c.label} className="pa-check-item">
                <CheckDot state={c.state} />
                <div className="pa-check-text">
                  <span className="pa-check-label">{c.label}</span>
                  <span className="pa-check-note muted small">{c.note}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted small" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
            <Plug size={14} /> Trạng thái điểm cuối:{" "}
            <strong>
              {health === "CONFIGURED"
                ? "Sống · đã có khóa bảo mật"
                : health === "NOT_CONFIGURED"
                  ? "Sống · thiếu khóa bảo mật"
                  : health === "UNREACHABLE"
                    ? "Không gọi được"
                    : "Chưa kiểm tra — bấm Kiểm tra kết nối"}
            </strong>
          </p>

          {save.error && <ErrorState error={save.error} />}
          <div>
            <Button disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
              {save.isPending ? "Đang lưu…" : "Lưu cấu hình"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
