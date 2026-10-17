import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  BarChart3,
  BookOpen,
  Bot,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  Lightbulb,
  Package,
  Paperclip,
  RotateCcw,
  Send,
  Sparkles,
  Users,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { MarkdownLite } from "@/lib/markdownLite";
import { useAuth } from "@/features/auth/AuthProvider";
import { isOwner } from "@/lib/permissions";
import { detectDraftAction } from "@/lib/shorthand/draftActions";
import { DraftActionCard } from "@/features/copilot/DraftActionCard";
import {
  citationNodes,
  CitationList,
  isCurrentStockCitation,
} from "@/features/copilot/CitationLinks";
import {
  FACT_CHIPS,
  loadThread,
  nextQuestions,
  quickActions,
  readBannerHidden,
  readStoredMode,
  saveThread,
  splitAnswer,
  topics,
  writeBannerHidden,
  writeStoredMode,
  type AssistantTopicId,
  type ThreadTurn,
} from "./assistantTopics";
import type { CopilotAnswer, CopilotMode } from "@/types";

const topicIcons: Record<AssistantTopicId, LucideIcon> = {
  inventory: Package,
  sales: BarChart3,
  customers: Users,
  costs: Wrench,
  debt: FileText,
  insight: Lightbulb,
};

const quickIcons = [CalendarDays, CalendarRange, Clock3, Wallet] as const;

const greeting = () => {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Asia/Ho_Chi_Minh",
    }).format(new Date()),
  );
  if (hour < 12) return "Chào buổi sáng";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
};

/**
 * Một câu trả lời: gọn — vài con số nổi bật, phần chữ ngắn, toàn bộ bằng chứng
 * nằm trong khối đóng. Không lặp lại câu hỏi, không nghiêng/bóp méo khung trả lời.
 */
function AnswerBubble({
  answer,
  followUps,
  busy,
  onAsk,
}: {
  answer: CopilotAnswer;
  followUps: string[];
  busy: boolean;
  onAsk: (question: string) => void;
}) {
  const chips = useMemo(() => citationNodes(answer.citations), [answer.citations]);
  const { head, rest } = splitAnswer(answer.answer_markdown);
  const metrics = answer.facts.slice(0, FACT_CHIPS);
  const hasCurrentStock = answer.citations.some(isCurrentStockCitation);

  return (
    <div className="ca-msg ca-msg-bot">
      <span className="ca-avatar" aria-hidden="true">
        <Bot size={18} />
      </span>
      <div className="ca-bubble">
        <p className="ca-msg-meta">
          {answer.mode === "llm" ? "AI Cà Rem tóm tắt" : "Cà Rem tra cứu trực tiếp"}
          {answer.period ? ` · kỳ ${answer.period}` : ""}
        </p>

        {metrics.length > 1 && (
          <div className="ca-metrics" aria-label="Số liệu nổi bật">
            {metrics.map((fact) => (
              <span className="ca-metric" key={`${fact.label}-${fact.citation}`}>
                <small>{fact.label}</small>
                <strong>{fact.display}</strong>
              </span>
            ))}
          </div>
        )}

        <div className="ca-answer">
          <MarkdownLite text={head} citations={chips} />
          {rest && (
            <details className="ca-more">
              <summary>Xem đầy đủ ({rest.split(/\r?\n/).length} dòng còn lại)</summary>
              <MarkdownLite text={rest} citations={chips} />
            </details>
          )}
        </div>

        {hasCurrentStock && answer.period && (
          <p className="ca-scope-note">
            <Lightbulb size={14} aria-hidden="true" />
            <span>
              Tồn kho là số xe hiện tại, không phải số liệu quá khứ của kỳ{" "}
              {answer.period}.
            </span>
          </p>
        )}

        {answer.warnings.length > 0 && (
          <ul className="ca-warnings">
            {answer.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}

        {(answer.facts.length > 0 ||
          answer.citations.length > 0 ||
          answer.doc_excerpts.length > 0) && (
          <details className="copilot-evidence">
            <summary>
              Nguồn &amp; số liệu đã tra ({answer.citations.length} nguồn)
            </summary>
            <div className="copilot-evidence-body">
              {answer.facts.length > 0 && (
                <ul className="copilot-facts" aria-label="Số liệu đã tra">
                  {answer.facts.map((fact) => (
                    <li key={`${fact.label}-${fact.citation}`}>
                      <span>{fact.label}</span>
                      <strong>{fact.display}</strong>
                    </li>
                  ))}
                </ul>
              )}
              {answer.citations.length ? (
                <CitationList citations={answer.citations} />
              ) : (
                <p className="muted">
                  Chưa có nguồn khớp. Thử thêm từ khóa hoặc biển số / số khung.
                </p>
              )}
              {answer.doc_excerpts.length > 0 && (
                <div className="copilot-excerpts">
                  {answer.doc_excerpts.map((document) => (
                    <blockquote key={document.id} className="copilot-excerpt">
                      <MarkdownLite text={document.excerpt} citations={chips} />
                      <cite>
                        — {document.title}
                        {document.section ? ` · ${document.section}` : ""}
                      </cite>
                    </blockquote>
                  ))}
                </div>
              )}
            </div>
          </details>
        )}

        {answer.suggestions.length > 0 && (
          <div className="ca-links" aria-label="Mở nhanh">
            <span className="ca-links-lead">Mở nhanh:</span>
            {answer.suggestions.map((suggestion) => (
              <Link
                key={suggestion.route}
                className="ca-link-chip"
                to={suggestion.route}
              >
                {suggestion.label}
                <ExternalLink size={12} aria-hidden="true" />
              </Link>
            ))}
          </div>
        )}

        {followUps.length > 0 && (
          <div className="ca-followups" role="group" aria-label="Câu hỏi tiếp theo">
            <span className="ca-followups-lead">Hỏi tiếp:</span>
            {followUps.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="ca-followup"
                disabled={busy}
                onClick={() => onAsk(suggestion)}
              >
                {suggestion}
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CaremAssistantPage() {
  const { profile } = useAuth();
  const owner = isOwner(profile);
  const [turns, setTurns] = useState<ThreadTurn[]>(loadThread);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<CopilotMode>(readStoredMode);
  const [openTopic, setOpenTopic] = useState<AssistantTopicId | null>(null);
  const [bannerHidden, setBannerHidden] = useState(readBannerHidden);

  const busyRef = useRef(false);
  const currentTurnId = useRef("");
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (question: string) =>
      api.copilot(question, owner ? mode : "deterministic"),
    onSuccess: (result, question) => {
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === currentTurnId.current
            ? { ...turn, answer: result, draftAction: detectDraftAction(question) }
            : turn,
        ),
      );
    },
    onError: (error) => {
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === currentTurnId.current
            ? { ...turn, errorMessage: friendlyError(error) }
            : turn,
        ),
      );
    },
    onSettled: () => {
      busyRef.current = false;
      requestAnimationFrame(() => {
        const frame = frameRef.current;
        if (frame) frame.scrollTo({ top: frame.scrollHeight, behavior: "smooth" });
      });
    },
  });

  const busy = ask.isPending;
  const chatActive = turns.length > 0 || busy;
  const askedQuestions = useMemo(
    () => Array.from(new Set(turns.map((turn) => turn.question))),
    [turns],
  );

  const growEditor = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 140)}px`;
  }, []);

  const askQuestion = (raw: string) => {
    const question = raw.trim();
    if (busyRef.current || question.length < 2) return;
    busyRef.current = true;

    const id = `turn-${Date.now()}`;
    currentTurnId.current = id;
    setTurns((previous) => [
      ...previous,
      {
        id,
        question,
        timestamp: new Date().toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      },
    ]);
    setInput("");
    if (editorRef.current) editorRef.current.style.height = "auto";
    ask.mutate(question);
  };

  const resetChat = () => {
    if (busyRef.current) return;
    setTurns([]);
    setInput("");
    setOpenTopic(null);
    ask.reset();
    saveThread([]);
    editorRef.current?.focus();
  };

  // Lịch sử giữ theo phiên: rời trang rồi quay lại vẫn còn đoạn đang hỏi.
  useEffect(() => saveThread(turns), [turns]);

  // Chiều cao trang đo từ vị trí THẬT trong viewport thay vì tin vào số đo
  // cứng trong CSS: thanh thông báo hay gợi ý cài app có xen vào đầu trang,
  // dải nhập vẫn áp sát đáy (trên .bottom-nav nếu có) và document không bao
  // giờ dài quá màn hình — kéo/cuộn chỉ còn diễn ra trong khung tin nhắn.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let queued = 0;
    const sync = () => {
      const nav = document.querySelector<HTMLElement>(".bottom-nav");
      const reserve = nav && getComputedStyle(nav).display !== "none" ? nav.offsetHeight : 0;
      const top = page.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(200, Math.round(window.innerHeight - top - reserve));
      if (`${next}px` !== page.style.height) page.style.height = `${next}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(queued);
      queued = requestAnimationFrame(sync);
    };
    schedule();
    window.addEventListener("resize", schedule);
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(document.body);
    return () => {
      cancelAnimationFrame(queued);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame && turns.length > 0) frame.scrollTop = frame.scrollHeight;
    // Chỉ canh lần mở trang có lịch sử; các lượt kế tiếp tự cuộn khi có kết quả.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissBanner = () => {
    setBannerHidden(true);
    writeBannerHidden();
  };

  const openTopicData = topics.find((topic) => topic.id === openTopic) ?? null;
  const OpenTopicIcon = openTopicData ? topicIcons[openTopicData.id] : null;

  return (
    <div ref={pageRef} className={`assistant-page${chatActive ? " is-chatting" : ""}`}>
      <header className="ca-topbar">
        <div className="ca-topbar-left">
          <span className="ca-topbar-avatar" aria-hidden="true">
            <Sparkles size={17} />
          </span>
          <div className="ca-topbar-text">
            <h1>Trợ lý Cà Rem</h1>
            <p>Kho xe, bán hàng, công nợ, chi phí — tra cứu theo quyền của bạn</p>
          </div>
        </div>
        <div className="ca-topbar-actions">
          {owner && (
            <label
              className={`ca-mode-chip${mode === "llm" ? " is-on" : ""}`}
              title="AI viết lại câu tóm tắt từ đúng bằng chứng đã tra — chỉ chủ cửa hàng bật được"
            >
              <input
                type="checkbox"
                checked={mode === "llm"}
                disabled={busy}
                aria-label="Bật AI viết câu tóm tắt"
                onChange={(event) => {
                  const next: CopilotMode = event.target.checked
                    ? "llm"
                    : "deterministic";
                  setMode(next);
                  writeStoredMode(next);
                }}
              />
              <span>AI</span>
            </label>
          )}
          {chatActive && (
            <button
              type="button"
              className="ca-topbar-btn"
              onClick={resetChat}
              aria-label="Đoạn chat mới"
              title="Xóa đoạn chat và quay về màn chào"
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span>Đoạn chat mới</span>
            </button>
          )}
          <Link
            to="/docs"
            className="ca-topbar-btn"
            aria-label="Tài liệu cửa hàng"
            title="Xem tài liệu mà câu trả lời đã trích dẫn"
          >
            <BookOpen size={14} aria-hidden="true" />
            <span>Tài liệu</span>
          </Link>
        </div>
      </header>

      <div className="ca-scroll" ref={frameRef}>
        <div className="ca-scroll-inner">
          {!chatActive && (
            <>
              <section className="ca-hero">
                <div className="ca-hero-text">
                  <h2 className="ca-hero-title">
                    {greeting()}! 👋
                    <br />
                    Mình có thể giúp gì cho bạn?
                  </h2>
                  <p className="ca-hero-desc">
                    Chọn một chủ đề rồi bấm câu hỏi, hoặc gõ thẳng vào ô bên dưới.
                  </p>
                </div>
                <div className="ca-hero-art">
                  <p className="ca-hero-speech">Hỏi bất cứ điều gì về cửa hàng nhé!</p>
                  <img
                    src="/carem-assistant-robot.png"
                    alt="Trợ lý Cà Rem — robot thân thiện của cửa hàng"
                  />
                </div>
              </section>

              {/* Cấp 1 — sáu chủ đề. Bấm vào là đi sâu xuống cấp 2: chính tấm
                  thẻ được thay bằng câu hỏi của chủ đề đó, không trải thêm
                  hàng dài xuống vùng chat. Muốn đổi ý thì bấm quay lại. */}
              {openTopicData ? (
                <section
                  className="ca-topic-asks"
                  role="group"
                  aria-label={`Câu hỏi chủ đề ${openTopicData.title}`}
                >
                  <div className="ca-sec-head">
                    <button
                      type="button"
                      className="ca-sec-back"
                      autoFocus
                      onClick={() => setOpenTopic(null)}
                      aria-label="Quay lại sáu chủ đề"
                      title="Quay lại danh sách sáu chủ đề"
                    >
                      <ChevronLeft size={14} aria-hidden="true" />
                      <span>Sáu chủ đề</span>
                    </button>
                    <h2>
                      {OpenTopicIcon && <OpenTopicIcon size={15} aria-hidden="true" />}
                      {openTopicData.title}
                    </h2>
                  </div>
                  <div className="ca-ask-grid">
                    {openTopicData.questions.map((question) => (
                      <button
                        key={question}
                        type="button"
                        className="ca-ask"
                        onClick={() => askQuestion(question)}
                      >
                        <span>{question}</span>
                        <Send size={14} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </section>
              ) : (
                <section className="ca-cats" aria-label="Chủ đề tra cứu">
                  {topics.map(({ id, title, desc }) => {
                    const Icon = topicIcons[id];
                    return (
                      <button
                        key={id}
                        type="button"
                        className="ca-cat"
                        onClick={() => setOpenTopic(id)}
                      >
                        <span className="ca-cat-icon" aria-hidden="true">
                          <Icon size={19} strokeWidth={2.1} />
                        </span>
                        <span className="ca-cat-body">
                          <strong>{title}</strong>
                          <small>{desc}</small>
                        </span>
                        <ChevronRight
                          size={16}
                          className="ca-cat-caret"
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                </section>
              )}

              {!bannerHidden && (
                <aside className="ca-banner" role="note">
                  <span className="ca-banner-icon" aria-hidden="true">
                    <Sparkles size={18} />
                  </span>
                  <div>
                    <strong>Hỏi nhanh – Nhận số liệu thật</strong>
                    <p>
                      Mỗi câu trả lời kèm nguồn bấm được để kiểm chứng ngay.
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
            </>
          )}

          {turns.map((turn) => (
            <div className="ca-turn" key={turn.id}>
              <div className="ca-msg ca-msg-user">
                <p className="ca-bubble-user">
                  {turn.question}
                  <span className="ca-msg-time">{turn.timestamp}</span>
                </p>
              </div>

              {turn.answer && (
                <AnswerBubble
                  answer={turn.answer}
                  busy={busy}
                  onAsk={askQuestion}
                  followUps={
                    turn.id === turns.at(-1)?.id
                      ? nextQuestions(turn.question, turn.answer, askedQuestions)
                      : []
                  }
                />
              )}

              {turn.errorMessage && (
                <div className="ca-msg ca-msg-bot">
                  <span className="ca-avatar" aria-hidden="true">
                    <Bot size={18} />
                  </span>
                  <div className="ca-bubble">
                    <p className="ca-error" role="alert">
                      {turn.errorMessage}
                    </p>
                    <button
                      type="button"
                      className="ca-retry"
                      disabled={busy}
                      onClick={() => askQuestion(turn.question)}
                    >
                      Hỏi lại
                    </button>
                  </div>
                </div>
              )}

              {turn.draftAction && (
                <div className="ca-draft">
                  <DraftActionCard action={turn.draftAction} />
                </div>
              )}
            </div>
          ))}

          {busy && (
            <div className="ca-msg ca-msg-bot" aria-live="polite">
              <span className="ca-avatar" aria-hidden="true">
                <Bot size={18} />
              </span>
              <div className="ca-bubble ca-typing">
                <span />
                <span />
                <span />
                <em>Trợ lý Cà Rem đang tra cứu…</em>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="ca-dock">
        <div className="ca-quick" role="group" aria-label="Hỏi nhanh">
          {quickActions.map((action, index) => {
            const Icon = quickIcons[index] ?? Clock3;
            return (
              <button
                key={action.label}
                type="button"
                disabled={busy}
                onClick={() => askQuestion(action.question)}
              >
                <Icon size={14} aria-hidden="true" />
                {action.label}
              </button>
            );
          })}
        </div>

        <form
          className="ca-composer"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            askQuestion(input);
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
          <textarea
            ref={editorRef}
            className="ca-input"
            rows={1}
            disabled={busy}
            maxLength={2000}
            value={input}
            aria-label="Bạn muốn hỏi gì về cửa hàng?"
            placeholder="Nhập câu hỏi về cửa hàng…"
            title="Enter để gửi, Shift+Enter xuống dòng"
            onChange={(event) => {
              setInput(event.target.value);
              growEditor();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                askQuestion(input);
              }
            }}
          />
          <button
            type="submit"
            className="ca-send"
            disabled={busy || input.trim().length < 2}
            aria-label="Hỏi Cà Rem"
            title="Gửi câu hỏi (Enter)"
          >
            <Send size={17} />
          </button>
        </form>
      </div>
    </div>
  );
}
