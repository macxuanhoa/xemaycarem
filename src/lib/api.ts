import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { AppError } from "./errors";
import {
  IDENTITY_DOCUMENT_BUCKET,
  IDENTITY_DOCUMENT_URL_TTL_SECONDS,
  VEHICLE_IMAGE_BUCKET,
  VEHICLE_IMAGE_URL_TTL_SECONDS,
  signedImageUrl,
  uploadImage,
} from "./storageGateway";

async function handleEdgeFunctionError(
  functionName: string,
  error: unknown,
): Promise<never> {
  if (error instanceof FunctionsHttpError) {
    let safeBody: Record<string, unknown> | null = null;
    let status: number | undefined;
    try {
      if (error.context instanceof Response) {
        status = error.context.status;
        const rawJson: unknown = await error.context
          .clone()
          .json()
          .catch(() => null);
        if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)) {
          // Never log passwords, tokens, or sensitive keys
          const copy = { ...(rawJson as Record<string, unknown>) };
          delete copy.password;
          delete copy.token;
          delete copy.access_token;
          delete copy.service_role_key;
          safeBody = copy;
        }
      }
    } catch {
      // response body could not be parsed
    }

    if (import.meta.env.DEV) {
      console.error(`[EdgeFunction:${functionName}] FunctionsHttpError`, {
        errorClass: "FunctionsHttpError",
        status,
        body: safeBody,
        functionName,
      });
    }

    if (safeBody && typeof safeBody.message === "string" && safeBody.message) {
      throw new AppError(safeBody.message);
    }
    if (status === 401) {
      throw new AppError(
        "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.",
      );
    }
    if (status === 403) {
      throw new AppError(
        "Bạn không có quyền thực hiện thao tác này (yêu cầu quyền OWNER).",
      );
    }
    if (status === 404) {
      throw new AppError(
        `Không tìm thấy Edge Function "${functionName}". Vui lòng kiểm tra triển khai.`,
      );
    }
    throw new AppError(
      status
        ? `Lỗi máy chủ (${status}). Vui lòng thử lại.`
        : "Lỗi phản hồi từ máy chủ.",
    );
  }

  if (error instanceof FunctionsRelayError) {
    if (import.meta.env.DEV) {
      console.error(`[EdgeFunction:${functionName}] FunctionsRelayError`, {
        errorClass: "FunctionsRelayError",
        message: error.message,
        functionName,
      });
    }
    throw new AppError(
      "Không thể chuyển tiếp yêu cầu đến Edge Function (Relay). Vui lòng thử lại sau.",
    );
  }

  if (error instanceof FunctionsFetchError) {
    if (import.meta.env.DEV) {
      console.error(`[EdgeFunction:${functionName}] FunctionsFetchError`, {
        errorClass: "FunctionsFetchError",
        message: error.message,
        functionName,
      });
    }
    throw new AppError(
      "Không thể kết nối đến Edge Function (lỗi mạng hoặc cấu hình CORS). Vui lòng kiểm tra kết nối mạng.",
    );
  }

  if (import.meta.env.DEV) {
    console.error(`[EdgeFunction:${functionName}] UnknownError`, {
      errorClass:
        error instanceof Error ? error.constructor.name : typeof error,
      functionName,
    });
  }
  if (error instanceof AppError) throw error;
  if (error instanceof Error) throw new AppError(error.message);
  throw new AppError("Đã xảy ra lỗi không xác định khi kết nối dịch vụ.");
}

const ensureOnline = () => {
  if (!navigator.onLine)
    throw new AppError(
      "Đang mất kết nối. Giao dịch chưa được gửi. Hãy kết nối mạng để tiếp tục.",
    );
};
async function call<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  ensureOnline();
  if (!supabase)
    throw new AppError(
      "Ứng dụng chưa được kết nối với cơ sở dữ liệu của cửa hàng.",
    );
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    console.error("RPC failed", name, error);
    throw error;
  }
  return data as T;
}
/**
 * Fetches every row of a paged list RPC by looping through server pages.
 * Database list functions cap `limit` at 100, so "show all" is assembled
 * client-side. Results are hard-stopped at 5.000 rows to protect the browser.
 */
const ALL_PAGE_STEP = 100;
const ALL_ROW_CAP = 5000;
async function callAll<T>(
  name: string,
  filters: Record<string, unknown> = {},
  extraArgs: Record<string, unknown> = {},
): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let total = 0;
  let offset = 0;
  let envelope: Record<string, unknown> = {};
  for (;;) {
    const page = await call<Record<string, unknown>>(name, {
      ...extraArgs,
      p_filters: { ...filters, offset, limit: ALL_PAGE_STEP },
    });
    total = Number(page?.total ?? items.length);
    const batch = (page?.items as T[] | undefined) ?? [];
    items.push(...batch);
    envelope = page ?? {};
    offset += batch.length;
    if (!batch.length || offset >= total || offset >= ALL_ROW_CAP) break;
  }
  return { ...envelope, items, total };
}
// Ảnh đi qua cổng lưu trữ tập trung (storageGateway) — mọi knowledge về bucket,
// đường dẫn và signed URL nằm ở đó, tại đây chỉ còn bước đăng ký nghiệp vụ.
async function uploadVehicleImage(vehicleId: string, file: File) {
  ensureOnline();
  const path = await uploadImage(VEHICLE_IMAGE_BUCKET, vehicleId, file);
  await call("register_vehicle_image", {
    p_vehicle_id: vehicleId,
    p_storage_path: path,
  });
}
async function imageUrl(path: string) {
  return signedImageUrl(
    VEHICLE_IMAGE_BUCKET,
    path,
    VEHICLE_IMAGE_URL_TTL_SECONDS,
  );
}
// CCCD card photos live in a private bucket. The document row must exist first
// (created by `save_identity_document`); viewing uses a short 120-second signed
// URL from the gateway, never a public link.
async function uploadIdentityDocumentImage(
  subjectType: "acquisition" | "sale",
  subjectId: string,
  side: "front" | "back",
  file: File,
) {
  ensureOnline();
  const path = await uploadImage(IDENTITY_DOCUMENT_BUCKET, subjectId, file);
  await call("register_identity_document_image", {
    p_subject_type: subjectType,
    p_subject_id: subjectId,
    p_side: side,
    p_storage_path: path,
  });
}
async function identityImageUrl(path: string) {
  return signedImageUrl(
    IDENTITY_DOCUMENT_BUCKET,
    path,
    IDENTITY_DOCUMENT_URL_TTL_SECONDS,
  );
}
async function createUser(input: {
  username: string;
  password: string;
  full_name: string;
  role: string;
  can_view_financials: boolean;
  allowed_from?: string;
  allowed_until?: string;
  working_days?: number[];
}) {
  ensureOnline();
  if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
  const { data, error } = await supabase.functions.invoke("manage-users", {
    body: { ...input, action: "create" },
  });
  if (error) {
    await handleEdgeFunctionError("manage-users", error);
  }
  if (data?.error) {
    throw new AppError(
      data.message ||
        "Không thể tạo tài khoản. Kiểm tra tên đăng nhập và quyền của bạn.",
    );
  }
  return data;
}
async function manageUser(input: {
  action:
    | "reset_password"
    | "disable"
    | "restore"
    | "delete"
    | "hard_delete"
    | "change_role"
    | "promote_to_owner"
    | "enable_user";
  user_id: string;
  password?: string;
  disabled_until?: string | null;
  disable_reason?: string | null;
  role?: string;
}) {
  ensureOnline();
  if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
  const { data, error } = await supabase.functions.invoke("manage-users", {
    body: input,
  });
  if (error) {
    await handleEdgeFunctionError("manage-users", error);
  }
  if (data?.error) {
    throw new AppError(
      data.message || "Không thể thực hiện thao tác. Kiểm tra quyền của bạn.",
    );
  }
  return data;
}
export const api = {
  call,
  callAll,
  listKnowledge: async () =>
    call<{ items: import("@/types").KnowledgeIndexItem[]; total: number }>(
      "list_knowledge",
    ),
  getKnowledgeArticle: async (slug: string) =>
    call<import("@/types").KnowledgeArticle>("get_knowledge_article", {
      p_slug: slug,
    }),
  searchKnowledge: async (query: string, limit = 8) =>
    call<import("@/types").KnowledgeSearchHit[]>("search_knowledge", {
      p_query: query,
      p_limit: limit,
    }),
  /** OWNER-only digest of copilot questions that had no evidence (documentation gaps). */
  listCopilotGaps: async (days = 30) =>
    call<import("@/types").CopilotGapDigest>("list_copilot_gaps", { p_days: days }),
  listActiveAnnouncements: async () =>
    call<
      import("@/types").Announcement[]
    >("list_active_announcements"),
  listAnnouncements: async () =>
    call<{ items: import("@/types").Announcement[] }>("list_announcements"),
  saveAnnouncement: async (
    data: Partial<import("@/types").Announcement> & { message: string },
  ) =>
    call<import("@/types").Announcement>("save_announcement", {
      p_data: data,
    }),
  setAnnouncementActive: async (id: string, active: boolean) =>
    call<import("@/types").Announcement>("set_announcement_active", {
      p_id: id,
      p_active: active,
    }),
  deleteAnnouncement: async (id: string) =>
    call<void>("delete_announcement", { p_id: id }),
  /** Business bell: only the caller's own rows; server caps page size at 100. */
  listNotifications: async (filters: Record<string, unknown> = {}) =>
    call<import("@/types").NotificationList>("list_notifications", {
      p_filters: filters,
    }),
  markNotificationsRead: async (ids: string[]) =>
    call<number>("mark_notifications_read", { p_ids: ids }),
  markAllNotificationsRead: async () =>
    call<number>("mark_all_notifications_read"),
  /** Xóa cứng xe kho (OWNER/MANAGER). Bị chặn nếu xe từng có giao dịch bán. */
  deleteVehicle: async (id: string, reason: string) =>
    call<void>("delete_vehicle", { p_id: id, p_reason: reason }),
  /** Xóa cứng phiếu thu kèm xe đã thu (OWNER/MANAGER). */
  deleteAcquisition: async (id: string, reason: string) =>
    call<void>("delete_acquisition", { p_id: id, p_reason: reason }),
  processMessage: async (messageId: string): Promise<void> => {
    if (!supabase) return;
    const { error } = await supabase.functions.invoke("process-message", { body: { message_id: messageId } });
    if (error) await handleEdgeFunctionError("process-message", error);
  },
  uploadVehicleImage,
  imageUrl,
  uploadIdentityDocumentImage,
  identityImageUrl,
  createUser,
  manageUser,
  assist: async <T>(input: Record<string, unknown>): Promise<T> => {
    ensureOnline();
    if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
    const { data, error } = await supabase.functions.invoke("ai-assist", {
      body: input,
    });
    if (error) await handleEdgeFunctionError("ai-assist", error);
    if (data?.error) {
      throw new AppError(
        typeof data.message === "string" && data.message
          ? data.message
          : "Trợ lý AI chưa trả lời được. Hãy thử lại hoặc nhập thủ công.",
      );
    }
    return data as T;
  },
  /**
   * Ask the copilot. The answer is always retrieved under this user's session,
   * so a question can never reveal data the user cannot already open.
   */
  copilot: async (
    question: string,
    mode: import("@/types").CopilotMode = "deterministic",
  ) => {
    const text = question.trim().slice(0, 2000);
    if (text.length < 2) throw new AppError("Hãy nhập câu hỏi rõ hơn nhé.");
    return api.assist<import("@/types").CopilotAnswer>({
      task: "copilot",
      consent: true,
      text,
      mode,
    });
  },
};
