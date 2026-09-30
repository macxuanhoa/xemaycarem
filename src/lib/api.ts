import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { AppError } from "./errors";

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
async function uploadVehicleImage(vehicleId: string, file: File) {
  ensureOnline();
  if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw new AppError("Chọn ảnh JPG, PNG hoặc WebP, tối đa 5 MB.");
  const suffix =
    file.type === "image/jpeg"
      ? "jpg"
      : file.type === "image/png"
        ? "png"
        : "webp";
  const path = `${vehicleId}/${crypto.randomUUID()}.${suffix}`;
  const { error } = await supabase.storage
    .from("vehicle-images")
    .upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw error;
  // Unregistered uploads stay private; an administrator can prune orphan objects
  // under the retention policy. Browser roles intentionally cannot hard-delete.
  await call("register_vehicle_image", {
    p_vehicle_id: vehicleId,
    p_storage_path: path,
  });
}
async function imageUrl(path: string) {
  if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
  const { data, error } = await supabase.storage
    .from("vehicle-images")
    .createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
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
    | "update_schedule";
  user_id: string;
  password?: string;
  disabled_until?: string | null;
  disable_reason?: string | null;
  allowed_from?: string;
  allowed_until?: string;
  working_days?: number[];
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
  uploadVehicleImage,
  imageUrl,
  createUser,
  manageUser,
  assist: async <T>(input: Record<string, unknown>): Promise<T> => {
    ensureOnline();
    if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
    const { data, error } = await supabase.functions.invoke("ai-assist", {
      body: input,
    });
    if (error) await handleEdgeFunctionError("ai-assist", error);
    return data as T;
  },
};
