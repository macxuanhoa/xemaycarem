// AI Brand Memory — bộ nhớ phong cách Cà Rem dùng chung cho Post Studio và
// Trợ lý trả lời. OWNER nhập bài Facebook/Zalo thật (EXAMPLE) hoặc quy tắc
// viết bài (RULE) và duyệt hàng chờ; MANAGER/STAFF chỉ gợi ý (rơi vào PENDING)
// và chỉ đọc nội dung APPROVED. AI chỉ được nhồi các mục APPROVED.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Check, ScrollText, ShieldCheck, X } from "lucide-react";
import "@/styles-poststudio.css";
import { toast } from "@/lib/toast";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { postStudio, type BrandEntry } from "@/lib/postStudioApi";

const channelLabels: Record<string, string> = {
  FACEBOOK: "Facebook",
  FB_GROUP: "Hội nhóm FB",
  ZALO: "Zalo",
  MESSENGER: "Messenger",
  ANY: "Mọi kênh",
};

export default function BrandMemoryPage() {
  const { profile } = useAuth();
  const client = useQueryClient();
  const isOwner = profile?.role === "OWNER";
  const [tab, setTab] = useState<"PENDING" | "APPROVED">(isOwner ? "PENDING" : "APPROVED");
  const [entryType, setEntryType] = useState<"EXAMPLE" | "RULE">("EXAMPLE");
  const [channel, setChannel] = useState("ANY");
  const [content, setContent] = useState("");

  const list = useQuery({
    queryKey: ["brand-memory", tab],
    queryFn: () => postStudio.listBrandMemory({ status: tab, limit: 30 }),
  });

  const save = useMutation({
    mutationFn: () => {
      const text = content.trim();
      if (text.length < 10) throw new Error("Nội dung mẫu/quy tắc cần ≥ 10 ký tự.");
      return postStudio.saveBrandMemory({
        entry_type: entryType,
        channel: entryType === "RULE" ? "ANY" : channel,
        content: text.slice(0, 4000),
      });
    },
    onSuccess: () => {
      setContent("");
      toast.success(
        isOwner ? "Đã lưu vào bộ nhớ đã duyệt." : "Đã gửi để chủ quán xem và duyệt.",
      );
      client.invalidateQueries({ queryKey: ["brand-memory"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const approve = useMutation({
    mutationFn: (args: { id: string; approve: boolean }) =>
      postStudio.approveBrandMemory(args.id, args.approve),
    onSuccess: (_data, args) => {
      toast.success(args.approve ? "Đã duyệt — AI sẽ học theo mục này." : "Đã từ chối.");
      client.invalidateQueries({ queryKey: ["brand-memory"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const usage = useQuery({
    queryKey: ["post-ai-usage"],
    queryFn: () => postStudio.usage(7),
    enabled: isOwner,
    staleTime: 60_000,
  });

  return (
    <div className="ps-page">
      <PageHeader
        title="Bộ nhớ thương hiệu"
        description="Nơi cất giọng viết thật của Cà Rem: bài Facebook đã đăng, câu trả lời Zalo/Messenger tiêu biểu và quy tắc chủ quán duyệt. AI chỉ học từ mục ĐÃ DUYỆT."
      />

      {isOwner && usage.data && (
        <Card className="ps-step">
          <h2>
            <ShieldCheck size={16} aria-hidden="true" /> Hạn mức AI 7 ngày
          </h2>
          <p className="ps-source">
            {usage.data.requests} lượt · {usage.data.quota} lần chạm hạn mức ·{" "}
            {usage.data.errors ?? 0} lần lỗi/bị chặn bảo vệ ·{" "}
            {(usage.data.input_tokens + usage.data.output_tokens).toLocaleString("vi-VN")} token
          </p>
          {usage.data.requests >= 40 && (
            <p className="ps-hint">
              ⚠ Đã {usage.data.requests} lượt trong 7 ngày —Free Tier của Gemini có hạn theo ngày;
              cân nhắc giảm lượt tạo lại để dành cho tuần cao điểm.
            </p>
          )}
        </Card>
      )}

      <Card className="ps-step">
        <h2>
          <BookMarked size={16} aria-hidden="true" /> Thêm nội dung mới
        </h2>
        <div className="ps-chiprow" role="group" aria-label="Loại nội dung">
          <button
            type="button"
            className={`ps-chip${entryType === "EXAMPLE" ? " is-active" : ""}`}
            aria-pressed={entryType === "EXAMPLE"}
            onClick={() => setEntryType("EXAMPLE")}
          >
            Bài mẫu / tin nhắn mẫu
          </button>
          <button
            type="button"
            className={`ps-chip${entryType === "RULE" ? " is-active" : ""}`}
            aria-pressed={entryType === "RULE"}
            onClick={() => setEntryType("RULE")}
            disabled={!isOwner}
            title={isOwner ? undefined : "Chỉ OWNER được đặt quy tắc"}
          >
            <ScrollText size={14} aria-hidden="true" /> Quy tắc viết
          </button>
        </div>
        {entryType === "EXAMPLE" && (
          <Field label="Kênh">
            <select value={channel} onChange={(event) => setChannel(event.target.value)}>
              {Object.entries(channelLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={entryType === "EXAMPLE" ? "Nguyên văn bài/tin nhắn đã dùng thật" : "Quy tắc (VD: không bao giờ nêu giá trong bài công khai)"}>
          <textarea
            rows={4}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Dán nội dung thật… KHÔNG dán thông tin giá thu, CCCD hay số điện thoại khách."
          />
        </Field>
        <div className="ps-caption-actions">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Đang lưu…" : isOwner ? "Lưu vào bộ nhớ" : "Gửi chủ quán duyệt"}
          </Button>
        </div>
        {!isOwner && (
          <p className="ps-hint">
            Bài bạn gửi vào hàng chờ; chỉ khi chủ quán duyệt mới được AI dùng lại.
          </p>
        )}
      </Card>

      <Card className="ps-step">
        <div className="ps-tabs" role="tablist" aria-label="Trạng thái duyệt">
          {isOwner && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "PENDING"}
              className={tab === "PENDING" ? "is-active" : ""}
              onClick={() => setTab("PENDING")}
            >
              Chờ duyệt
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "APPROVED"}
            className={tab === "APPROVED" ? "is-active" : ""}
            onClick={() => setTab("APPROVED")}
          >
            Thư viện đã duyệt
          </button>
        </div>
        {list.isPending && <Loading />}
        {list.isError && <ErrorState error={list.error} />}
        {list.data && !list.data.items.length && (
          <EmptyState
            title={tab === "PENDING" ? "Không có gì chờ duyệt" : "Thư viện còn trống"}
            description="Những bài Facebook/Zalo hay nên được lưu vào đây để AI học giọng Cà Rem."
          />
        )}
        <ul className="ps-memory-list">
          {(list.data?.items ?? []).map((entry) => (
            <MemoryRow
              key={entry.id}
              entry={entry}
              isOwner={isOwner}
              tab={tab}
              busy={approve.isPending}
              onDecide={(ok) => approve.mutate({ id: entry.id, approve: ok })}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function MemoryRow({
  entry,
  isOwner,
  tab,
  busy,
  onDecide,
}: {
  entry: BrandEntry;
  isOwner: boolean;
  tab: "PENDING" | "APPROVED";
  busy: boolean;
  onDecide: (approve: boolean) => void;
}) {
  return (
    <li className="ps-memory-row">
      <div className="ps-draft-head">
        <span className={`ps-draft-status is-${entry.entry_type.toLowerCase()}`}>
          {entry.entry_type === "RULE" ? "Quy tắc" : "Bài mẫu"}
        </span>
        <strong>{channelLabels[entry.channel] ?? entry.channel}</strong>
        <small>
          {entry.creator_name ? `${entry.creator_name} · ` : ""}
          {new Date(entry.created_at).toLocaleDateString("vi-VN")}
          {entry.source === "EDITED" ? " · bản người sửa" : entry.source === "AI" ? " · AI tạo" : ""}
        </small>
      </div>
      <p className="ps-draft-caption">{entry.content}</p>
      {tab === "PENDING" && isOwner && (
        <div className="ps-draft-actions">
          <Button onClick={() => onDecide(true)} disabled={busy}>
            <Check size={15} aria-hidden="true" /> Duyệt
          </Button>
          <Button variant="danger" onClick={() => onDecide(false)} disabled={busy}>
            <X size={15} aria-hidden="true" /> Từ chối
          </Button>
        </div>
      )}
    </li>
  );
}
