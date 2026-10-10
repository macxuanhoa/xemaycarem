// Module B — Trợ lý trả lời tin nhắn: dán nội dung khách gửi từ Messenger/Zalo,
// AI phân tích ý định, tìm xe khớp trong Kho ĐÚNG THEO QUYỀN người dùng (RPC
// find_matching_vehicles chạy dưới JWT phiên) và soạn câu trả lời ngắn gọn.
// Hệ thống KHÔNG đọc/tự gửi tin từ tài khoản cá nhân — chỉ sao chép để tự gửi.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, MessageSquareText, Search, Send, Sparkles } from "lucide-react";
import "@/styles-poststudio.css";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button, Card, EmptyState, ErrorState, Loading, PageHeader } from "@/components/ui";
import {
  postStudio,
  type AssistRefineReply,
  type AssistReplyAnswer,
} from "@/lib/postStudioApi";

const intentLabels: Record<string, string> = {
  AVAILABILITY: "Hỏi xe còn không",
  PHOTO: "Xin ảnh xe",
  PRICE: "Hỏi giá",
  VISIT: "Hẹn xem xe",
  NEGOTIATE: "Thương lượng",
  SIMILAR: "Tìm xe tương tự",
  BUYBACK: "Muốn bán xe",
  OTHER: "Chung chung",
};
const scenarioChips = [
  "Con Vision đen còn không shop?",
  "Cho xin ảnh xe với",
  "Xe bao nhiêu vậy?",
  "Cuối tuần qua xem xe được không?",
  "Rẻ chút được không bạn?",
  "Có xe nào tương tự Wave không?",
  "Nhà cần bán xe đời 2019",
];

function VehicleThumb({ path, title }: { path: string; title: string }) {
  const query = useQuery({
    queryKey: ["vehicle-image", path],
    queryFn: () => api.imageUrl(path),
    staleTime: 4 * 60 * 1000,
  });
  return query.data ? (
    <img src={query.data} alt={title} loading="lazy" />
  ) : (
    <span className="ps-image-empty">{query.isError ? "Lỗi ảnh" : "…"}</span>
  );
}

export default function ReplyAssistantPage() {
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState<AssistReplyAnswer | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [instruction, setInstruction] = useState("");
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; text: string }[]>([]);

  const analyze = useMutation({
    mutationFn: () => {
      const text = message.trim();
      if (text.length < 4) throw new Error("Dán tin nhắn của khách (≥ 4 ký tự) trước nhé.");
      return postStudio.assist<AssistReplyAnswer>({
        task: "reply",
        consent: true,
        message: text.slice(0, 2000),
      });
    },
    onSuccess: (result) => {
      setAnswer(result);
      setReplyDraft(result.reply);
      setTurns([]);
    },
    onError: (error) => toast.error(error.message),
  });

  const refineReply = useMutation({
    mutationFn: async () => {
      const ask = instruction.trim();
      if (!replyDraft.trim() || ask.length < 2) throw new Error("Nhập câu muốn sửa trước đã.");
      const boundedTurns = turns
        .slice(-4)
        .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 1000) }));
      const result = await postStudio.assist<AssistRefineReply>({
        task: "refine",
        consent: true,
        channel: "ZALO",
        caption: replyDraft.slice(0, 5000),
        instruction: ask.slice(0, 600),
        ...(boundedTurns.length ? { turns: boundedTurns } : {}),
      });
      return { ask, caption: result.caption };
    },
    onSuccess: ({ ask, caption }) => {
      setReplyDraft(caption);
      setTurns((current) =>
        [...current, { role: "user" as const, text: ask }, { role: "assistant" as const, text: caption }].slice(-6),
      );
      setInstruction("");
    },
    onError: (error) => toast.error(error.message),
  });

  // Tên xe hiện trong thẻ luôn lấy từ RPC dưới quyền người dùng, không phải từ AI.
  const search = useMutation({
    mutationFn: (query: string) => postStudio.matching(query),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(replyDraft);
      toast.success("Đã sao chép — bạn tự dán vào Messenger/Zalo và gửi nhé.");
    } catch {
      toast.error("Trình duyệt chặn clipboard. Hãy bôi đen câu trả lời và copy thủ công.");
    }
  };

  return (
    <div className="ps-page">
      <PageHeader
        title="Trợ lý trả lời tin nhắn"
        description="Dán tin khách hỏi từ Messenger/Zalo → AI đọc ý, đối chiếu kho xe theo đúng quyền của bạn, soạn câu trả lời tự nhiên. Không hệ thống nào tự gửi đi cả."
        actions={
          <Button onClick={() => analyze.mutate()} disabled={analyze.isPending}>
            <Sparkles size={16} aria-hidden="true" />
            {analyze.isPending ? "Đang đọc tin…" : "Phân tích & soạn trả lời"}
          </Button>
        }
      />

      <Card className="ps-step">
        <h2>Tin nhắn của khách</h2>
        <textarea
          className="ps-message-input"
          rows={4}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Dán nguyên văn tin nhắn khách gửi… (VD: Con Vision đen còn không shop?)"
          aria-label="Tin nhắn khách dán vào"
        />
        <div className="ps-chiprow" aria-label="Ví dụ tình huống">
          {scenarioChips.map((chip) => (
            <button key={chip} type="button" className="ps-chip" onClick={() => setMessage(chip)}>
              {chip}
            </button>
          ))}
        </div>
        <p className="ps-hint">
          Tin nhắn chỉ được gửi lên trợ lý để phân tích ý định; số điện thoại/thông tin khách
          không được lưu tự động và không xuất hiện trong bài đăng.
        </p>
      </Card>

      {analyze.isError && <ErrorState error={analyze.error} />}
      {analyze.isPending && <Loading />}

      {answer && (
        <Card className="ps-step">
          <h2>
            <MessageSquareText size={16} aria-hidden="true" /> Câu trả lời gợi ý
          </h2>
          <p className="ps-source">
            Ý định: <strong>{intentLabels[answer.intent] ?? answer.intent}</strong> · {answer.analysis}
            <br />
            AI: {answer.model} — luôn đọc lại trước khi gửi cho khách.
          </p>
          <textarea
            rows={4}
            value={replyDraft}
            onChange={(event) => setReplyDraft(event.target.value)}
            aria-label="Câu trả lời có thể sửa"
          />
          <div className="ps-caption-actions">
            <Button variant="secondary" onClick={copy}>
              <Copy size={15} aria-hidden="true" /> Sao chép trả lời
            </Button>
          </div>
          <div className="ps-chat">
            <div className="ps-chat-input">
              <input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="VD: lịch sự hơn, nhắc khách ghé quán cuối tuần…"
                aria-label="Yêu cầu sửa câu trả lời"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !refineReply.isPending) refineReply.mutate();
                }}
              />
              <Button variant="secondary" onClick={() => refineReply.mutate()} disabled={refineReply.isPending}>
                <Send size={15} aria-hidden="true" /> Sửa bằng AI
              </Button>
            </div>
            {turns.length > 0 && (
              <ul className="ps-chat-log">
                {turns.map((turn, index) => (
                  <li key={index} className={`ps-turn is-${turn.role}`}>
                    {turn.text}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="ps-vehicles">
            <h3>
              <Search size={15} aria-hidden="true" /> Xe khớp trong kho (theo quyền của bạn)
            </h3>
            {!answer.vehicles.length && (
              <EmptyState
                title="Chưa tìm ra xe khớp"
                description="Thử mô tả ngắn hơn (loại xe, màu, biển số) hoặc tra kho thủ công bên dưới."
              />
            )}
            <ul className="ps-vehicle-cards">
              {answer.vehicles.map((item) => (
                <li key={item.id} className="ps-stock-card">
                  {item.images?.[0] ? (
                    <VehicleThumb path={item.images[0].storage_path} title={item.vehicle_title} />
                  ) : (
                    <span className="ps-image-empty">Không có ảnh</span>
                  )}
                  <span>
                    <strong>{item.vehicle_title}</strong>
                    <small>{item.vehicle_subtitle ?? [item.vehicle_type, item.year, item.color].filter(Boolean).join(" · ")}</small>
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => search.mutate(String(item.license_plate ?? item.vehicle_title))}
                  >
                    Tìm thêm xe tương tự
                  </Button>
                </li>
              ))}
            </ul>
            {search.data && (
              <p className="ps-hint">
                Gợi ý liên quan:{" "}
                {search.data.items.map((item) => item.vehicle_title).join(" · ") || "không có thêm xe khớp."}
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
