import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { AppError } from "./errors";
import { reportRuntimeIssue } from "./runtimeMonitoring";
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

    if (status && status >= 500)
      reportRuntimeIssue("edge", "EDGE_SERVER_ERROR", functionName);

    if (import.meta.env.DEV) {
      console.error(`[EdgeFunction:${functionName}] FunctionsHttpError`, {
        errorClass: "FunctionsHttpError",
        status,
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
    reportRuntimeIssue("edge", "EDGE_RELAY_ERROR", functionName);
    if (import.meta.env.DEV) {
      console.error(`[EdgeFunction:${functionName}] FunctionsRelayError`, {
        errorClass: "FunctionsRelayError",
        functionName,
      });
    }
    throw new AppError(
      "Không thể chuyển tiếp yêu cầu đến Edge Function (Relay). Vui lòng thử lại sau.",
    );
  }

  if (error instanceof FunctionsFetchError) {
    reportRuntimeIssue("edge", "NETWORK_ERROR", functionName);
    if (import.meta.env.DEV) {
      console.error(`[EdgeFunction:${functionName}] FunctionsFetchError`, {
        errorClass: "FunctionsFetchError",
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
  reportRuntimeIssue("edge", "EDGE_SERVER_ERROR", functionName);
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
  let result;
  try {
    result = await supabase.rpc(name, args);
  } catch (error) {
    if (name !== "report_client_issue" && name !== "list_client_issues") {
      reportRuntimeIssue(
        "rpc",
        error instanceof TypeError ? "NETWORK_ERROR" : "RPC_SERVER_ERROR",
        name,
      );
    }
    throw error;
  }
  const { data, error, status } = result;
  if (error) {
    if (name !== "report_client_issue" && name !== "list_client_issues") {
      if (status === 0) reportRuntimeIssue("rpc", "NETWORK_ERROR", name);
      else if (status >= 500)
        reportRuntimeIssue("rpc", "RPC_SERVER_ERROR", name);
    }
    // Server error details can contain submitted personal data or SQL values.
    if (import.meta.env.DEV)
      console.error("RPC failed", name, { code: error.code });
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
    | "delete"
    | "change_role"
    | "promote_to_owner"
    | "enable_user";
  user_id?: string;
  password?: string;
  disabled_until?: string | null;
  disable_reason?: string | null;
  role?: string;
}): Promise<{ outcome?: "removed" | "tombstoned" }> {
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
    call<import("@/types").CopilotGapDigest>("list_copilot_gaps", {
      p_days: days,
    }),
  listActiveAnnouncements: async () =>
    call<import("@/types").Announcement[]>("list_active_announcements"),
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
  /** STAFF gửi yêu cầu xóa xe: xe tạm ẩn khỏi kho, chờ OWNER duyệt hoặc khôi phục. */
  requestDeleteVehicle: async (id: string, reason: string) =>
    call<void>("request_delete_vehicle", { p_id: id, p_reason: reason }),
  /** OWNER xử lý yêu cầu xóa: APPROVE (xóa vĩnh viễn) hoặc RESTORE (trả lại kho). */
  resolveVehicleDeletion: async (
    requestId: string,
    action: "APPROVE" | "RESTORE",
    note?: string,
  ) =>
    call<void>("resolve_vehicle_deletion", {
      p_request_id: requestId,
      p_action: action,
      p_note: note ?? null,
    }),
  /** OWNER đọc hàng đợi chờ duyệt (mọi loại, nhóm theo kind). */
  listPendingApprovals: async (filters: Record<string, unknown> = {}) =>
    call<{ items: import("@/types").ApprovalRequest[]; total: number }>(
      "list_pending_approvals",
      { p_filters: filters },
    ),
  /**
   * STAFF/MANAGER xin bán dưới giá thu: xe vẫn nằm trong kho, chưa có doanh thu,
   * đơn vào thẳng hàng đợi "Chờ duyệt" của OWNER. Có request_id để chống gửi trùng.
   */
  requestSaleBelowCost: async (
    data: Record<string, unknown>,
    requestId: string,
  ) =>
    call<string>("request_sale_below_cost", {
      p_data: { ...data, request_id: requestId },
    }),
  /**
   * OWNER quyết định đơn bán dưới giá thu. APPROVE ghi luôn giao dịch bán trong
   * cùng transaction (tồn kho, doanh thu, lợi nhuận); REJECT giữ xe lại.
   */
  resolveSaleApproval: async (
    approvalId: string,
    action: "APPROVE" | "REJECT",
    note: string | undefined,
    requestId: string,
  ) =>
    call<{ approval_id: string; action: string; sale_id: string | null }>(
      "resolve_sale_approval",
      {
        p_approval_id: approvalId,
        p_action: action,
        p_note: note ?? null,
        p_request_id: requestId,
      },
    ),
  /** Người gửi (hoặc OWNER) rút đơn đang chờ để sửa số liệu rồi gửi lại. */
  cancelSaleApproval: async (approvalId: string, reason?: string) =>
    call<void>("cancel_sale_approval", {
      p_approval_id: approvalId,
      p_reason: reason ?? null,
    }),
  /**
   * STAFF/MANAGER gặp nghi trùng PLATE_AND_LAST5 (RED): KHÔNG lưu xe, gửi đúng dữ
   * liệu đang soạn sang hàng đợi xác minh của OWNER/MANAGER. Server tự phân loại
   * số khung và bỏ qua yêu cầu nếu tín hiệu đã mất. request_id chống gửi trùng.
   * Trả về id của đơn chờ vừa tạo. `requested_data` đi kèm ảnh/trường bắt buộc để
   * Chủ/Quản lý duyệt rồi ghi đúng bản nhân viên đã nhập.
   */
  requestVehicleDuplicateReview: async (
    data: Record<string, unknown>,
    requestId: string,
  ) =>
    call<string>("request_vehicle_duplicate_review", {
      p_data: { ...data, request_id: requestId },
    }),
  /**
   * OWNER/MANAGER quyết định đơn nghi trùng. APPROVE bắt buộc lý do và server kiểm
   * lại dữ liệu/ứng viên/trùng trong cùng transaction rồi lưu ngoại lệ (trả về
   * vehicle_id mới); REJECT không tạo gì. Không lộ giá vốn riêng tư qua phản hồi.
   */
  resolveVehicleDuplicateReview: async (
    approvalId: string,
    action: "APPROVE" | "REJECT",
    reason: string | undefined,
    requestId: string,
  ) =>
    call<{ approval_id: string; action: string; vehicle_id: string | null }>(
      "resolve_vehicle_duplicate_review",
      {
        p_approval_id: approvalId,
        p_action: action,
        p_reason: reason ?? null,
        p_request_id: requestId,
      },
    ),
  /** Hàng đợi nghi trùng riêng cho OWNER + MANAGER (không đụng hàng đợi tài chính). */
  listVehicleDuplicateReviews: async (filters: Record<string, unknown> = {}) =>
    call<{ items: import("@/types").ApprovalRequest[]; total: number }>(
      "list_vehicle_duplicate_reviews",
      { p_filters: filters },
    ),
  /**
   * Danh mục loại xe (bảng vehicle_types). Mọi role đang công tác đọc được;
   * `save_vehicle_type`/`delete_vehicle_type` là OWNER tuyệt đối — server từ
   * chối trùng tên sau chuẩn hoá và chặn xoá loại đang có xe tham chiếu.
   */
  listVehicleTypes: async () =>
    call<import("@/types").VehicleTypeItem[]>("list_vehicle_types"),
  saveVehicleType: async (id: string | null, name: string) =>
    call<{ id: string; name: string }>("save_vehicle_type", {
      p_id: id,
      p_name: name,
    }),
  deleteVehicleType: async (id: string) =>
    call<void>("delete_vehicle_type", { p_id: id }),
  /** Xóa cứng phiếu thu kèm xe đã thu (OWNER/MANAGER). */
  deleteAcquisition: async (id: string, reason: string) =>
    call<void>("delete_acquisition", { p_id: id, p_reason: reason }),
  /**
   * Phát hiện nghi trùng THÔNG MINH cho một hồ sơ xe đang soạn (ba mức
   * GREEN/YELLOW/RED). Server là nguồn chân lý: cùng bộ máy `detect` sẽ chạy
   * lại khi lưu, nên kết quả xem trước ở đây khớp từng chữ ký với lúc ghi.
   * Không có trường loại số khung — server tự suy từ độ dài (`private.frame_kind`).
   */
  checkVehicleDuplicates: async (input: {
    frame_number: string;
    license_plate: string;
    exclude_vehicle_id?: string | null;
  }) =>
    call<import("./vehicleDuplicateCheck").DuplicateCheckResult>(
      "check_vehicle_duplicates",
      { p_data: input },
    ),
  processMessage: async (messageId: string): Promise<void> => {
    if (!supabase) return;
    const { error } = await supabase.functions.invoke("process-message", {
      body: { message_id: messageId },
    });
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
  /**
   * Tạo yêu cầu thanh toán chuyển khoản VietQR động.
   */
  createVietQrPaymentRequest: async (data: {
    vehicle_id?: string;
    sale_id?: string;
    amount: number;
    qr_payload?: string;
  }) =>
    call<import("@/types").VietQrPaymentRequest>("create_vietqr_payment_request", {
      p_data: data,
    }),
  getVietQrPaymentRequest: async (id: string) =>
    call<import("@/types").VietQrPaymentRequest>("get_vietqr_payment_request", {
      p_id: id,
    }),
  cancelVietQrPaymentRequest: async (id: string, reason = "") =>
    call<import("@/types").VietQrPaymentRequest>("cancel_vietqr_payment_request", {
      p_id: id,
      p_reason: reason,
    }),
  confirmVietQrPayment: async (data: {
    qr_request_id: string;
    request_id?: string;
    payment_date?: string;
    notes?: string;
  }) =>
    call<string>("confirm_vietqr_payment", {
      p_data: data,
    }),
  getActiveVietQrRequest: async (vehicleId: string, saleId?: string) =>
    call<import("@/types").VietQrPaymentRequest | null>("get_active_vietqr_request", {
      p_vehicle_id: vehicleId,
      p_sale_id: saleId ?? null,
    }),
  /**
   * Trạng thái đối soát của một yêu cầu VietQR (tiền ngân hàng đã về chưa).
   */
  getVietQrMatchingStatus: async (qrRequestId: string) =>
    call<import("@/types").VietQrMatchingStatus | null>("get_vietqr_matching_status", {
      p_qr_request_id: qrRequestId,
    }),
  listBankTransactions: async (filters: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {}) =>
    call<import("@/types").BankTransactionList>("list_bank_transactions", {
      p_filters: filters,
    }),
  confirmBankTransaction: async (data: {
    id: string;
    request_id?: string;
    payment_date?: string;
    notes?: string;
  }) =>
    call<{ id: string; status: string; payment_id: string | null }>(
      "confirm_bank_transaction",
      { p_data: data },
    ),
  linkBankTransaction: async (data: {
    id: string;
    qr_request_id?: string;
    reference?: string;
  }) =>
    call<{ id: string; status: string; qr_request_id: string }>(
      "link_bank_transaction",
      { p_data: data },
    ),
  ignoreBankTransaction: async (data: { id: string; reason: string }) =>
    call<{ id: string; status: string }>("ignore_bank_transaction", {
      p_data: data,
    }),
  getBankWebhookState: async () =>
    call<{
      provider: string;
      webhook_enabled: boolean;
      auto_match_enabled: boolean;
      account_configured: boolean;
    }>("get_bank_webhook_state"),
  /** Probe sức khỏe webhook ngân hàng qua Edge (chỉ CONFIGURED/NOT_CONFIGURED). */
  checkBankWebhookHealth: async (): Promise<"CONFIGURED" | "NOT_CONFIGURED" | "UNREACHABLE"> => {
    ensureOnline();
    if (!supabase) return "UNREACHABLE";
    try {
      const { data } = await supabase.functions.invoke("bank-webhook", {
        method: "GET",
      });
      return data?.status === "CONFIGURED" ? "CONFIGURED" : "NOT_CONFIGURED";
    } catch {
      return "UNREACHABLE";
    }
  },
  listSaleContacts: async (saleId: string) =>
    call<import("@/types").CustomerContact[]>("list_sale_contacts", {
      p_sale_id: saleId,
    }),
  saveSaleContact: async (data: {
    id?: string;
    sale_id?: string;
    channel: string;
    handle?: string;
    phone?: string;
    display_name?: string;
    note?: string;
  }) => call<import("@/types").CustomerContact>("save_sale_contact", { p_data: data }),
  verifySaleContact: async (id: string, verified: boolean) =>
    call<import("@/types").CustomerContact>("verify_sale_contact", {
      p_data: { id, verified },
    }),
  deleteSaleContact: async (id: string) =>
    call<void>("delete_sale_contact", { p_id: id }),
  listSaleThankYouQueue: async (saleId: string) =>
    call<import("@/types").ThankYouQueueItem[]>("list_sale_thank_you_queue", {
      p_sale_id: saleId,
    }),
  markThankYouCopied: async (saleId: string) =>
    call<Record<string, unknown>>("mark_thank_you_copied", { p_sale_id: saleId }),
  markPersonalThankYouSent: async (data: {
    sale_id: string;
    channel: string;
    evidence_note?: string;
  }) =>
    call<{ id: string; status: string; channel: string }>(
      "mark_personal_thank_you_sent",
      { p_data: data },
    ),
  listMessageTemplates: async () =>
    call<import("@/types").MessageTemplate[]>("list_message_templates"),
  saveMessageTemplate: async (data: {
    code: string;
    name?: string;
    channel?: string;
    body: string;
    is_active?: boolean;
  }) => call<import("@/types").MessageTemplate>("save_message_template", { p_data: data }),
  previewMessageTemplate: async (data: { code: string; sale_id?: string }) =>
    call<{ code: string; rendered: string }>("preview_message_template", {
      p_data: data,
    }),
};

