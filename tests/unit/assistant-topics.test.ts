import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadThread,
  nextQuestions,
  saveThread,
  splitAnswer,
  topicFor,
  topics,
  quickActions,
} from "@/features/assistant/assistantTopics";
import type { CopilotAnswer } from "@/types";

const answer = (over: Partial<CopilotAnswer> = {}): CopilotAnswer => ({
  kind: "copilot",
  mode: "deterministic",
  available: true,
  coverage: "data",
  period: "Tháng 10/2026",
  facts: [],
  citations: [],
  doc_excerpts: [],
  answer_markdown: "Số liệu kỳ **Tháng 10/2026**:",
  suggestions: [],
  insufficient: false,
  warnings: [],
  ...over,
});

describe("assistant topics stay inside what the copilot can answer", () => {
  it("keeps six distinct topics, each with its own questions", () => {
    expect(topics).toHaveLength(6);
    expect(new Set(topics.map((topic) => topic.id)).size).toBe(6);
    for (const topic of topics) {
      expect(topic.questions.length).toBeGreaterThanOrEqual(3);
      expect(new Set(topic.questions).size).toBe(topic.questions.length);
    }
  });

  it("routes every quick pill to a question that resolves to a topic", () => {
    expect(quickActions).toHaveLength(4);
    for (const action of quickActions) {
      expect(action.question.trim().length).toBeGreaterThan(4);
      expect(topicFor(action.question)).not.toBeNull();
    }
  });

  it("folds accent-insensitive keywords to the right topic", () => {
    expect(topicFor("Còn bao nhiêu xe trong kho?")).toBe("inventory");
    expect(topicFor("cong no hom nay the nao")).toBe("debt");
    expect(topicFor("Doanh thu tháng này?")).toBe("sales");
    expect(topicFor("Chi phí sửa xe gần đây?")).toBe("costs");
    expect(topicFor("Khách hàng mua nhiều nhất?")).toBe("customers");
  });

  it("falls back to the evidence type when the wording is too thin", () => {
    const withDebt = answer({
      citations: [
        { id: "w1", type: "debt", label: "Tổng công nợ", detail: null, route: "/receivables" },
      ],
    });
    expect(topicFor("??? ", withDebt)).toBe("debt");
  });
});

describe("follow-up suggestions only offer questions worth asking", () => {
  it("stays inside the topic and never repeats the question just asked", () => {
    const suggestions = nextQuestions(
      "Còn bao nhiêu xe trong kho?",
      answer(),
      [],
    );
    expect(suggestions).toHaveLength(3);
    expect(suggestions).not.toContain("Còn bao nhiêu xe trong kho?");
    expect(suggestions.every((item) => topicFor(item) === "inventory")).toBe(true);
  });

  it("drops questions already present in the thread", () => {
    const suggestions = nextQuestions(
      "Còn bao nhiêu xe trong kho?",
      answer(),
      ["Xe nào tồn lâu nhất?", "Có bao nhiêu xe đang giữ chỗ?"],
    );
    expect(suggestions).not.toContain("Xe nào tồn lâu nhất?");
    expect(suggestions).not.toContain("Có bao nhiêu xe đang giữ chỗ?");
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("offers solid ground-up questions when the lookup found nothing", () => {
    const suggestions = nextQuestions(
      "abc xyz",
      answer({ insufficient: true, available: false, coverage: "none" }),
      [],
    );
    expect(suggestions).toContain("Tình hình cửa hàng hôm nay?");
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});

describe("answer compaction keeps the reply short without losing data", () => {
  const long = [
    "Số liệu kỳ **Tháng 10/2026**:",
    "- Xe đang tồn kho: **7 xe** [m2]",
    "- Xe bán trong kỳ: **3 xe** [m3]",
    "- Doanh thu hoàn tất: **120.000.000 ₫** [m4]",
    "- Tổng còn phải thu: **45.000.000 ₫** [m5]",
    "- Xe tồn trên 60 ngày: **2 xe** [m6]",
    "- Khách mua nhiều nhất: **4 lần** [m7]",
  ].join("\n");

  it("shows a readable head and folds the remaining lines", () => {
    const { head, rest } = splitAnswer(long);
    expect(head.split("\n")).toHaveLength(5);
    expect(rest.split("\n")).toHaveLength(2);
    expect(head).toContain("Xe đang tồn kho");
    expect(rest).toContain("Khách mua nhiều nhất");
  });

  it("leaves short answers untouched", () => {
    const short = answer();
    expect(splitAnswer(short.answer_markdown)).toEqual({
      head: short.answer_markdown,
      rest: "",
    });
  });
});

describe("conversation history survives navigation but never leaks across tabs", () => {
  // Vitest chạy trong node: giả lập window đúng như trình duyệt gọi module.
  const installWindow = () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
      },
    });
    return values;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips turns through session storage", () => {
    const values = installWindow();
    expect(loadThread()).toEqual([]);
    const turns = [
      {
        id: "t1",
        question: "Còn bao nhiêu xe trong kho?",
        timestamp: "09:00",
        answer: answer(),
      },
    ];
    saveThread(turns as never);
    expect(loadThread()).toHaveLength(1);
    expect(loadThread()[0].question).toBe("Còn bao nhiêu xe trong kho?");

    // "Đoạn chat mới" xóa sạch nên banner chào hiện lại.
    saveThread([]);
    expect(loadThread()).toEqual([]);
    expect(values.has("carem-assistant-thread-v1")).toBe(false);
  });

  it("ignores malformed or stale payloads instead of crashing the page", () => {
    const values = installWindow();
    values.set("carem-assistant-thread-v1", "{not json");
    expect(loadThread()).toEqual([]);
    values.set(
      "carem-assistant-thread-v1",
      JSON.stringify([{ id: "t1" }, null, 7, { id: "t2", question: "ok", answer: { kind: "other" } }]),
    );
    expect(loadThread()).toEqual([]);
  });

  it("degrades to no history when the browser blocks storage entirely", () => {
    vi.stubGlobal("window", {});
    expect(() => saveThread([] as never)).not.toThrow();
    expect(loadThread()).toEqual([]);
  });

  it("caps the stored thread so a long session cannot grow unbounded", () => {
    installWindow();
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `t${index}`,
      question: `câu ${index}`,
      timestamp: "09:00",
    }));
    saveThread(many as never);
    expect(loadThread()).toHaveLength(24);
    expect(loadThread().at(-1)?.question).toBe("câu 39");
  });
});
