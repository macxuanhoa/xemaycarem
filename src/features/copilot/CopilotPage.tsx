import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Sparkles,
  Bot,
  Send,
  RotateCcw,
  BookOpen,
  Copy,
  Check,
  Boxes,
  TrendingUp,
  Receipt,
  Wrench,
  Lightbulb,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button, Card, ErrorState } from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { isOwner } from "@/lib/permissions";
import { MarkdownLite } from "@/lib/markdownLite";
import { detectDraftAction } from "@/lib/shorthand/draftActions";
import {
  citationNodes,
  CitationList,
  isCurrentStockCitation,
} from "./CitationLinks";
import { DraftActionCard } from "./DraftActionCard";
import type { CopilotAnswer, CopilotMode } from "@/types";
import type { DraftAction } from "@/lib/shorthand/draftActions";

const MODE_KEY = "carem-copilot-mode";

const readStoredMode = (): CopilotMode => {
  try {
    return window.localStorage.getItem(MODE_KEY) === "llm"
      ? "llm"
      : "deterministic";
  } catch {
    return "deterministic";
  }
};

const QUESTIONS: { text: string; ownerOnly?: boolean }[] = [
  { text: "Tình hình cửa hàng hôm nay?" },
  { text: "Còn bao nhiêu xe trong kho?" },
  { text: "Doanh thu tháng này?" },
  { text: "Đơn bán gần đây?" },
  { text: "Xe nào tồn lâu nhất?" },
  { text: "Ai đang nợ nhiều nhất?" },
  { text: "Thu tiền hôm nay ra sao?" },
  { text: "Chi phí sửa xe gần đây?" },
  { text: "Lịch sử thao tác hôm nay?", ownerOnly: true },
];

const PROMPT_STARTERS = [
  {
    icon: Boxes,
    tag: "Kho & Tồn xe",
    title: "Tình hình kho xe",
    desc: "Còn bao nhiêu xe trong kho & xe nào tồn lâu nhất?",
    prompt: "Còn bao nhiêu xe trong kho?",
  },
  {
    icon: TrendingUp,
    tag: "Doanh thu & Bán xe",
    title: "Hiệu quả kinh doanh",
    desc: "Doanh thu tháng này và các đơn bán xe gần đây",
    prompt: "Doanh thu tháng này?",
  },
  {
    icon: Receipt,
    tag: "Công nợ khách hàng",
    title: "Công nợ & Dòng tiền",
    desc: "Khách nào đang nợ nhiều nhất và hôm nay thu được bao nhiêu?",
    prompt: "Ai đang nợ nhiều nhất?",
  },
  {
    icon: Wrench,
    tag: "Chi phí vận hành",
    title: "Bảo dưỡng & Phụ tùng",
    desc: "Chi phí sửa chữa và phụ tùng gần đây của cửa hàng",
    prompt: "Chi phí sửa xe gần đây?",
  },
];

type ChatTurn = {
  id: string;
  question: string;
  answer?: CopilotAnswer;
  draftAction?: DraftAction | null;
  timestamp: string;
};

export default function CopilotPage() {
  const { profile } = useAuth();
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<CopilotMode>(readStoredMode);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [, setHistory] = useState<
    { question: string; answer: CopilotAnswer }[]
  >([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const pendingRequest = useRef(false);
  const currentTurnId = useRef<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const owner = isOwner(profile);

  const scrollToBottom = useCallback((smooth = true) => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "end",
      });
    }
  }, []);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, 160);
    el.style.height = `${Math.max(nextHeight, 44)}px`;
  }, []);

  const ask = useMutation({
    mutationFn: (asked: string) =>
      api.copilot(asked, owner ? mode : "deterministic"),
    onSuccess: (result, asked) => {
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === currentTurnId.current
            ? {
                ...turn,
                answer: result,
                draftAction: detectDraftAction(asked),
              }
            : turn,
        ),
      );
      setHistory((previous) =>
        [
          { question: asked, answer: result },
          ...previous.filter((item) => item.question !== asked),
        ].slice(0, 6),
      );
    },
    onSettled: () => {
      pendingRequest.current = false;
      setTimeout(() => scrollToBottom(true), 60);
    },
  });

  const suggested = QUESTIONS.filter((item) => owner || !item.ownerOnly);

  const selectQuestion = (next: string) => {
    if (pendingRequest.current) return;
    setQuestion(next);
    ask.reset();
    setTimeout(() => {
      adjustTextareaHeight();
      textareaRef.current?.focus();
    }, 0);
  };

  const submitQuestion = (next: string) => {
    const asked = next.trim();
    if (pendingRequest.current || asked.length < 2) return;
    pendingRequest.current = true;

    const turnId = `turn-${Date.now()}`;
    currentTurnId.current = turnId;
    const timestamp = new Date().toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
    });

    setTurns((prev) => [
      ...prev,
      {
        id: turnId,
        question: asked,
        timestamp,
      },
    ]);
    setQuestion("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    ask.mutate(asked);
    setTimeout(() => scrollToBottom(true), 50);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitQuestion(question);
    }
  };

  const resetChat = () => {
    if (pendingRequest.current) return;
    setTurns([]);
    setQuestion("");
    ask.reset();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const copyAnswer = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback if browser permission denied
    }
  };

  useEffect(() => {
    if (turns.length > 0) {
      scrollToBottom(false);
    }
  }, [turns.length, scrollToBottom]);

  const questionChip = (item: (typeof QUESTIONS)[number]) => (
    <button
      type="button"
      key={item.text}
      className="copilot-chip"
      disabled={ask.isPending}
      onClick={() => selectQuestion(item.text)}
    >
      {item.text}
    </button>
  );

  return (
    <div className="copilot-layout-container">
      {/* 1. Header Bar: Tinh tế, chuẩn ứng dụng trò chuyện AI */}
      <header className="copilot-topbar">
        <div className="copilot-topbar-left">
          <div className="copilot-avatar-badge" aria-hidden="true">
            <Sparkles size={18} />
          </div>
          <div className="copilot-topbar-headings">
            <div className="copilot-title-row">
              <h1 className="copilot-page-title">Trợ lý Cà Rem</h1>
              <span className="copilot-status-indicator">
                <span className="copilot-pulse-dot" aria-hidden="true" />
                <span>Sẵn sàng</span>
              </span>
            </div>
            <p className="copilot-page-subtitle">
              Tra cứu kho xe, bán hàng &amp; công nợ thời gian thực
            </p>
          </div>
        </div>

        <div className="copilot-topbar-actions">
          {turns.length > 0 && (
            <button
              type="button"
              className="copilot-topbar-btn"
              onClick={resetChat}
              title="Xóa đoạn chat và bắt đầu mới"
            >
              <RotateCcw size={15} aria-hidden="true" />
              <span>Đoạn chat mới</span>
            </button>
          )}
          <Link
            to="/docs"
            className="copilot-topbar-btn secondary"
            title="Xem kho tài liệu đối chiếu của cửa hàng"
          >
            <BookOpen size={15} aria-hidden="true" />
            <span>Tài liệu</span>
          </Link>
        </div>
      </header>

      {/* 2. Chat Viewport: Dòng thời gian trò chuyện */}
      <div className="copilot-messages-viewport">
        <div className="copilot-messages-inner">
          {/* Màn hình khởi đầu khi chưa gửi tin nhắn (ChatGPT Welcome Screen) */}
          {turns.length === 0 && !ask.isPending && (
            <div className="copilot-welcome-hero">
              <div className="copilot-welcome-brand">
                <div className="copilot-welcome-icon" aria-hidden="true">
                  <Bot size={36} />
                </div>
                <h2 className="copilot-welcome-heading">
                  Chào bạn! Trợ lý Cà Rem có thể giúp gì cho bạn?
                </h2>
                <p className="copilot-welcome-description">
                  Hỏi đáp mọi dữ liệu thực tế của cửa hàng: số lượng xe trong kho,
                  doanh thu bán hàng, công nợ khách mua hay chi phí bảo dưỡng.
                </p>
              </div>

              <div className="copilot-starters-grid">
                {PROMPT_STARTERS.map((item) => (
                  <button
                    key={item.tag}
                    type="button"
                    className="copilot-starter-card"
                    onClick={() => selectQuestion(item.prompt)}
                  >
                    <div className="copilot-starter-icon-wrap" aria-hidden="true">
                      <item.icon size={20} />
                    </div>
                    <div className="copilot-starter-text">
                      <span className="copilot-starter-tag">{item.tag}</span>
                      <strong className="copilot-starter-title">{item.title}</strong>
                      <span className="copilot-starter-desc">{item.desc}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Luồng hội thoại các lượt hỏi - đáp */}
          {turns.map((turn) => {
            const turnChips = turn.answer
              ? citationNodes(turn.answer.citations ?? [])
              : {};
            const hasCurrentStock = turn.answer?.citations.some(
              isCurrentStockCitation,
            );

            return (
              <div className="copilot-turn-group" key={turn.id}>
                {/* Lượt hỏi của người dùng (User Bubble) */}
                <div className="copilot-turn copilot-turn-user">
                  <div className="copilot-user-bubble">
                    <p className="copilot-user-text">{turn.question}</p>
                    <span className="copilot-turn-time">{turn.timestamp}</span>
                  </div>
                </div>

                {/* Lượt trả lời của Trợ lý Cà Rem (Assistant Response) */}
                {turn.answer && (
                  <div className="copilot-turn copilot-turn-assistant">
                    <div className="copilot-turn-avatar" aria-hidden="true">
                      <Sparkles size={16} />
                    </div>
                    <div className="copilot-turn-content">
                      <Card className="copilot-answer-card compact-card">
                        {/* Header thông tin trả lời */}
                        <div className="copilot-answer-header">
                          <div className="copilot-answer-meta">
                            <span className="copilot-answer-by" role="status">
                              {turn.answer.mode === "llm"
                                ? "AI Cà Rem tóm tắt"
                                : "Cà Rem tra cứu trực tiếp"}
                            </span>
                            {turn.answer.period && (
                              <span className="copilot-period-badge">
                                Kỳ {turn.answer.period}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="copilot-copy-btn"
                            onClick={() =>
                              copyAnswer(
                                turn.id,
                                turn.answer?.answer_markdown ?? "",
                              )
                            }
                            title="Sao chép nội dung trả lời"
                            aria-label="Sao chép câu trả lời"
                          >
                            {copiedId === turn.id ? (
                              <>
                                <Check size={13} aria-hidden="true" />
                                <span>Đã chép</span>
                              </>
                            ) : (
                              <>
                                <Copy size={13} aria-hidden="true" />
                                <span>Sao chép</span>
                              </>
                            )}
                          </button>
                        </div>

                        {/* Tiêu chí nhắc lại câu hỏi - để kiểm tra & người dùng đối chiếu */}
                        <p className="copilot-question-echo">
                          Bạn hỏi: “{turn.question}”
                        </p>

                        {/* Chú thích kỳ báo cáo vs tồn kho hiện tại */}
                        {hasCurrentStock && turn.answer.period && (
                          <div className="copilot-stock-note">
                            <Lightbulb size={15} aria-hidden="true" />
                            <span>
                              Tồn kho là số xe hiện tại. Kỳ {turn.answer.period}{" "}
                              áp dụng cho số liệu giao dịch, không phải tồn kho
                              trong quá khứ.
                            </span>
                          </div>
                        )}

                        {/* Tóm tắt các số liệu nổi bật trước khi đọc bài viết */}
                        {turn.answer.facts.length > 0 && (
                          <div
                            className="copilot-key-metrics-bar"
                            aria-label="Số liệu nổi bật"
                          >
                            {turn.answer.facts.slice(0, 4).map((fact) => (
                              <div
                                key={`${fact.label}-${fact.citation}`}
                                className="copilot-metric-badge"
                              >
                                <span className="copilot-metric-name">
                                  {fact.label}
                                </span>
                                <strong className="copilot-metric-number">
                                  {fact.display}
                                </strong>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Nội dung markdown câu trả lời */}
                        <div className="copilot-markdown-wrap">
                          <MarkdownLite
                            text={turn.answer.answer_markdown}
                            citations={turnChips}
                            className="copilot-answer"
                          />
                        </div>

                        {/* Cảnh báo nếu có */}
                        {turn.answer.warnings.length > 0 && (
                          <div className="copilot-warnings">
                            {turn.answer.warnings.map((warning) => (
                              <p className="notice" key={warning}>
                                <AlertTriangle size={15} aria-hidden="true" />
                                <span>{warning}</span>
                              </p>
                            ))}
                          </div>
                        )}

                        {/* Accordion nguồn đối chiếu: Gọn gàng, mặc định đóng */}
                        <details className="copilot-evidence">
                          <summary>
                            Nguồn &amp; số liệu đã tra (
                            {turn.answer.citations.length} nguồn)
                          </summary>
                          <div className="copilot-evidence-body">
                            {turn.answer.facts.length > 0 && (
                              <ul
                                className="copilot-facts"
                                aria-label="Số liệu đã tra"
                              >
                                {turn.answer.facts.map((fact) => (
                                  <li key={`${fact.label}-${fact.citation}`}>
                                    <span>{fact.label}</span>
                                    <strong>{fact.display}</strong>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {turn.answer.citations.length ? (
                              <CitationList citations={turn.answer.citations} />
                            ) : (
                              <p className="muted">
                                Chưa có nguồn khớp. Thử thêm từ khóa hoặc biển
                                số / số khung.
                              </p>
                            )}
                            {turn.answer.doc_excerpts.length > 0 && (
                              <div className="copilot-excerpts">
                                {turn.answer.doc_excerpts.map((document) => (
                                  <blockquote
                                    key={document.id}
                                    className="copilot-excerpt"
                                  >
                                    <MarkdownLite
                                      text={document.excerpt}
                                      citations={turnChips}
                                    />
                                    <cite>
                                      — {document.title}
                                      {document.section
                                        ? ` · ${document.section}`
                                        : ""}
                                    </cite>
                                  </blockquote>
                                ))}
                              </div>
                            )}
                          </div>
                        </details>

                        {/* Gợi ý mở nhanh các trang liên quan */}
                        {turn.answer.suggestions.length > 0 && (
                          <div className="copilot-suggestions-row">
                            <span className="copilot-suggestions-lead">
                              Gợi ý trang liên quan:
                            </span>
                            <div className="copilot-chips">
                              {turn.answer.suggestions.map((suggestion) => (
                                <Link
                                  key={suggestion.route}
                                  className="copilot-chip"
                                  to={suggestion.route}
                                >
                                  <span>{suggestion.label}</span>
                                  <ExternalLink size={12} aria-hidden="true" />
                                </Link>
                              ))}
                            </div>
                          </div>
                        )}
                      </Card>

                      {/* Đề xuất thao tác nhanh nếu nhận diện được lệnh tốc ký */}
                      {turn.draftAction && (
                        <div className="copilot-draft-embed">
                          <DraftActionCard action={turn.draftAction} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Trạng thái đang suy nghĩ / tra cứu (Thinking state) */}
          {ask.isPending && (
            <div className="copilot-turn copilot-turn-assistant is-thinking">
              <div
                className="copilot-turn-avatar pulsing"
                aria-hidden="true"
              >
                <Sparkles size={16} />
              </div>
              <div className="copilot-turn-content">
                <div className="copilot-thinking-card">
                  <div className="copilot-thinking-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="copilot-thinking-label">
                    Đang tra cứu và đối chiếu dữ liệu Cà Rem…
                  </span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} className="copilot-scroll-anchor" />
        </div>
      </div>

      {/* 3. Composer Dock: Khung nhập câu hỏi cố định dưới cùng chuẩn ChatGPT */}
      <div className="copilot-composer-dock">
        <div className="copilot-composer-inner">
          {/* Hàng gợi ý câu hỏi nhanh */}
          <div className="copilot-prompt-pill-bar">
            <div
              className="copilot-chips"
              role="group"
              aria-label="Câu hỏi gợi ý"
            >
              {suggested.slice(0, 3).map(questionChip)}
            </div>
            <details className="copilot-more-questions">
              <summary>Câu hỏi khác</summary>
              <div
                className="copilot-chips"
                role="group"
                aria-label="Thêm câu hỏi gợi ý"
              >
                {suggested.slice(3).map(questionChip)}
              </div>
            </details>
          </div>

          {/* Form nhập câu hỏi chính */}
          <Card className="copilot-composer compact-card">
            <form
              className="copilot-composer-form"
              aria-busy={ask.isPending}
              onSubmit={(event) => {
                event.preventDefault();
                submitQuestion(question);
              }}
            >
              <div className="copilot-input-capsule">
                <textarea
                  ref={textareaRef}
                  id="copilot-question"
                  className="copilot-input"
                  aria-label="Bạn muốn hỏi gì về cửa hàng?"
                  rows={1}
                  disabled={ask.isPending}
                  maxLength={2000}
                  placeholder="Hỏi về kho xe, đơn bán, công nợ, chi phí hoặc nhập lệnh tốc ký… (Enter để gửi)"
                  value={question}
                  onKeyDown={handleKeyDown}
                  onChange={(event) => {
                    setQuestion(event.target.value);
                    adjustTextareaHeight();
                  }}
                />
                <Button
                  type="submit"
                  className="copilot-send-button"
                  disabled={ask.isPending || question.trim().length < 2}
                  aria-label="Hỏi Cà Rem"
                  title="Gửi câu hỏi (Enter)"
                >
                  <Send size={15} aria-hidden="true" />
                  <span className="copilot-send-button-text">Hỏi Cà Rem</span>
                </Button>
              </div>

              {/* Tùy chọn quyền hạn & Chế độ AI */}
              <div className="copilot-controls">
                {owner ? (
                  <label className="copilot-mode-toggle">
                    <input
                      type="checkbox"
                      checked={mode === "llm"}
                      disabled={ask.isPending}
                      onChange={(event) => {
                        if (pendingRequest.current) return;
                        const next: CopilotMode = event.target.checked
                          ? "llm"
                          : "deterministic";
                        setMode(next);
                        try {
                          window.localStorage.setItem(MODE_KEY, next);
                        } catch {
                          // Storage can be blocked in private mode
                        }
                        ask.reset();
                      }}
                    />
                    <span className="copilot-mode-label">
                      <Sparkles size={14} aria-hidden="true" />
                      <span>Bật AI viết câu tóm tắt</span>
                    </span>
                  </label>
                ) : (
                  <p className="muted small copilot-staff-notice">
                    Chỉ chủ cửa hàng bật được AI viết tóm tắt. Bạn đang tra cứu
                    theo quyền của mình.
                  </p>
                )}
                <span className="copilot-disclaimer-note">
                  Trợ lý Cà Rem đọc dữ liệu trực tiếp theo quyền hạn của bạn.
                </span>
              </div>

              {ask.error != null && <ErrorState error={ask.error} />}
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
