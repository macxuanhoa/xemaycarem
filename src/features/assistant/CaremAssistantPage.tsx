import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Bot,
  CalendarDays,
  CalendarRange,
  ChevronRight,
  Clock3,
  FileText,
  Lightbulb,
  Package,
  Paperclip,
  Send,
  Sparkles,
  TrendingUp,
  User,
  Users,
  Wallet,
  Wrench,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { ErrorState } from "@/components/ui";
import { MarkdownLite } from "@/lib/markdownLite";
import { detectDraftAction } from "@/lib/shorthand/draftActions";
import { DraftActionCard } from "@/features/copilot/DraftActionCard";
import {
  citationNodes,
  CitationList,
  isCurrentStockCitation,
} from "@/features/copilot/CitationLinks";
import type { CopilotAnswer } from "@/types";

const BANNER_KEY = "carem-assistant-banner-hidden";

type ThreadItem =
  | { id: number; role: "user"; question: string }
  | { id: number; role: "assistant"; question: string; answer: CopilotAnswer }
  | { id: number; role: "error"; question: string; error: unknown };

type Category = {
  icon: typeof Package;
  tint: "blue" | "green" | "red" | "amber";
  title: string;
  desc: string;
  question: string;
};

type Ask = { icon: typeof Package; text: string };

const categories: Category[] = [
  {
    icon: Package,
    tint: "blue",
    title: "Kho & Tồn xe",
    desc: "Tình hình kho, số lượng, xe nào tồn lâu?",
    question: "Hiện đang có bao nhiêu xe trong kho?",
  },
  {
    icon: BarChart3,
    tint: "blue",
    title: "Doanh thu & Bán xe",
    desc: "Hiệu quả kinh doanh, lợi nhuận, xu hướng",
    question: "Doanh thu tháng này là bao nhiêu?",
  },
  {
    icon: Users,
    tint: "green",
    title: "Khách hàng",
    desc: "Tra thông tin, lịch sử mua bán",
    question: "Khách hàng mua xe gần đây?",
  },
  {
    icon: Wrench,
    tint: "red",
    title: "Bảo dưỡng & Chi phí",
    desc: "Chi phí sửa chữa, bảo dưỡng theo xe",
    question: "Chi phí bảo dưỡng tháng này là bao nhiêu?",
  },
  {
    icon: FileText,
    tint: "red",
    title: "Công nợ",
    desc: "Khách còn nợ bao nhiêu, đã thanh toán chưa?",
    question: "Khách hàng còn nợ bao nhiêu tiền?",
  },
  {
    icon: Lightbulb,
    tint: "amber",
    title: "Gợi ý & Phân tích",
    desc: "Xu hướng, đề xuất giá, nhận định thông minh",
    question: "Tình hình cửa hàng hôm nay?",
  },
];

const asks: Ask[] = [
  { icon: Package, text: "Hiện đang có bao nhiêu xe trong kho?" },
  { icon: BarChart3, text: "Doanh thu tháng này là bao nhiêu?" },
  { icon: Clock3, text: "Những xe nào tồn kho trên 3 tháng?" },
  { icon: User, text: "Khách ABC đã mua những xe nào?" },
  { icon: TrendingUp, text: "Lợi nhuận của xe biển số 43A-12345?" },
  { icon: Wrench, text: "Chi phí bảo dưỡng tháng này là bao nhiêu?" },
  { icon: Users, text: "Ai đang nợ nhiều nhất?" },
  { icon: FileText, text: "Đơn bán hàng gần đây?" },
  { icon: TrendingUp, text: "Xe nào tồn lâu nhất?" },
  { icon: Clock3, text: "Thu tiền hôm nay ra sao?" },
];

const quickActions: Ask[] = [
  { icon: CalendarDays, text: "Tóm tắt hôm nay" },
  { icon: CalendarRange, text: "Báo cáo tuần" },
  { icon: Clock3, text: "Xe tồn lâu" },
  { icon: Wallet, text: "Khách còn nợ" },
];

const quickQuestions: Record<string, string> = {
  "Tóm tắt hôm nay": "Tình hình cửa hàng hôm nay?",
  "Báo cáo tuần": "Tóm tắt kết quả kinh doanh tuần này?",
  "Xe tồn lâu": "Những xe nào tồn kho lâu nhất?",
  "Khách còn nợ": "Khách hàng còn nợ bao nhiêu tiền?",
};

const hourInVietnam = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Asia/Ho_Chi_Minh",
    }).format(new Date()),
  );

const greeting = () => {
  const hour = hourInVietnam();
  if (hour < 12) return "Chào buổi sáng";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
};

const readBannerHidden = () => {
  try {
    return window.localStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return false;
  }
};

function AssistantMessage({
  item,
}: {
  item: Extract<ThreadItem, { role: "assistant" }>;
}) {
  const chips = useMemo(
    () => citationNodes(item.answer.citations),
    [item.answer.citations],
  );
  const hasCurrentStock = item.answer.citations.some(isCurrentStockCitation);
  return (
    <div className="ca-msg ca-msg-bot">
      <span className="ca-avatar" aria-hidden="true">
        <Bot size={18} />
      </span>
      <div className="ca-bubble">
        <p className="ca-msg-meta">
          Trợ lý Cà Rem
          {item.answer.period ? ` · kỳ ${item.answer.period}` : ""}
        </p>
        <div className="ca-answer">
          <MarkdownLite text={item.answer.answer_markdown} citations={chips} />
        </div>
        {hasCurrentStock && item.answer.period && (
          <p className="copilot-stock-note">
            Tồn kho là số xe hiện tại. Kỳ {item.answer.period} áp dụng cho số
            liệu giao dịch, không phải tồn kho trong quá khứ.
          </p>
        )}
        {item.answer.facts.length > 0 && (
          <ul className="copilot-facts" aria-label="Số liệu đã tra">
            {item.answer.facts.map((fact) => (
              <li key={`${fact.label}-${fact.citation}`}>
                <span>{fact.label}</span>
                <strong>{fact.display}</strong>
              </li>
            ))}
          </ul>
        )}
        {item.answer.warnings.map((warning) => (
          <p className="notice" key={warning}>
            {warning}
          </p>
        ))}
        {item.answer.citations.length > 0 && (
          <details className="copilot-evidence">
            <summary>
              Nguồn &amp; số liệu đã tra ({item.answer.citations.length} nguồn)
            </summary>
            <div className="copilot-evidence-body">
              <CitationList citations={item.answer.citations} />
            </div>
          </details>
        )}
        {item.answer.suggestions.length > 0 && (
          <div className="copilot-chips">
            {item.answer.suggestions.map((suggestion) => (
              <Link
                key={suggestion.route}
                className="copilot-chip"
                to={suggestion.route}
              >
                {suggestion.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CaremAssistantPage() {
  const [input, setInput] = useState("");
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [showAllAsks, setShowAllAsks] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(readBannerHidden);
  const nextId = useRef(1);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const busy = pending != null;

  const ask = async (raw: string) => {
    const question = raw.trim();
    if (busy || question.length < 2) return;
    setInput("");
    setPending(question);
    const userId = nextId.current++;
    const replyId = nextId.current++;
    try {
      const answer = await api.copilot(question, "deterministic");
      setThread((previous) => [
        ...previous,
        { id: userId, role: "user", question },
        { id: replyId, role: "assistant", question, answer },
      ]);
    } catch (error) {
      setThread((previous) => [
        ...previous,
        { id: userId, role: "user", question },
        { id: replyId, role: "error", question, error },
      ]);
    } finally {
      setPending(null);
    }
  };

  useEffect(() => {
    if (thread.length > 0 || pending)
      threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread, pending]);

  const lastUserQuestion = [...thread].reverse().find((item) => item.role === "user");
  const draftAction =
    lastUserQuestion?.role === "user"
      ? detectDraftAction(lastUserQuestion.question)
      : null;
  const visibleAsks = showAllAsks ? asks : asks.slice(0, 6);

  const dismissBanner = () => {
    setBannerHidden(true);
    try {
      window.localStorage.setItem(BANNER_KEY, "1");
    } catch {
      // Storage can be blocked in private mode; the banner just reappears later.
    }
  };

  return (
    <div className="assistant-page">
      <section className="ca-hero">
        <div className="ca-hero-text">
          <span className="ca-pill">
            <Sparkles size={13} aria-hidden="true" />
            Trợ lý Cà Rem
          </span>
          <h1 className="ca-hero-title">
            {greeting()}! 👋
            <br />
            Mình có thể giúp gì cho bạn <span>hôm nay?</span>
          </h1>
          <p className="ca-hero-desc">
            Hỏi đáp từ dữ liệu thực tế của cửa hàng: kho xe, doanh thu, bán
            hàng, công nợ, khách hàng, chi phí bảo dưỡng và nhiều hơn nữa.
          </p>
        </div>
        <div className="ca-hero-art">
          <p className="ca-bubble">Hỏi bất cứ điều gì về cửa hàng nhé!</p>
          <img
            src="/carem-assistant-robot.png"
            alt="Trợ lý Cà Rem — robot thân thiện của cửa hàng"
          />
        </div>
      </section>

      <div className="ca-cats" role="list" aria-label="Chủ đề tra cứu">
        {categories.map(({ icon: Icon, tint, title, desc, question }) => (
          <button
            key={title}
            type="button"
            role="listitem"
            className="ca-cat"
            disabled={busy}
            onClick={() => void ask(question)}
          >
            <span className={`ca-cat-icon tint-${tint}`} aria-hidden="true">
              <Icon size={19} strokeWidth={2.1} />
            </span>
            <span className="ca-cat-body">
              <strong>{title}</strong>
              <small>{desc}</small>
            </span>
            <ChevronRight size={16} className="ca-cat-chevron" aria-hidden="true" />
          </button>
        ))}
      </div>

      <section className="ca-asks" aria-label="Câu hỏi gợi ý">
        <div className="ca-sec-head">
          <h2>
            <Sparkles size={15} aria-hidden="true" /> Bạn có thể hỏi
          </h2>
          <button
            type="button"
            className="ca-sec-link"
            onClick={() => setShowAllAsks((open) => !open)}
          >
            {showAllAsks ? "Thu gọn" : "Xem tất cả"}
            <ArrowRight
              size={14}
              aria-hidden="true"
              style={showAllAsks ? { transform: "rotate(90deg)" } : undefined}
            />
          </button>
        </div>
        <div className="ca-ask-grid">
          {visibleAsks.map(({ icon: Icon, text }) => (
            <button
              key={text}
              type="button"
              className="ca-ask"
              disabled={busy}
              onClick={() => void ask(text)}
            >
              <span className="ca-ask-icon" aria-hidden="true">
                <Icon size={16} strokeWidth={2.1} />
              </span>
              <span>{text}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      {!bannerHidden && (
        <aside className="ca-banner" role="note">
          <span className="ca-banner-icon" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <div>
            <strong>Hỏi nhanh – Nhận câu trả lời chính xác</strong>
            <p>
              Dựa trên dữ liệu thực tế của cửa hàng, cập nhật theo thời gian thực.
            </p>
          </div>
          <button
            type="button"
            className="ca-banner-close"
            aria-label="Đóng gợi ý"
            onClick={dismissBanner}
          >
            <X size={16} />
          </button>
        </aside>
      )}

      {(thread.length > 0 || pending) && (
        <section className="ca-thread" aria-label="Cuộc trò chuyện với Trợ lý Cà Rem">
          <h2 className="ca-thread-title">
            <Bot size={16} aria-hidden="true" /> Trò chuyện
          </h2>
          {thread.map((item) => {
            if (item.role === "user")
              return (
                <div key={item.id} className="ca-msg ca-msg-user">
                  <p className="ca-bubble-user">{item.question}</p>
                </div>
              );
            if (item.role === "error")
              return (
                <div key={item.id} className="ca-msg ca-msg-bot">
                  <span className="ca-avatar" aria-hidden="true">
                    <Bot size={18} />
                  </span>
                  <div className="ca-bubble">
                    <ErrorState error={item.error} />
                  </div>
                </div>
              );
            return <AssistantMessage key={item.id} item={item} />;
          })}
          {pending && (
            <div className="ca-msg ca-msg-user">
              <p className="ca-bubble-user">{pending}</p>
            </div>
          )}
          {pending && (
            <div className="ca-msg ca-msg-bot">
              <span className="ca-avatar" aria-hidden="true">
                <Bot size={18} />
              </span>
              <div className="ca-bubble ca-typing" aria-live="polite">
                <span />
                <span />
                <span />
                <em>Trợ lý Cà Rem đang tra cứu…</em>
              </div>
            </div>
          )}
          {draftAction && <DraftActionCard action={draftAction} />}
          <div ref={threadEndRef} />
        </section>
      )}

      <form
        className="ca-composer"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void ask(input);
        }}
      >
        <Link
          to="/capture"
          className="ca-attach"
          title="Chụp / quét giấy tờ xe ở Camera thông minh"
          aria-label="Chụp / quét giấy tờ xe ở Camera thông minh"
        >
          <Paperclip size={18} />
        </Link>
        <input
          value={input}
          disabled={busy}
          maxLength={2000}
          placeholder="Hỏi về kho xe, đơn bán, khách hàng,…"
          aria-label="Câu hỏi cho Trợ lý Cà Rem"
          onChange={(event) => setInput(event.target.value)}
        />
        <button
          type="submit"
          className="ca-send"
          disabled={busy || input.trim().length < 2}
          aria-label="Gửi câu hỏi"
        >
          <Send size={17} />
        </button>
      </form>

      <div className="ca-quick" role="group" aria-label="Hỏi nhanh">
        {quickActions.map(({ icon: Icon, text }) => (
          <button
            key={text}
            type="button"
            disabled={busy}
            onClick={() => void ask(quickQuestions[text])}
          >
            <Icon size={14} aria-hidden="true" />
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
