import { supabase } from "./supabase";
import { AppError } from "./errors";
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
  email: string;
  password: string;
  full_name: string;
  role: string;
  can_view_financials: boolean;
}) {
  ensureOnline();
  if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
  const { data, error } = await supabase.functions.invoke("manage-users", {
    body: input,
  });
  if (error) {
    console.error("User creation failed", error);
    if ("context" in error && error.context instanceof Response) {
      const detail = await error.context
        .clone()
        .json()
        .catch(() => null);
      if (detail?.error === "USER_CREATED_INACTIVE") {
        throw new AppError(
          "Tài khoản đã được tạo nhưng chưa kích hoạt. Tải lại Nhân sự để kiểm tra trước khi thử lại.",
        );
      }
    }
    throw error;
  }
  if (data?.error)
    throw new AppError(
      "Không thể tạo tài khoản. Kiểm tra email và quyền của bạn.",
    );
  return data;
}
export const api = { call, uploadVehicleImage, imageUrl, createUser };
