import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  Copy,
  ExternalLink,
  MessageSquareHeart,
  Phone,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { canManage, isOwner } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { Button, Card, ErrorState, Field, Loading } from "@/components/ui";
import {
  personalContactLink,
  type CustomerContact,
  type CustomerContactChannel,
  type ThankYouQueueItem,
} from "@/types";

const CHANNEL_LABEL: Record<CustomerContactChannel, string> = {
  ZALO_PERSONAL: "Zalo cá nhân",
  MESSENGER_PERSONAL: "Messenger cá nhân",
  ZALO_OA: "Zalo OA (chính thức)",
  FB_MESSENGER: "Facebook Page (chính thức)",
  SMS: "SMS",
  OTHER: "Kênh khác",
};

const PERSONAL_CHANNELS: CustomerContactChannel[] = [
  "ZALO_PERSONAL",
  "MESSENGER_PERSONAL",
];

/**
 * Bảng liên hệ & lời cảm ơn của đơn bán (Yêu cầu 1 + 6).
 * Kênh cá nhân: chỉ mở liên hệ đã lưu + sao chép tin để NHÂN VIÊN TỰ gửi.
 * Không dùng API không chính thức, không cookie scraping, không bot đăng nhập.
 */
export function SaleAutomationPanel({
  saleId,
  customerName,
}: {
  saleId: string;
  customerName?: string;
}) {
  const { profile } = useAuth();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [channel, setChannel] = useState<CustomerContactChannel>("ZALO_PERSONAL");
  const [phone, setPhone] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState(customerName ?? "");
  const [note, setNote] = useState("");

  const contacts = useQuery({
    queryKey: ["sale-contacts", saleId],
    queryFn: () => api.listSaleContacts(saleId),
  });
  const queue = useQuery({
    queryKey: ["sale-thankyou-queue", saleId],
    queryFn: () => api.listSaleThankYouQueue(saleId),
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["sale-contacts", saleId] });
    void client.invalidateQueries({ queryKey: ["sale-thankyou-queue", saleId] });
  };

  const saveContact = useMutation({
    mutationFn: () =>
      api.saveSaleContact({
        sale_id: saleId,
        channel,
        phone: phone.trim(),
        handle: handle.trim(),
        display_name: displayName.trim(),
        note: note.trim(),
      }),
    onSuccess: () => {
      toast.success("Đã lưu liên hệ khách hàng.");
      setAdding(false);
      setPhone("");
      setHandle("");
      setNote("");
      refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const verifyContact = useMutation({
    mutationFn: (data: { id: string; verified: boolean }) =>
      api.verifySaleContact(data.id, data.verified),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(friendlyError(e)),
  });

  const deleteContact = useMutation({
    mutationFn: (id: string) => api.deleteSaleContact(id),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(friendlyError(e)),
  });

  const markCopied = useMutation({
    mutationFn: (id: string) => api.markThankYouCopied(id),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(friendlyError(e)),
  });

  const markSent = useMutation({
    mutationFn: (data: { channel: string; note: string }) =>
      api.markPersonalThankYouSent({
        sale_id: saleId,
        channel: data.channel,
        evidence_note: data.note,
      }),
    onSuccess: () => {
      toast.success("Đã ghi nhận nhân viên tự gửi lời cảm ơn.");
      refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  // Sao chép nội dung gợi ý (render phía server, đã chốt không chứa giá).
  const copySuggestion = async (item: ThankYouQueueItem) => {
    try {
      const { rendered } = await api.previewMessageTemplate({
        code: item.template_code || "thank_you_sms_v1",
        sale_id: saleId,
      });
      await navigator.clipboard.writeText(rendered);
      toast.success("Đã sao chép lời cảm ơn. Dán vào cuộc trò chuyện và gửi.");
      markCopied.mutate(saleId);
    } catch (e) {
      // Fallback: template chưa có cho đơn này → dùng câu mặc định không giá.
      const fallback = `Cảm ơn ${customerName || "quý khách"} đã mua xe tại cửa hàng. Rất vui được hỗ trợ anh/chị ạ!`;
      await navigator.clipboard.writeText(fallback);
      toast.info("Đã sao chép lời cảm ơn mẫu.");
      markCopied.mutate(saleId);
      void friendlyError(e);
    }
  };

  const askDelete = async (c: CustomerContact) => {
    const ok = await confirmAction({
      title: "Xóa liên hệ này?",
      entity: CHANNEL_LABEL[c.channel] + (c.display_name ? ` · ${c.display_name}` : ""),
      description: "Liên hệ sẽ bị gỡ khỏi đơn bán. Lịch sử đã gửi tin vẫn được giữ.",
      confirmLabel: "Xóa liên hệ",
      tone: "danger",
    });
    if (ok) deleteContact.mutate(c.id);
  };

  const contactsReady = contacts.isSuccess;
  const canVerify = canManage(profile);

  return (
    <Card>
      <div className="row between" style={{ alignItems: "center" }}>
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <MessageSquareHeart size={18} /> Liên hệ &amp; lời cảm ơn
        </h2>
        <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
          <Plus size={15} /> {adding ? "Đóng" : "Thêm liên hệ"}
        </Button>
      </div>
      <p className="muted small">
        Ghi lại kênh khách đã liên hệ (Zalo/Messenger/SMS). Với kênh cá nhân, Cà Rem
        chỉ mở liên hệ và soạn sẵn lời cảm ơn để nhân viên <strong>tự gửi</strong> —
        không gửi tự động qua tài khoản cá nhân.
      </p>

      {adding && (
        <form
          className="stack inset-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!phone.trim() && !handle.trim()) {
              toast.error("Cần nhập số điện thoại hoặc tên tài khoản liên hệ.");
              return;
            }
            saveContact.mutate();
          }}
        >
          <div className="form-grid">
            <Field label="Kênh liên hệ">
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as CustomerContactChannel)}
              >
                {(Object.keys(CHANNEL_LABEL) as CustomerContactChannel[]).map((ch) => (
                  <option key={ch} value={ch}>
                    {CHANNEL_LABEL[ch]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tên hiển thị">
              <input
                maxLength={120}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Tên khách"
              />
            </Field>
            <Field label="Số điện thoại">
              <input
                maxLength={20}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="09xxxxxxxx"
              />
            </Field>
            <Field label={PERSONAL_CHANNELS.includes(channel) ? "Tên tài khoản / link" : "Handle / số"}>
              <input
                maxLength={160}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder={channel === "MESSENGER_PERSONAL" ? "profile trên m.me" : "Không bắt buộc"}
              />
            </Field>
          </div>
          <Field label="Ghi chú">
            <input
              maxLength={240}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="VD: khách hay nhắn Zalo buổi tối"
            />
          </Field>
          {saveContact.error && <ErrorState error={saveContact.error} />}
          <div className="form-actions">
            <Button type="submit" disabled={saveContact.isPending}>
              {saveContact.isPending ? "Đang lưu…" : "Lưu liên hệ"}
            </Button>
          </div>
        </form>
      )}

      {!contactsReady ? (
        contacts.isPending ? (
          <Loading />
        ) : (
          <ErrorState error={contacts.error} retry={() => void contacts.refetch()} />
        )
      ) : contacts.data && contacts.data.length > 0 ? (
        <div className="compact-list">
          {contacts.data.map((c) => {
            const link = personalContactLink(c.channel, {
              handle: c.handle,
              phone: c.phone,
            });
            return (
              <div className="compact-row" key={c.id}>
                <div>
                  <strong>
                    {CHANNEL_LABEL[c.channel]}
                    {c.verified && (
                      <BadgeCheck
                        size={14}
                        style={{ color: "#047857", marginLeft: 4, verticalAlign: "-2px" }}
                      />
                    )}
                  </strong>
                  <small>
                    {c.display_name || "—"}
                    {c.phone ? ` · ${c.phone}` : ""}
                    {c.handle ? ` · ${c.handle}` : ""}
                  </small>
                  {c.note && <small>{c.note}</small>}
                </div>
                <div className="align-right" style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {link && (
                    <a
                      className="button ghost small"
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} /> Mở liên hệ
                    </a>
                  )}
                  {canVerify && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        verifyContact.mutate({ id: c.id, verified: !c.verified })
                      }
                    >
                      {c.verified ? "Bỏ xác minh" : "Xác minh"}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => void askDelete(c)}
                    aria-label="Xóa liên hệ"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted small">Chưa có liên hệ nào cho đơn này.</p>
      )}

      <div style={{ marginTop: 12, borderTop: "1px solid var(--line, #e2e8f0)", paddingTop: 12 }}>
        <h3 className="section-title" style={{ fontSize: "1rem" }}>
          Lời cảm ơn sau bán
        </h3>
        {queue.isPending ? (
          <Loading />
        ) : queue.error ? (
          <ErrorState error={queue.error} retry={() => void queue.refetch()} />
        ) : !queue.data || queue.data.length === 0 ? (
          <p className="muted small">
            Chưa có lời cảm ơn nào được chuẩn bị. Hệ thống sẽ tự tạo sau khi đơn bán
            hoàn tất và khách có liên hệ đã xác minh.
          </p>
        ) : (
          <div className="compact-list">
            {queue.data.map((item) => {
              const isPersonal = PERSONAL_CHANNELS.includes(
                item.channel as CustomerContactChannel,
              );
              const contact = contacts.data?.find((c) => c.channel === item.channel);
              const link = contact
                ? personalContactLink(contact.channel, {
                    handle: contact.handle,
                    phone: contact.phone,
                  })
                : null;
              return (
                <div className="compact-row" key={item.id}>
                  <div>
                    <strong>{CHANNEL_LABEL[item.channel as CustomerContactChannel] ?? item.channel}</strong>
                    <small>
                      Trạng thái:{" "}
                      {item.status === "SENT"
                        ? "Đã gửi"
                        : item.status === "AWAITING_STAFF"
                          ? "Đang chờ nhân viên gửi"
                          : item.status === "QUEUED"
                            ? "Chuẩn bị sẵn"
                            : item.status}
                    </small>
                  </div>
                  <div className="align-right" style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {isPersonal && item.status !== "SENT" && (
                      <>
                        <Button
                          variant="secondary"
                          onClick={() => void copySuggestion(item)}
                        >
                          <Copy size={14} /> Sao chép tin
                        </Button>
                        {link && (
                          <a
                            className="button ghost small"
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Phone size={13} /> Mở liên hệ
                          </a>
                        )}
                        {(item.status === "QUEUED" || item.status === "AWAITING_STAFF") && (
                          <Button
                            onClick={() =>
                              markSent.mutate({
                                channel: item.channel,
                                note: "Nhân viên đã tự gửi lời cảm ơn",
                              })
                            }
                          >
                            <Send size={14} /> Tôi đã gửi
                          </Button>
                        )}
                      </>
                    )}
                    {!isPersonal && (
                      <span className="muted small">
                        {item.status === "SENT" || item.status === "DELIVERED"
                          ? "Đã gửi tự động (kênh chính thức)"
                          : item.status === "SKIPPED"
                            ? "Bỏ qua (chưa cấu hình kênh)"
                            : "Chờ gửi qua kênh chính thức"}
                      </span>
                    )}
                    {isPersonal && item.status === "SENT" && (
                      <span className="muted small">Đã ghi nhận nhân viên gửi</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {isOwner(profile) && (
        <p className="muted small" style={{ marginTop: 10 }}>
          Cấu hình mẫu lời cảm ơn và bật/tắt tự động nằm trong Cài đặt · Tự động bán hàng.
        </p>
      )}
    </Card>
  );
}
