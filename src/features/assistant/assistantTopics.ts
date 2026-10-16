/**
 * Trợ lý Cà Rem — nội dung và logic thuần của màn trò chuyện đã gộp
 * ("Trợ lý Cà Rem" + "Tra cứu AI Cà Rem" thành một mặt phẳng duy nhất).
 *
 * Tách khỏi component để câu hỏi gợi ý luôn khớp với intent tra cứu đã có
 * trong Edge Function `ai-assist` (không sinh ra câu hỏi mà hệ thống không
 * trả lời được) và để lịch sử hội thoại phục hồi được sau khi rời trang.
 */
import type { CopilotAnswer, CopilotMode } from "@/types";
import type { DraftAction } from "@/lib/shorthand/draftActions";

export type AssistantTopicId =
  | "inventory"
  | "sales"
  | "customers"
  | "costs"
  | "debt"
  | "insight";

export type AssistantTopic = {
  id: AssistantTopicId;
  title: string;
  desc: string;
  /** Câu hỏi trong chủ đề — bấm để hỏi ngay. */
  questions: string[];
  /** Bước tiếp theo hợp lý ở chủ đề khác, dùng cho gợi ý sau câu trả lời. */
  next: string[];
};

/**
 * Sáu chủ đề tra cứu. Mọi câu hỏi đều được kiểm chứng khớp với pattern intent
 * của copilot.ts (inventory / sales / revenue / profit / aging / receivables /
 * cash / customers / expenses / overview) nên không có câu hỏi "chết".
 */
export const topics: AssistantTopic[] = [
  {
    id: "inventory",
    title: "Kho & Tồn xe",
    desc: "Còn bao nhiêu xe, xe nào nằm lâu",
    questions: [
      "Còn bao nhiêu xe trong kho?",
      "Xe nào tồn lâu nhất?",
      "Có bao nhiêu xe đang giữ chỗ?",
      "Bao nhiêu xe chưa chốt giá mua?",
    ],
    next: ["Doanh thu tháng này?", "Xe nào tồn trên 60 ngày?"],
  },
  {
    id: "sales",
    title: "Doanh thu & Bán xe",
    desc: "Thu bao nhiêu, bán những đơn nào",
    questions: [
      "Doanh thu tháng này?",
      "Đơn bán gần đây?",
      "Lợi nhuận tháng này?",
      "Tháng trước bán được bao nhiêu xe?",
    ],
    next: ["Ai đang nợ nhiều nhất?", "Thu tiền hôm nay ra sao?"],
  },
  {
    id: "customers",
    title: "Khách hàng",
    desc: "Ai đã mua, ai mua nhiều nhất",
    questions: [
      "Có bao nhiêu khách đã mua?",
      "Khách hàng nào mua xe gần đây?",
      "Ai mua nhiều nhất?",
    ],
    next: ["Khách hàng nào đang nợ nhiều nhất?", "Đơn bán gần đây?"],
  },
  {
    id: "costs",
    title: "Bảo dưỡng & Chi phí",
    desc: "Sửa chữa, phụ tùng, giấy tờ",
    questions: [
      "Chi phí sửa xe gần đây?",
      "Chi phí trong ngày?",
      "Bao nhiêu chi phí tháng này?",
    ],
    next: ["Thu tiền hôm nay ra sao?", "Tình hình cửa hàng hôm nay?"],
  },
  {
    id: "debt",
    title: "Công nợ",
    desc: "Còn phải thu bao nhiêu, quá hạn chưa",
    questions: [
      "Ai đang nợ nhiều nhất?",
      "Tổng công nợ bao nhiêu?",
      "Thu tiền hôm nay ra sao?",
      "Khách nào chưa trả tiền?",
    ],
    next: ["Doanh thu tháng này?", "Tình hình cửa hàng hôm nay?"],
  },
  {
    id: "insight",
    title: "Tóm tắt & Phân tích",
    desc: "Bức tranh chung của cửa hàng",
    questions: [
      "Tình hình cửa hàng hôm nay?",
      "Tóm tắt kết quả kinh doanh tuần này?",
      "Doanh thu và công nợ hiện tại ra sao?",
    ],
    next: ["Xe nào tồn lâu nhất?", "Chi phí sửa xe gần đây?"],
  },
];

/** Hàng hỏi nhanh — luôn nằm NGAY TRÊN ô nhập, giữ nguyên khi đang trò chuyện. */
export const quickActions: { label: string; question: string }[] = [
  { label: "Tóm tắt hôm nay", question: "Tình hình cửa hàng hôm nay?" },
  { label: "Báo cáo tuần", question: "Tóm tắt kết quả kinh doanh tuần này?" },
  { label: "Xe tồn lâu", question: "Những xe nào tồn kho lâu nhất?" },
  { label: "Khách còn nợ", question: "Khách hàng nào đang nợ nhiều nhất?" },
];

/** Chủ đề suy ra từ loại bằng chứng khi câu hỏi quá ngắn hoặc không rõ. */
const citationTopic: Record<string, AssistantTopicId> = {
  debt: "debt",
  expense: "costs",
  customer: "customers",
  sale: "sales",
  audit: "insight",
  document: "insight",
};

const signals: [AssistantTopicId, RegExp][] = [
  ["debt", /(cong no|no lai|chua thu|phai thu|no qua han|con no|no dung|chua tra|debt|receivable)/],
  ["costs", /(chi phi|sua xe|tien sua|bao duong|phu tung|rang buoc| sua chua)/],
  ["customers", /(khach hang|khach tiem nang|bao nhieu khach|mua nhieu|da mua)/],
  ["sales", /(doanh thu|loi nhuan|don ban|ban duoc|ban bao nhieu|so xe ban|doanh so|revenue|profit)/],
  ["inventory", /(ton kho|bao nhieu xe|xe trong kho|con lai|giu cho|ton lau|lau nhat|nhu yen|tren 60 ngay)/],
  ["insight", /(tinh hinh|tom luoc|tong quan|dang the nao|ra sao|de xuat|nhan xet| overview)/],
];

const stripDiacritics = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase();

/** Suy ra chủ đề của một lượt hỏi để chọn câu gợi ý bước tiếp theo. */
export function topicFor(
  question: string,
  answer?: Pick<CopilotAnswer, "citations">,
): AssistantTopicId | null {
  const text = ` ${stripDiacritics(question)} `;
  for (const [id, pattern] of signals) if (pattern.test(text)) return id;
  for (const citation of answer?.citations ?? []) {
    const mapped = citationTopic[citation.type];
    if (mapped) return mapped;
  }
  return null;
}

/** Khi câu trả lời không đủ dữ liệu, mời người dùng hỏi lại thứ chắc chắn có. */
const CLARIFY_QUESTIONS = [
  "Tình hình cửa hàng hôm nay?",
  "Còn bao nhiêu xe trong kho?",
  "Ai đang nợ nhiều nhất?",
];

/**
 * Gợi ý câu hỏi tiếp theo sau một câu trả lời: ưu tiên câu còn lại trong đúng
 * chủ đề vừa hỏi, rồi tới bước tiếp theo của chủ đề đó. Loại những câu đã hỏi
 * trong đoạn chat nên chip không bao giờ trùng lặp.
 */
export function nextQuestions(
  question: string,
  answer: CopilotAnswer,
  alreadyAsked: Iterable<string>,
  limit = 3,
): string[] {
  const asked = new Set(alreadyAsked);
  const topic = topics.find((item) => item.id === topicFor(question, answer));
  const pool = answer.insufficient
    ? [...CLARIFY_QUESTIONS, ...(topic?.questions ?? [])]
    : [...(topic?.questions ?? []), ...(topic?.next ?? []), ...(topic ? [] : CLARIFY_QUESTIONS)];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of pool) {
    if (candidate === question || asked.has(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Câu trả lời tra cứu trực tiếp liệt kê mọi số liệu, dễ thành dàn ngang dài.
 * Bản gọn giữ vài dòng đầu; phần còn lại nằm trong nút "Xem đầy đủ" để người
 * đọc không phải cuộn, nhưng không mất dữ liệu.
 */
export const ANSWER_VISIBLE_LINES = 5;

export function splitAnswer(
  markdown: string,
  limit = ANSWER_VISIBLE_LINES,
): { head: string; rest: string } {
  const lines = markdown.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= limit) return { head: lines.join("\n"), rest: "" };
  return {
    head: lines.slice(0, limit).join("\n"),
    rest: lines.slice(limit).join("\n"),
  };
}

/** Số con số nổi bật hiển thị ngay đầu câu trả lời. */
export const FACT_CHIPS = 3;

// --- Lịch sử hội thoại: giữ trong phiên, mất khi đóng tab, xóa bằng nút mới. ---

export type ThreadTurn = {
  id: string;
  question: string;
  answer?: CopilotAnswer;
  errorMessage?: string;
  draftAction?: DraftAction | null;
  timestamp: string;
};

const THREAD_KEY = "carem-assistant-thread-v1";
const MAX_TURNS = 24;

const isTurn = (value: unknown): value is ThreadTurn => {
  if (!value || typeof value !== "object") return false;
  const turn = value as Record<string, unknown>;
  if (typeof turn.id !== "string" || typeof turn.question !== "string") return false;
  if (turn.answer !== undefined) {
    const answer = turn.answer as Record<string, unknown>;
    if (answer.kind !== "copilot" || typeof answer.answer_markdown !== "string") return false;
    if (!Array.isArray(answer.facts) || !Array.isArray(answer.citations)) return false;
  }
  return true;
};

export function loadThread(): ThreadTurn[] {
  try {
    const stored = window.sessionStorage.getItem(THREAD_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTurn);
  } catch {
    // Storage có thể bị chặn (chế độ ẩn danh) — trang vẫn chạy, chỉ mất lịch sử.
    return [];
  }
}

export function saveThread(turns: ThreadTurn[]): void {
  try {
    const trimmed = turns.slice(-MAX_TURNS);
    if (!trimmed.length) window.sessionStorage.removeItem(THREAD_KEY);
    else window.sessionStorage.setItem(THREAD_KEY, JSON.stringify(trimmed));
  } catch {
    // Bỏ qua: lịch sử chỉ là tiện ích, không được chặn luồng hỏi đáp.
  }
}

/** Chế độ tóm tắt bằng AI là ưu tiên của chủ cửa hàng, dùng lại khóa cũ. */
export const MODE_KEY = "carem-copilot-mode";

export function readStoredMode(): CopilotMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "llm" ? "llm" : "deterministic";
  } catch {
    return "deterministic";
  }
}

export function writeStoredMode(mode: CopilotMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage có thể bị chặn; chế độ chỉ áp dụng cho phiên hiện tại.
  }
}

const BANNER_KEY = "carem-assistant-banner-hidden";

export function readBannerHidden(): boolean {
  try {
    return window.localStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeBannerHidden(): void {
  try {
    window.localStorage.setItem(BANNER_KEY, "1");
  } catch {
    // Không lưu được thì banner sẽ hiện lại ở lần truy cập sau.
  }
}
