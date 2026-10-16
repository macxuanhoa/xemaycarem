import { AppError } from "./errors";

/**
 * Lưu một tấm ảnh về thiết bị, đúng theo cách người dùng hình dung:
 *  - Điện thoại / tablet: ảnh phải đi vào **Bộ sưu tập** (Photos trên iOS,
 *    Ảnh/Tải xuống trên Android) chứ không rớt vào một thư mục Files xa xôi.
 *  - Máy tính: tải về thư mục mặc định như mọi trình duyệt vẫn làm.
 *
 * Vì sao không "tự lưu thẳng" được: trình duyệt web không có API ghi ảnh vào
 * thư viện ảnh của hệ điều hành. Cửa duy nhất là bảng chia sẻ của hệ điều hành
 * (Web Share API mức 2 — iOS có sẵn "Lưu vào Ảnh", Android có "Tải xuống"/"Ảnh").
 * Vì vậy trên điện thoại luôn mở bảng chia sẻ; nếu máy không mở được bảng đó
 * (in-app browser, trình duyệt cũ) thì rơi về tải về tệp — Android tự đưa thư mục
 * Tải xuống vào Bộ sưu tập nên ảnh vẫn hiện ra như người dùng mong.
 *
 * Vì sao phải chuẩn bị ảnh trước (warmImageForSave): iOS chỉ cho gọi
 * navigator.share khi cú chạm còn hiệu lực. Một cú fetch nằm giữa handler là
 * đủ làm mất quyền đó, nên ảnh được gom sẵn vào bộ nhớ để lệnh share chạy
 * ngay tức thì khi bấm.
 *
 * Vì sao có thêm đường "nhấn giữ" (long-press): trên iPhone/iPad, bảng chia sẻ
 * không tồn tại trong một số trình duyệt nhúng (mở link trong app nhắn tin,
 * Safari đời cũ). Tải tệp lúc đó chỉ rơi vào app FILES chứ không vào Bộ sưu
 * tập, nên thay vì báo lỗi ta trả "long-press" để UI mở khung ảnh thật và hướng
 * dẫn người dùng nhấn giữ — thao tác duy nhất đưa ảnh thẳng vào Photos.
 */

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/avif": "avif",
};
const KNOWN_EXTENSIONS = new Set(Object.values(EXT_BY_TYPE));

/** Số nhận dạng ảnh: `jpg` cho ảnh JPEG, dự phòng theo đuôi đường dẫn kho. */
export function extensionForImage(mime?: string, storagePath = ""): string {
  const byType = mime
    ? EXT_BY_TYPE[mime.split(";")[0].trim().toLowerCase()]
    : "";
  if (byType) return byType;
  const tail = /\.([a-z0-9]+)$/i.exec(storagePath.split("?")[0] ?? "")?.[1];
  const fromPath = tail?.toLowerCase();
  if (fromPath === "jpeg") return "jpg";
  return fromPath && KNOWN_EXTENSIONS.has(fromPath) ? fromPath : "jpg";
}

/**
 * Tên tệp đọc hiểu được trên mọi hệ điều hành: không dấu, không ký tự cấm,
 * không khoảng trắng (iOS/Android hiển thị tên tệp nguyên văn trong Bộ sưu tập).
 */
export function safeFileName(label: string, extension: string): string {
  const slug = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "ANH"}.${extension}`;
}

export type SaveEnvironment = {
  /** Trình duyệt chạy trên điện thoại/tablet (kể cả iPadOS ở chế độ desktop). */
  phone: boolean;
  /** iOS — chỉ máy Apple mới cần đường "nhấn giữ ảnh" thay cho tải tệp. */
  ios: boolean;
  /** Hệ điều hành cho phép gửi tệp qua bảng chia sẻ của máy. */
  canShareFiles: boolean;
};

let fileShareSupport: boolean | null = null;

/** Thăm dò một lần rồi ghi nhớ: cấp quyền chia sẻ không đổi trong một phiên. */
function probeFileShare(): boolean {
  if (fileShareSupport !== null) return fileShareSupport;
  fileShareSupport = false;
  if (typeof navigator === "undefined") return fileShareSupport;
  const host = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (typeof host.share !== "function") return fileShareSupport;
  try {
    const probe = new File([new Uint8Array(1)], "probe.jpg", {
      type: "image/jpeg",
    });
    fileShareSupport = host.canShare?.({ files: [probe] }) ?? false;
  } catch {
    fileShareSupport = false;
  }
  return fileShareSupport;
}

export function readSaveEnvironment(): SaveEnvironment {
  if (typeof navigator === "undefined")
    return { phone: false, ios: false, canShareFiles: false };
  const ua = navigator.userAgent ?? "";
  const touchPoints = navigator.maxTouchPoints ?? 0;
  const asDesktopIpad =
    /MacIntel/.test(navigator.platform ?? "") && touchPoints > 1;
  const coarsePointer =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false;
  const phone =
    /Android|iPhone|iPad|iPod|IEMobile|Mobile|Silk|Opera Mini/i.test(ua) ||
    // iPadOS 13+ khi để chế độ "Trang desktop" vẫn báo MacIntel nhưng có cảm ứng.
    asDesktopIpad ||
    (coarsePointer && touchPoints > 0);
  return {
    phone,
    ios: /iPhone|iPad|iPod/i.test(ua) || asDesktopIpad,
    canShareFiles: probeFileShare(),
  };
}

/** Ảnh có nên đi qua bảng chia sẻ của hệ điều hành để vào Bộ sưu tập không? */
export function prefersPhotoLibrary(
  env: SaveEnvironment = readSaveEnvironment(),
) {
  return env.phone && env.canShareFiles;
}

const PREPARED_TTL_MS = 90_000;
const PREPARED_MAX = 4;
/**
 * Bộ nhớ ảnh đã gom, tính theo liên kết ký: signed URL đổi mỗi lần ký nên nó là
 * chìa khoá tự nhiên. Lưu cả lượt đang tải (chứ không chỉ dữ liệu đã xong) để một
 * lần gom sớm + một lần bấm ngay sau đó không thành hai lượt tải trùng.
 *
 * Trong bộ nhớ chỉ có BLOB, không có tên tệp: cùng một tấm ảnh có thể được gọi
 * bằng hai nhãn khác nhau (ảnh xe và mặt CCCD cùng một liên kết ký), nên tên tệp
 * phải ghép lúc bấm, nếu không lần bấm sau sẽ mang tên của người gom trước.
 */
const prepared = new Map<
  string,
  { pending: Promise<Blob>; expiresAt: number }
>();

/** Giữ bộ nhớ có trần: bỏ ảnh hết hạn, nếu vẫn đầy thì bỏ ảnh cũ nhất. */
function prunePrepared(): void {
  const now = Date.now();
  for (const [key, entry] of prepared)
    if (entry.expiresAt <= now) prepared.delete(key);
  while (prepared.size > PREPARED_MAX) {
    const oldest = prepared.keys().next().value;
    if (oldest === undefined) break;
    prepared.delete(oldest);
  }
}

async function fetchImageBlob(url: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "omit" });
  } catch {
    throw new AppError("Không tải được ảnh về máy. Kiểm tra mạng rồi thử lại.");
  }
  if (!response.ok)
    throw new AppError("Không tải được ảnh về máy. Hãy thử lại.");
  return response.blob();
}

/**
 * Lấy dữ liệu ảnh, ưu tiên bản đã gom sẵn. Một lượt hỏng được xoá khỏi bộ nhớ để
 * lần bấm sau còn cơ hội tải lại thay vì lặp lại đúng lỗi đó mãi.
 */
function prepareImageBlob(url: string): Promise<Blob> {
  const cached = prepared.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const pending = fetchImageBlob(url).catch((error) => {
    if (prepared.get(url)?.pending === pending) prepared.delete(url);
    throw error;
  });
  prepared.set(url, { pending, expiresAt: Date.now() + PREPARED_TTL_MS });
  prunePrepared();
  return pending;
}

/** Ép dữ liệu ảnh thành tệp có tên đọc được trên chính thiết bị đang nhận. */
function toImageFile(blob: Blob, nameBase: string, url: string): File {
  return new File(
    [blob],
    safeFileName(nameBase, extensionForImage(blob.type, url)),
    { type: blob.type || "image/jpeg", lastModified: Date.now() },
  );
}

/**
 * Gom sẵn ảnh vào bộ nhớ trước khi người dùng bấm, để cú chạm trên điện thoại
 * mở được bảng chia sẻ ngay (máy tính không cần, cứ tải khi bấm).
 */
export function warmImageForSave(url: string): void {
  if (!prefersPhotoLibrary()) return;
  void prepareImageBlob(url).catch(() => {
    /* Ảnh chưa kịp sẵn thì lần bấm sau sẽ tự tải — đừng báo lỗi ở giai đoạn này. */
  });
}

function triggerBrowserDownload(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = file.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

export type SaveOutcome =
  "photo-library" | "download" | "long-press" | "cancelled";

/**
 * Lưu ảnh về máy theo đúng đường của thiết bị đang dùng.
 *  - `"photo-library"`: đã mở bảng chia sẻ của hệ điều hành (bước cuối người
 *    dùng tự chọn "Lưu vào Ảnh").
 *  - `"download"`: trình duyệt đã tải tệp về (máy tính, và Android vì thư mục
 *    Tải xuống được Bộ sưu tập tự quét).
 *  - `"long-press"`: iOS không mở được bảng chia sẻ — người dùng gọi phải tự
 *    mở khung hướng dẫn nhấn giữ ảnh, KHÔNG tải tệp (sẽ rơi vào FILES).
 *  - `"cancelled"`: người dùng tự đóng bảng chia sẻ — im lặng, không báo lỗi.
 */
export async function saveImageToDevice({
  url,
  nameBase,
  title,
}: {
  url: string;
  nameBase: string;
  title?: string;
}): Promise<SaveOutcome> {
  const env = readSaveEnvironment();
  const viaShareSheet = env.phone && env.canShareFiles;
  // iPhone không chia sẻ được tệp: đừng tốn một lượt tải rồi giao tệp cho FILES.
  if (env.phone && env.ios && !viaShareSheet) return "long-press";
  const file = toImageFile(await prepareImageBlob(url), nameBase, url);
  if (viaShareSheet) {
    try {
      await navigator.share({ files: [file], title: title || file.name });
      return "photo-library";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError")
        return "cancelled";
      // Máy báo không chia sẻ được tệp (dạng ảnh hệ điều hành không nhận):
      // trên iOS vẫn còn đường nhấn giữ, Android cứ tải tệp là vào Bộ sưu tập.
      if (env.ios) return "long-press";
    }
  }
  triggerBrowserDownload(file);
  return "download";
}

/**
 * Lời phản hồi cho người dùng sau một lần lưu, hoặc `null` khi không cần nói gì
 * (`"cancelled"` họ vừa tự đóng bảng, `"long-press"` đã có khung hướng dẫn riêng).
 * Gom ở đây để mọi chỗ gắn nút "Tải ảnh" dùng đúng một câu chữ.
 */
export function saveOutcomeToast(
  outcome: SaveOutcome,
): { title: string; description?: string } | null {
  if (outcome === "photo-library")
    return {
      title: "Đã mở bảng lưu của máy.",
      description: "Chọn “Lưu vào Ảnh” để ảnh hiện trong Bộ sưu tập.",
    };
  if (outcome === "download") return { title: "Đã tải ảnh về máy." };
  return null;
}
