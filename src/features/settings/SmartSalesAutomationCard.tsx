import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  Plug,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { Button, Card, ErrorState, Field, Loading } from "@/components/ui";
import type { AutomationSettings, MessageTemplate } from "@/types";

type WebhookState = {
  provider: string;
  webhook_enabled: boolean;
  auto_match_enabled: boolean;
  account_configured: boolean;
};

const CHANNEL_LABEL: Record<string, string> = {
  "": "Chung",
  ZALO_ZNS: "Zalo ZNS",
  SMS: "SMS",
  ZALO_OA: "Zalo OA",
  FB_MESSENGER: "Facebook Page",
};

/** Chủ cửa hàng bật/tắt automation, soi tình trạng webhook và sửa mẫu cảm ơn. */
export function SmartSalesAutomationCard() {
  const client = useQueryClient();
  const [provider, setProvider] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [autoMatch, setAutoMatch] = useState(true);
  const [manualThankYou, setManualThankYou] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [health, setHealth] = useState<"CONFIGURED" | "NOT_CONFIGURED" | "UNREACHABLE" | null>(null);
  const [probing, setProbing] = useState(false);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<AutomationSettings>("get_settings"),
  });
  const stateQuery = useQuery({
    queryKey: ["bank-webhook-state"],
    queryFn: () => api.getBankWebhookState(),
  });
  const templates = useQuery({
    queryKey: ["message-templates"],
    queryFn: () => api.listMessageTemplates(),
  });

  useEffect(() => {
    if (!settings.data || dirty) return;
    setProvider(settings.data.bank_provider ?? "");
    setWebhookEnabled(!!settings.data.bank_webhook_enabled);
    setAutoMatch(settings.data.bank_auto_match_enabled ?? true);
    setManualThankYou(settings.data.thankyou_manual_enabled ?? true);
  }, [settings.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      api.call("save_settings", {
        p_data: {
          bank_provider: provider,
          bank_webhook_enabled: webhookEnabled,
          bank_auto_match_enabled: autoMatch,
          thankyou_manual_enabled: manualThankYou,
        },
      }),
    onSuccess: () => {
      setDirty(false);
      void client.invalidateQueries({ queryKey: ["settings"] });
      void client.invalidateQueries({ queryKey: ["bank-webhook-state"] });
      toast.success("Đã lưu cấu hình tự động bán hàng.");
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const probe = async () => {
    setProbing(true);
    setHealth(null);
    const result = await api.checkBankWebhookHealth();
    setHealth(result);
    setProbing(false);
  };

  const st: WebhookState | undefined = stateQuery.data;
  const webhookBlocked = st ? !st.account_configured : false;

  return (
    <div className="stack">
      <Card className="stack">
        <div className="row between wrap gap-sm">
          <div>
            <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Plug size={18} /> Tự động bán hàng &amp; kết nối ngân hàng
            </h2>
            <p className="muted small">
              Kết nối webhook ngân hàng để hệ thống tự nghe tiền khách chuyển và ghi
              thẳng vào đơn bán. Chỉ bật khi đã cấu hình tài khoản nhận tiền ở thẻ{" "}
              <strong>Tài khoản nhận tiền</strong>.
            </p>
          </div>
          {st && (
            <span
              className={`badge ${st.webhook_enabled ? "badge-success" : "badge-warning"}`}
              style={{ alignSelf: "flex-start" }}
            >
              {st.webhook_enabled ? "Webhook đang bật" : "Webhook đang tắt"}
            </span>
          )}
        </div>

        {stateQuery.isPending ? (
          <Loading />
        ) : stateQuery.error ? (
          <ErrorState error={stateQuery.error} />
        ) : (
          <>
            <div className="form-grid">
              <Field label="Nhà cung cấp giao dịch ngân hàng">
                <select
                  value={provider}
                  onChange={(e) => {
                    setDirty(true);
                    setProvider(e.target.value);
                  }}
                >
                  <option value="">— Chưa dùng —</option>
                  <option value="SEPAY">SePay</option>
                  <option value="CASSO">Casso</option>
                </select>
              </Field>
              <div className="field">
                <label>Tình trạng tài khoản nhận</label>
                <p className="muted small" style={{ margin: "6px 0 0" }}>
                  {st?.account_configured ? (
                    <><CheckCircle2 size={14} style={{ color: "#047857", verticalAlign: "-2px" }} /> Đã cấu hình tài khoản nhận tiền</>
                  ) : (
                    <><TriangleAlert size={14} style={{ color: "#b45309", verticalAlign: "-2px" }} /> Chưa có tài khoản nhận — không bật được webhook</>
                  )}
                </p>
              </div>
            </div>

            <div className="settings-field-group">
              <label className="settings-switch-card">
                <div className="settings-switch-content">
                  <span className="settings-switch-title">Bật webhook ngân hàng</span>
                  <span className="settings-switch-desc">
                    Nhận tự động giao dịch chuyển khoản. Secret ký xác thực cấu hình
                    trên server, không nhập tại đây.
                  </span>
                </div>
                <input
                  type="checkbox"
                  disabled={webhookBlocked}
                  checked={webhookEnabled}
                  onChange={(e) => {
                    setDirty(true);
                    setWebhookEnabled(e.target.checked);
                  }}
                />
              </label>
              {webhookBlocked && webhookEnabled && (
                <p className="notice warning small" style={{ margin: 0 }}>
                  Không bật được webhook khi chưa có tài khoản nhận tiền.
                </p>
              )}

              <label className="settings-switch-card">
                <div className="settings-switch-content">
                  <span className="settings-switch-title">Tự ghi tiền khi khách chuyển đúng</span>
                  <span className="settings-switch-desc">
                    Bật: tiền về khớp đúng số trên mã do chính chủ cửa hàng tạo sẽ tự
                    vào đơn, không ai phải bấm gì. Tắt: tiền về vẫn hiện trên đơn hàng
                    và chờ chủ cửa hàng bấm ghi nhận.
                  </span>
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

              <label className="settings-switch-card">
                <div className="settings-switch-content">
                  <span className="settings-switch-title">
                    Chuẩn bị lời cảm ơn cho kênh cá nhân
                  </span>
                  <span className="settings-switch-desc">
                    Tự soạn lời cảm ơn sau khi chốt bán để nhân viên tự gửi qua
                    Zalo/Messenger. Không gửi hộ, không bot.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={manualThankYou}
                  onChange={(e) => {
                    setDirty(true);
                    setManualThankYou(e.target.checked);
                  }}
                />
              </label>
            </div>

            {save.error && <ErrorState error={save.error} />}
            <div className="row between wrap gap-sm">
              <Button
                disabled={save.isPending || (!dirty && !save.isPending)}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Đang lưu…" : "Lưu cấu hình"}
              </Button>
              <Button variant="secondary" onClick={() => void probe()}>
                <Activity size={15} /> {probing ? "Đang kiểm tra…" : "Kiểm tra webhook"}
              </Button>
            </div>
            {health && (
              <p className="muted small" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                {health === "CONFIGURED" ? (
                  <><CheckCircle2 size={14} style={{ color: "#047857" }} /> Edge webhook đã được cấu hình và phản hồi.</>
                ) : health === "NOT_CONFIGURED" ? (
                  <><ShieldAlert size={14} style={{ color: "#b45309" }} /> Edge chưa có secret nhà cung cấp — chờ điền credentials để kích hoạt.</>
                ) : (
                  <><TriangleAlert size={14} style={{ color: "#b91c1c" }} /> Không gọi được Edge webhook (mất mạng hoặc chưa triển khai).</>
                )}
              </p>
            )}
          </>
        )}
      </Card>

      <MessageTemplateEditor templates={templates} />
    </div>
  );
}

function MessageTemplateEditor({
  templates,
}: {
  templates: ReturnType<typeof useQuery<MessageTemplate[]>>;
}) {
  const client = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (data: { code: string; body: string }) =>
      api.saveMessageTemplate({ code: data.code, body: data.body }),
    onSuccess: () => {
      setDrafts({});
      void client.invalidateQueries({ queryKey: ["message-templates"] });
      toast.success("Đã lưu mẫu lời cảm ơn.");
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  if (templates.isPending) return <Loading />;
  if (templates.error) return <ErrorState error={templates.error} />;
  const items = templates.data ?? [];

  return (
    <Card className="stack">
      <h2 className="section-title">Mẫu lời cảm ơn (kênh chính thức)</h2>
      <p className="muted small">
        Chỉ dùng biến an toàn: <code>{"{customer_name}"}</code>{" "}
        <code>{"{store_name}"}</code> <code>{"{support_phone}"}</code>{" "}
        <code>{"{sale_code}"}</code>. Hệ thống chặn mọi biến chứa số tiền.
      </p>
      {items.length === 0 ? (
        <p className="muted small">Chưa có mẫu nào.</p>
      ) : (
        items.map((t) => {
          const draft = drafts[t.code] ?? t.body;
          const changed = draft !== t.body;
          return (
            <div key={t.code} className="stack" style={{ gap: 6, padding: "10px 0", borderTop: "1px solid var(--line, #e2e8f0)" }}>
              <div className="row between wrap gap-sm">
                <strong style={{ fontSize: "0.9rem" }}>
                  {t.name} <span className="muted small">({CHANNEL_LABEL[t.channel] ?? t.channel})</span>
                </strong>
                <span className="muted small"><code>{t.code}</code></span>
              </div>
              <textarea
                rows={3}
                maxLength={500}
                value={draft}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [t.code]: e.target.value }))}
              />
              {changed && (
                <div>
                  <Button
                    disabled={save.isPending || !draft.trim()}
                    onClick={() => save.mutate({ code: t.code, body: draft })}
                  >
                    Lưu mẫu
                  </Button>
                </div>
              )}
            </div>
          );
        })
      )}
      {save.error && <ErrorState error={save.error} />}
    </Card>
  );
}
