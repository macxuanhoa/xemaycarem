// Đổi ảnh xe trong kho thành dữ liệu chia sẻ được. Ảnh nằm ở bucket tư nhân,
// URL ký ngắn hạn — ta tải về BẰNG CHÍNH PHIÊN BẢN NGƯỜI DÙNG đang xem, nén lại
// cho lọt message bus của tiện ích, rồi mới đưa tiếp. Không có link tư nhân nào
// được gửi cho Facebook, cũng không có ảnh nào nằm lại localStorage.

import { api } from "@/lib/api";
import { FB_SHARE_LIMITS, bytesToDataUrl, dataUrlToBytes } from "./protocol";
import type { ShareImage } from "./protocol";

/** MIME đầu ra mà cả Web Share lẫn composer Facebook đều nhận. */
export const OUTPUT_MIME = "image/jpeg";

export type SkippedImage = { path: string; reason: string };

/**
 * Tên tệp hiển thị trên Facebook: biển số/loại xe + số thứ tự. Bỏ cả dấu chấm
 * trong nhãn (chỉ giữ `.jpg` ta tự nối ở đuôi) để tên tệp không bao giờ chứa
 * ".." hay một mẩu đường dẫn nào, kể cả khi nhãn đến từ dữ liệu nhập.
 */
export function sanitizeFileName(label: string | undefined, index: number): string {
  const base = (label ?? "xe-carem")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "xe-carem"}-${index + 1}.jpg`;
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Nén/giảm kích thước bằng canvas. Trả về JPEG dưới `maxBytes`; ảnh quá lớn sau
 * 3 vòng giảm cạnh thì bỏ (trả null) để không bao giờ gửi một tệp 10 MB vào
 * trình duyệt khác qua message bus.
 */
export async function compressToJpeg(
  source: Blob,
  maxBytes = FB_SHARE_LIMITS.imageBytes,
): Promise<Blob | null> {
  const bitmap = await createImageBitmap(source);
  let scale = 1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), OUTPUT_MIME, 0.82),
    );
    if (blob && blob.size <= maxBytes) return blob;
    scale *= 0.72;
  }
  bitmap.close();
  return null;
}

/**
 * Bộ nhớ tạm TRONG BỘ NHỚ (không phải localStorage) cho ảnh đã chuẩn bị. Hai lý
 * do: (1) bấm lần thứ hai không phải tải lại 8 ảnh; (2) `navigator.share` chỉ chạy
 * khi người dùng vừa tương tác — nếu còn chờ tải ảnh vài giây thì trình duyệt từ
 * chối. UI vì thế "hâm" ảnh ngay khi thẻ bài hiện ra, lúc bấm chỉ việc lấy.
 */
type CachedImage = { mime: string; data: string; bytes: number };
const CACHE_MAX_ENTRIES = 24;
const cache = new Map<string, CachedImage>();

function remember(path: string, value: CachedImage) {
  if (cache.has(path)) cache.delete(path);
  cache.set(path, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function clearShareImageCache() {
  cache.clear();
}

/** Bao nhiêu ảnh của xe này đã sẵn sàng trong bộ nhớ (UI dùng để báo "sẵn sàng"). */
export function cachedImageCount(paths: string[]): number {
  return paths.reduce((count, path) => (cache.has(path) ? count + 1 : count), 0);
}

async function toShareImage(path: string): Promise<CachedImage> {
  const url = await api.imageUrl(path);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Ảnh không tải được (HTTP ${response.status})`);
  let blob = await response.blob();
  if (blob.size > FB_SHARE_LIMITS.imageBytes || blob.type !== OUTPUT_MIME) {
    const compressed = await compressToJpeg(blob);
    if (!compressed) throw new Error("Ảnh quá lớn, không nén gọn được");
    blob = compressed;
  }
  return { mime: OUTPUT_MIME, data: bytesToDataUrl(await blobToBytes(blob), OUTPUT_MIME), bytes: blob.size };
}

/**
 * Ký URL, tải bytes, nén nếu ảnh lớn hoặc không đúng chuẩn. Chạy SONG SONG để
 * tổng thời gian không tăng theo số ảnh. Lỗi từng ảnh chỉ loại riêng ảnh đó —
 * caption vẫn đi được, nghiệp vụ không đứt.
 */
export async function prepareShareImages(
  paths: string[],
  label: string | undefined,
  limit = FB_SHARE_LIMITS.images,
): Promise<{ images: ShareImage[]; skipped: SkippedImage[] }> {
  const wanted = paths.slice(0, limit).map((path, index) => ({ path, name: sanitizeFileName(label, index) }));
  const skipped: SkippedImage[] = paths
    .slice(limit)
    .map((path) => ({ path, reason: "Vượt giới hạn ảnh cho một lần chuyển" }));

  const settled = await Promise.allSettled(
    wanted.map(async ({ path, name }): Promise<ShareImage> => {
      const hit = cache.get(path);
      if (hit) return { name, mime: hit.mime, data: hit.data };
      const built = await toShareImage(path);
      remember(path, built);
      return { name, mime: built.mime, data: built.data };
    }),
  );

  // `allSettled` giữ nguyên thứ tự nên ảnh 1 vẫn là ảnh đầu tiên người dùng thấy.
  const images: ShareImage[] = [];
  settled.forEach((result, index) => {
    const path = wanted[index]?.path ?? "ảnh";
    if (result.status === "fulfilled") images.push(result.value);
    else
      skipped.push({
        path,
        reason: result.reason instanceof Error ? result.reason.message : "Lỗi khi chuẩn bị ảnh",
      });
  });
  return { images, skipped };
}

/**
 * Hâm trước ảnh vào bộ nhớ — gọi khi thẻ bài/preview hiện ra, không chờ người
 * dùng bấm. Thất bại thì im lặng bỏ qua: đây là tối ưu, không phải nghiệp vụ.
 */
export async function primeShareImages(paths: string[]): Promise<void> {
  await Promise.allSettled(paths.slice(0, FB_SHARE_LIMITS.images).map((path) => primeOne(path)));
}

async function primeOne(path: string): Promise<void> {
  if (cache.has(path)) return;
  remember(path, await toShareImage(path));
}

/** Data URL → File cho Web Share API (mỗi ảnh một File đúng MIME). */
export function shareImageToFile(image: ShareImage): File {
  const bytes = dataUrlToBytes(image.data);
  return new File([bytes], image.name, { type: image.mime, lastModified: Date.now() });
}

/** Tải ảnh về máy (fallback khi không chuyển tự động được). */
export function downloadShareImage(image: ShareImage) {
  const link = document.createElement("a");
  link.href = image.data;
  link.download = image.name;
  link.click();
}
