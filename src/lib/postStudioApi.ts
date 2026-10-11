// Client cho Cà Rem AI Sales Assistant (Edge Function `post-ai` + các RPC
// 20261010000600). Tách riêng khỏi api.ts để không giẫm vùng WIP của agent
// khác — chỉ tái sử dụng đúng những gì api đãexport (call, imageUrl).
import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";
import { api } from "./api";
import { supabase } from "./supabase";
import { AppError } from "./errors";

export type PostKind = "NEW_STOCK" | "PROMO" | "SOLD" | "MULTI" | "BUYBACK";
export type PostChannel = "FACEBOOK" | "FB_GROUP" | "ZALO";
export type Tone = "THAN_THIEN" | "NGAN_GON" | "CHUYEN_NGHIA" | "VUI_VANG";

export type StudioImage = {
  id: string;
  storage_path: string;
  display_order?: number;
};

/** Bản chiếu Tier-A đúng như get_post_studio_context trả — không giá, không PII. */
export type StudioContext = {
  id: string;
  internal_code: string | null;
  license_plate: string | null;
  frame_number: string | null;
  vehicle_type: string;
  year: number | null;
  color: string | null;
  status: "IN_STOCK" | "SOLD";
  vehicle_title: string;
  vehicle_subtitle: string | null;
  listed_at?: string;
  images: StudioImage[];
  store: { store_name?: string; phone?: string; address?: string };
};

export type PostDraft = {
  id: string;
  vehicle_id: string | null;
  post_kind: PostKind;
  channel: PostChannel;
  tone: string | null;
  caption: string;
  status: "DRAFT" | "APPROVED" | "ARCHIVED";
  ai_generated: boolean;
  creator_name?: string | null;
  approved_at?: string | null;
  created_at: string;
  updated_at?: string;
  vehicle_title?: string | null;
};

export type DraftVersion = {
  id: string;
  caption: string;
  source: "AI" | "HUMAN";
  creator_name?: string | null;
  created_at: string;
};

export type BrandEntry = {
  id: string;
  entry_type: "EXAMPLE" | "RULE";
  channel: PostChannel | "MESSENGER" | "ANY";
  post_kind: PostKind | null;
  content: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  source: "MANUAL" | "AI" | "EDITED";
  creator_name?: string | null;
  approved_at?: string | null;
  created_at: string;
};

export type MatchedVehicle = {
  id: string;
  internal_code?: string | null;
  license_plate?: string | null;
  vehicle_type?: string;
  year?: number | null;
  color?: string | null;
  status: string;
  vehicle_title: string;
  vehicle_subtitle?: string | null;
  images?: StudioImage[];
};

export type AssistCaptionReply = {
  task: "captions";
  model: string;
  captions: string[];
  vehicle: StudioContext | null;
  requires_human_review: boolean;
};
export type AssistRefineReply = {
  task: "refine";
  model: string;
  caption: string;
  requires_human_review: boolean;
};
export type AssistReply =
  | AssistCaptionReply
  | AssistRefineReply;

export type UsageDigest = {
  days: number;
  requests: number;
  ok: number;
  quota: number;
  /** gộp cả outcome ERROR lẫn BLOCKED theo get_post_ai_usage. */
  errors: number;
  input_tokens: number;
  output_tokens: number;
  daily?: { day: string; requests: number; ok: number; quota: number; errors: number; tokens: number }[];
};

const friendlyAssistMessage = (data: Record<string, unknown>) => {
  const code = String(data.error ?? "POST_AI_UNAVAILABLE");
  if (code === "GEMINI_QUOTA" || code === "POST_AI_RATE_LIMITED")
    return "Trợ lý AI tạm hết hạn mức hôm nay. Bạn vẫn dùng được mẫu caption có sẵn.";
  if (code.startsWith("AI_OUTPUT_UNSAFE")) {
    const base = "AI viết ra câu chứa thông tin không được phép đăng công khai (giá/số điện thoại/liên kết). Đã chặn — hãy thử lại hoặc sửa tay.";
    // Máy chủ nói rõ nguyên nhân nằm ở MÔ TẢ tự do (nếu có) → ghép vào để người
    // bán biết sửa chỗ nào, thay vì đoán mò.
    const server = typeof data.message === "string" ? data.message : "";
    const briefHint = server.match(/Mô tả của bạn[^.]*\./)?.[0];
    return briefHint ? `${base} ${briefHint}` : base;
  }
  if (code === "VEHICLE_UNAVAILABLE")
    return "Chiếc xe này không còn trong trạng thái phù hợp để đăng bài. Chọn xe khác hoặc tải lại danh sách.";
  if (code === "AI_NOT_CONFIGURED")
    return "Trợ lý AI chưa được bật trên máy chủ. Mẫu caption vẫn dùng bình thường.";
  return typeof data.message === "string" && data.message
    ? data.message
    : "Chưa thể tạo nội dung bằng AI lúc này. Hãy thử lại hoặc dùng mẫu có sẵn.";
};

async function ensureOnline() {
  if (!navigator.onLine)
    throw new AppError("Đang mất kết nối. Hãy bật mạng để nhờ trợ lý AI viết bài.");
}

/** Gọi Edge Function post-ai — cùng kỷ luật xử lý lỗi với api.assist. */
async function assist<T extends AssistReply>(input: Record<string, unknown>): Promise<T> {
  await ensureOnline();
  if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
  const { data, error } = await supabase.functions.invoke("post-ai", { body: input });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      let body: Record<string, unknown> | null = null;
      try {
        body = (await error.context.clone().json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      throw new AppError(body ? friendlyAssistMessage(body) : "Trợ lý AI không phản hồi. Thử lại sau nhé.");
    }
    if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError)
      throw new AppError("Không kết nối được trợ lý AI (mạng/CORS). Hãy thử lại.");
    throw new AppError(error.message);
  }
  if (data?.error) throw new AppError(friendlyAssistMessage(data as Record<string, unknown>));
  return data as T;
}

const postStudioCall = async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  if (!navigator.onLine)
    throw new AppError("Đang mất kết nối — dữ liệu chưa được tải về. Hãy bật mạng để tiếp tục.");
  return api.call<T>(name, args);
};

export const postStudio = {
  assist,
  context: (vehicleId: string) =>
    postStudioCall<StudioContext>("get_post_studio_context", { p_vehicle_id: vehicleId }),
  matching: (query: string) =>
    postStudioCall<{ items: MatchedVehicle[]; total: number }>("find_matching_vehicles", {
      p_query: query,
    }),
  saveDraft: (data: {
    id?: string;
    vehicle_id?: string | null;
    post_kind: PostKind;
    channel: PostChannel;
    tone?: string | null;
    caption: string;
    ai_generated: boolean;
  }) => postStudioCall<string>("save_post_draft", { p_data: data }),
  listDrafts: (filters: Record<string, unknown> = {}) =>
    postStudioCall<{ items: PostDraft[]; total: number }>("list_post_drafts", { p_filters: filters }),
  draftVersions: (draftId: string) =>
    postStudioCall<{ items: DraftVersion[]; current_caption: string; status: string }>(
      "list_post_draft_versions",
      { p_draft_id: draftId },
    ),
  setDraftStatus: (id: string, status: "APPROVED" | "ARCHIVED", addToLibrary = false) =>
    postStudioCall<void>("set_post_draft_status", {
      p_id: id,
      p_status: status,
      p_add_to_library: addToLibrary,
    }),
  listBrandMemory: (filters: Record<string, unknown> = {}) =>
    postStudioCall<{ items: BrandEntry[]; total: number }>("list_brand_memory", { p_filters: filters }),
  saveBrandMemory: (data: {
    id?: string;
    entry_type: "EXAMPLE" | "RULE";
    channel?: string;
    post_kind?: string | null;
    content: string;
  }) => postStudioCall<string>("save_brand_memory", { p_data: data }),
  approveBrandMemory: (id: string, approve: boolean) =>
    postStudioCall<BrandEntry>("approve_brand_memory", { p_id: id, p_approve: approve }),
  usage: (days = 7) => postStudioCall<UsageDigest>("get_post_ai_usage", { p_days: days }),
  /** ký URL ảnh tư nhân ngắn hạn qua cổng dùng chung của CRM. */
  imageUrl: (path: string) => api.imageUrl(path),
};
