import { supabase } from "./supabase";
import { AppError } from "./errors";

/**
 * Cổng lưu trữ tập trung (storage gateway) — nơi DUY NHẤT phía frontend biết
 * ảnh nằm ở đâu và truy cập ra sao: tên bucket, quy tắc đường dẫn object,
 * giới hạn tệp và thời hạn signed URL.
 *
 * Lý do tồn tại: khi cần chuyển kho ảnh sang backend khác (S3, Cloudflare R2)
 * chỉ file này + biến môi trường phải thay đổi; dữ liệu trong database chỉ lưu
 * đường dẫn tương đối `<subject-uuid>/<uuid>.<ext>` nên nguyên vẹn sau di trú.
 *
 * Quy tắc cứng (ghi tại docs/DECISIONS.md):
 *  - Không file nào khác được gọi supabase.storage trực tiếp.
 *  - Database không bao giờ chứa URL tuyệt đối hay signed URL.
 *  - Ảnh (nhất là CCCD) chỉ hiển thị qua signed URL hạn ngắn, không link công khai.
 */

export const VEHICLE_IMAGE_BUCKET = "vehicle-images";
export const IDENTITY_DOCUMENT_BUCKET = "identity-documents";
/** Signed URL cho ảnh xe showroom. */
export const VEHICLE_IMAGE_URL_TTL_SECONDS = 300;
/** CCCD là PII nên hạn nghiêm ngặt hơn ảnh xe. */
export const IDENTITY_DOCUMENT_URL_TTL_SECONDS = 120;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

function requireClient() {
  if (!supabase) throw new AppError("Chưa kết nối cơ sở dữ liệu.");
  return supabase;
}

/**
 * `<subject-uuid>/<uuid>.<ext>` gắn object với hàng nghiệp vụ tương ứng
 * (xe / hồ sơ thu / hồ sơ bán) để Storage RLS kiểm soát được theo vai trò.
 * Tên uuid mới mỗi lần nghĩa là không bao giờ ghi đè ảnh cũ.
 */
function objectPathFor(subjectId: string, file: File) {
  const suffix =
    file.type === "image/jpeg"
      ? "jpg"
      : file.type === "image/png"
        ? "png"
        : "webp";
  return `${subjectId}/${crypto.randomUUID()}.${suffix}`;
}

/** Upload một ảnh vào bucket chỉ định, trả về đường dẫn tương đối để lưu DB. */
export async function uploadImage(
  bucket: string,
  subjectId: string,
  file: File,
): Promise<string> {
  const client = requireClient();
  if (
    !ACCEPTED_IMAGE_TYPES.includes(file.type) ||
    file.size > MAX_UPLOAD_BYTES
  )
    throw new AppError("Chọn ảnh JPG, PNG hoặc WebP, tối đa 5 MB.");
  const path = objectPathFor(subjectId, file);
  const { error } = await client.storage
    .from(bucket)
    .upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw error;
  // Object chưa đăng ký vẫn riêng tư; quản trị viên dọn orphan theo chính sách
  // retention. Vai trò trình duyệt cố ý không được hard-delete.
  return path;
}

/** Sinh signed URL hạn ngắn cho một đường dẫn tương đối đã lưu trong DB. */
export async function signedImageUrl(
  bucket: string,
  path: string,
  ttlSeconds: number,
): Promise<string> {
  const client = requireClient();
  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUrl(path, ttlSeconds);
  if (error) throw error;
  return data.signedUrl;
}
