import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Card, ErrorState, Field, PageHeader } from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { isOwner } from "@/lib/permissions";
import { MarkdownLite } from "@/lib/markdownLite";
import { citationNodes, CitationList } from "./CitationLinks";
import type { CopilotAnswer, CopilotMode } from "@/types";

const MODE_KEY = "carem-copilot-mode";

const readStoredMode = (): CopilotMode => {
  try {
    return window.localStorage.getItem(MODE_KEY) === "llm" ? "llm" : "deterministic";
  } catch {
    return "deterministic";
  }
};

const QUESTIONS: { text: string; ownerOnly?: boolean }[] = [
  { text: "Còn bao nhiêu xe trong kho?" },
  { text: "Doanh thu tháng này?" },
  { text: "Xe nào tồn lâu nhất?" },
  { text: "Ai đang nợ nhiều nhất?" },
  { text: "Chi phí sửa xe gần đây?" },
  { text: "Lịch sử thao tác hôm nay?", ownerOnly: true },
];

export default function CopilotPage() {
  const { profile } = useAuth();
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<CopilotMode>(readStoredMode);
  const [history, setHistory] = useState<{ question: string; answer: CopilotAnswer }[]>([]);
  const owner = isOwner(profile);
  const ask = useMutation({
    mutationFn: (asked: string) => api.copilot(asked, mode),
    onSuccess: (result, asked) => {
      setHistory((previous) => [{ question: asked, answer: result }, ...previous.filter((item) => item.question !== asked)].slice(0, 6));
    },
  });
  const answer = ask.data;
  const chips = useMemo(() => citationNodes(answer?.citations ?? []), [answer]);
  const suggested = QUESTIONS.filter((item) => owner || !item.ownerOnly);

  return (
    <div className="stack">
      <PageHeader
        title="Trợ lý AI Cà Rem"
        description="Hỏi về kho, doanh thu, công nợ, chi phí hay tài liệu vận hành. Mỗi kết quả đều kèm nút mở đúng trang chứa bằng chứng."
      />

      <Card>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim().length >= 2) ask.mutate(question.trim());
          }}
        >
          <Field label="Bạn muốn hỏi gì về cửa hàng?">
            <textarea
              id="copilot-question"
              className="copilot-input"
              rows={3}
              maxLength={2000}
              placeholder="Ví dụ: Tháng 9 bán được bao nhiêu xe, còn nợ bao nhiêu?"
              value={question}
              onChange={(event) => {
                setQuestion(event.target.value);
                ask.reset();
              }}
            />
          </Field>
          <div className="copilot-chips" role="group" aria-label="Câu hỏi gợi ý">
            {suggested.map((item) => (
              <button
                type="button"
                key={item.text}
                className="copilot-chip"
                onClick={() => {
                  setQuestion(item.text);
                  ask.reset();
                }}
              >
                {item.text}
              </button>
            ))}
          </div>
          <div className="copilot-controls">
            {owner ? (
              <label className="row">
                <input
                  type="checkbox"
                  checked={mode === "llm"}
                  disabled={ask.isPending}
                  onChange={(event) => {
                    const next: CopilotMode = event.target.checked ? "llm" : "deterministic";
                    setMode(next);
                    try {
                      window.localStorage.setItem(MODE_KEY, next);
                    } catch {
                      // Storage can be blocked in private mode; the choice just resets later.
                    }
                    ask.reset();
                  }}
                />
                <span>
                  <Sparkles size={14} aria-hidden="true" /> Bật AI viết câu tóm tắt
                  <small className="muted">
                    {" "}· vẫn chỉ dùng dữ liệu và tài liệu đã tra, mỗi nhận định có nút bằng chứng
                  </small>
                </span>
              </label>
            ) : (
              <p className="muted">
                Chế độ AI viết tóm tắt chỉ chủ cửa hàng bật được. Câu trả lời hiện tra
                cứu trực tiếp từ dữ liệu và tài liệu theo quyền của bạn.
              </p>
            )}
            <Button type="submit" disabled={ask.isPending || question.trim().length < 2}>
              {ask.isPending ? "Đang tra cứu…" : "Hỏi Cà Rem"}
            </Button>
          </div>
          {ask.error != null && <ErrorState error={ask.error} />}
        </form>
      </Card>

      {answer && (
        <>
          <Card className="copilot-answer-card">
            <p className="copilot-answer-by">
              <span className="copilot-answer-avatar" aria-hidden="true">
                <Sparkles size={15} />
              </span>
              {answer.mode === "llm" ? "AI Cà Rem tóm tắt — mỗi nhận định có bằng chứng" : "Cà Rem tra cứu trực tiếp"}
              {answer.period ? ` · kỳ ${answer.period}` : ""}
            </p>
            <p className="copilot-question-echo">
              Bạn hỏi: “{String(ask.variables ?? question)}”
            </p>
            <MarkdownLite text={answer.answer_markdown} citations={chips} className="copilot-answer" />
            {answer.facts.length > 0 && (
              <ul className="copilot-facts">
                {answer.facts.map((fact) => {
                  const citation = answer.citations.find((item) => item.id === fact.citation);
                  return (
                    <li key={`${fact.label}-${fact.citation}`}>
                      <span>{fact.label}</span>
                      <strong>{fact.display}</strong>
                      {citation ? (
                        <Link className="citation-open" to={citation.route}>
                          Mở bằng chứng {citation.id}
                        </Link>
                      ) : (
                        <span className="muted">không có liên kết</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {answer.warnings.length > 0 && (
              <div className="copilot-warnings">
                {answer.warnings.map((warning) => (
                  <p className="notice" key={warning}>
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <h2 className="section-title">Bằng chứng cho câu trả lời</h2>
            {answer.citations.length ? (
              <CitationList citations={answer.citations} />
            ) : (
              <p className="muted">
                Chưa có bằng chứng nào khớp với câu hỏi. Hãy thêm từ khóa như "tồn
                kho", "doanh thu", "công nợ", "chi phí" hoặc mô tả biển số / số khung.
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
            {answer.suggestions.length > 0 && (
              <div className="copilot-chips">
                {answer.suggestions.map((suggestion) => (
                  <Link key={suggestion.route} className="copilot-chip" to={suggestion.route}>
                    {suggestion.label}
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {history.length > 0 && (
        <Card>
          <h2 className="section-title">Câu hỏi gần đây</h2>
          <ul className="copilot-history">
            {history.map((item) => (
              <li key={item.question}>
                <button
                  type="button"
                  className="copilot-history-link"
                  onClick={() => {
                    setQuestion(item.question);
                    ask.mutate(item.question);
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
        </Card>
      )}
    </div>
  );
}
