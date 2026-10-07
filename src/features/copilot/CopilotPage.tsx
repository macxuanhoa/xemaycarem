import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Card, ErrorState, Field, PageHeader } from "@/components/ui";
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

export default function CopilotPage() {
  const { profile } = useAuth();
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<CopilotMode>(readStoredMode);
  const [history, setHistory] = useState<
    { question: string; answer: CopilotAnswer }[]
  >([]);
  const pendingRequest = useRef(false);
  const owner = isOwner(profile);
  const ask = useMutation({
    mutationFn: (asked: string) =>
      api.copilot(asked, owner ? mode : "deterministic"),
    onSuccess: (result, asked) => {
      setHistory((previous) =>
        [
          { question: asked, answer: result },
          ...previous.filter((item) => item.question !== asked),
        ].slice(0, 6),
      );
    },
    onSettled: () => {
      pendingRequest.current = false;
    },
  });
  const answer = ask.data;
  const chips = useMemo(() => citationNodes(answer?.citations ?? []), [answer]);
  // Commands typed into the question box become editable draft proposals for
  // the existing forms; questions never do (the detector rejects interrogations).
  const draftAction = useMemo(
    () => (answer ? detectDraftAction(String(ask.variables ?? "")) : null),
    [answer, ask.variables],
  );
  const suggested = QUESTIONS.filter((item) => owner || !item.ownerOnly);
  const hasCurrentStock = answer?.citations.some(isCurrentStockCitation);

  const selectQuestion = (next: string) => {
    if (pendingRequest.current) return;
    setQuestion(next);
    ask.reset();
  };
  const submitQuestion = (next: string) => {
    const asked = next.trim();
    if (pendingRequest.current || asked.length < 2) return;
    pendingRequest.current = true;
    ask.mutate(asked);
  };

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
    <div className="stack copilot-page">
      <PageHeader
        title="Trợ lý AI Cà Rem"
        description="Tra cứu kho, bán hàng và công nợ. Mở nguồn để kiểm tra từng kết quả."
      />

      <Card className="copilot-composer compact-card">
        <form
          className="stack"
          aria-busy={ask.isPending}
          onSubmit={(event) => {
            event.preventDefault();
            submitQuestion(question);
          }}
        >
          <Field label="Bạn muốn hỏi gì về cửa hàng?">
            <textarea
              id="copilot-question"
              className="copilot-input"
              rows={2}
              disabled={ask.isPending}
              maxLength={2000}
              placeholder="Ví dụ: Tháng 9 bán được bao nhiêu xe, còn nợ bao nhiêu?"
              value={question}
              onChange={(event) => selectQuestion(event.target.value)}
            />
          </Field>
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
          <div className="copilot-controls">
            {owner ? (
              <label className="row">
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
                      // Storage can be blocked in private mode; the choice just resets later.
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
              <p className="muted">
                Chỉ chủ cửa hàng bật được AI viết tóm tắt. Bạn đang tra cứu theo
                quyền của mình.
              </p>
            )}
            <Button
              type="submit"
              disabled={ask.isPending || question.trim().length < 2}
            >
              {ask.isPending ? "Đang tra cứu…" : "Hỏi Cà Rem"}
            </Button>
          </div>
          {ask.error != null && <ErrorState error={ask.error} />}
        </form>
      </Card>

      {answer && (
        <>
          <Card className="copilot-answer-card compact-card">
            <p className="copilot-answer-by" role="status">
              <span className="copilot-answer-avatar" aria-hidden="true">
                <Sparkles size={15} />
              </span>
              {answer.mode === "llm"
                ? "AI Cà Rem tóm tắt"
                : "Cà Rem tra cứu trực tiếp"}
              {answer.period ? ` · kỳ báo cáo ${answer.period}` : ""}
            </p>
            <p className="copilot-question-echo">
              Bạn hỏi: “{String(ask.variables ?? question)}”
            </p>
            {hasCurrentStock && answer.period && (
              <p className="copilot-stock-note">
                Tồn kho là số xe hiện tại. Kỳ {answer.period} áp dụng cho số
                liệu giao dịch, không phải tồn kho trong quá khứ.
              </p>
            )}
            <MarkdownLite
              text={answer.answer_markdown}
              citations={chips}
              className="copilot-answer"
            />
            {answer.warnings.length > 0 && (
              <div className="copilot-warnings">
                {answer.warnings.map((warning) => (
                  <p className="notice" key={warning}>
                    {warning}
                  </p>
                ))}
              </div>
            )}
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
                    Chưa có nguồn khớp. Thử thêm từ khóa hoặc biển số / số
                    khung.
                  </p>
                )}
                {answer.doc_excerpts.length > 0 && (
                  <div className="copilot-excerpts">
                    {answer.doc_excerpts.map((document) => (
                      <blockquote key={document.id} className="copilot-excerpt">
                        <MarkdownLite
                          text={document.excerpt}
                          citations={chips}
                        />
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
            {answer.suggestions.length > 0 && (
              <div className="copilot-chips">
                {answer.suggestions.map((suggestion) => (
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
          </Card>
        </>
      )}

      {draftAction && <DraftActionCard action={draftAction} />}

      {history.length > 0 && (
        <Card className="copilot-history-card compact-card">
          <details className="copilot-history-details">
            <summary>Câu hỏi gần đây ({history.length})</summary>
            <ul className="copilot-history">
              {history.map((item) => (
                <li key={item.question}>
                  <button
                    type="button"
                    className="copilot-history-link"
                    disabled={ask.isPending}
                    onClick={() => {
                      if (pendingRequest.current) return;
                      setQuestion(item.question);
                      submitQuestion(item.question);
                    }}
                  >
                    {item.question}
                  </button>
                  <small className="muted">
                    {item.answer.citations.length} bằng chứng
                    {item.answer.insufficient ? " · chưa đủ dữ liệu" : ""}
                  </small>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}
    </div>
  );
}
