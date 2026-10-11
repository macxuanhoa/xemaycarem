// Mặt tiền dùng trong app: gộp thăm dò môi trường + chuẩn bị ảnh + chạy chiến
// lược. UI chỉ cần gọi `shareVehiclePost(...)` và nghe `report(...)`.
//
// Cam kết với người dùng: hàm này KHÔNG BAO GIỜ trả về "đã đăng". Kết quả sớm
// nhất là "đã chuyển sang Facebook, đang chờ bạn bấm Đăng", và chữ "đã chuyển"
// chỉ chắc chắn khi tiện ích đọc lại composer xác nhận.

import { readBrowserEnv, chooseStrategy } from "./detect";
import type { StrategyChoice } from "./detect";
import { prepareShareImages } from "./images";
import type { SkippedImage } from "./images";
import { validateSharePayload } from "./protocol";
import type { FacebookShareTarget, ShareErrorCode, SharePayload } from "./protocol";
import { pingExtension, requestExtensionShare } from "./bridge";
import { runShare } from "./strategies";
import type { ShareRuntime, StageReporter } from "./strategies";
import { emptyOutcome } from "./status";
import type { ShareEnv } from "./detect";
import type { ShareOutcome, ShareStrategyId } from "./status";

/** Mở tab Facebook. `noopener` để tab mới không cầm được window của CRM. */
function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Clipboard: text luôn; ảnh thử đưa kèm bằng ClipboardItem (Chrome/Edge desktop
 * cho phép MỘT ảnh mỗi lần viết). Không được xem đây là bằng chứng Facebook đã
 * nhận — đó chỉ là "đã để sẵn để dán".
 */
async function writeClipboard(text: string, images: SharePayload["images"]) {
  if (!navigator.clipboard?.writeText) return { text: false, images: 0 };
  await navigator.clipboard.writeText(text);
  let attached = 0;
  const ClipboardItemCtor = (window as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (navigator.clipboard.write && ClipboardItemCtor && images.length) {
    try {
      const first = images[0];
      let blob = await (await fetch(first.data)).blob();
      // Share attachments are JPEG; the browser's image clipboard accepts PNG.
      // Convert only this temporary clipboard representation, keeping the
      // original share attachment unchanged.
      if (blob.type !== "image/png") {
        const bitmap = await createImageBitmap(blob);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Không chuẩn bị được ảnh để sao chép.");
          ctx.drawImage(bitmap, 0, 0);
          blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(value => value ? resolve(value) : reject(new Error("Không đổi được ảnh để sao chép.")), "image/png"),
          );
        } finally {
          bitmap.close();
        }
      }
      // A new write replaces the clipboard. Keep the caption and image as two
      // representations of the same item so accepting the image never erases text.
      await navigator.clipboard.write([new ClipboardItemCtor({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "image/png": blob,
      })]);
      attached = 1;
    } catch {
      attached = 0;
    }
  }
  return { text: true, images: attached };
}

async function nativeShare(data: { text: string; files: File[] }) {
  if (data.files.length && navigator.canShare?.({ files: data.files }))
    await navigator.share({ text: data.text, files: data.files });
  else await navigator.share({ text: data.text });
}

export function createBrowserRuntime(env: ShareEnv): ShareRuntime {
  return {
    env,
    open: openTab,
    writeClipboard,
    share: nativeShare,
    extensionShare: requestExtensionShare,
    extensionPing: pingExtension,
  };
}

export type ShareRequest = {
  caption: string;
  /** Đường dẫn ảnh trong bucket xe — rỗng thì chỉ chuyển chữ. */
  imagePaths?: string[];
  vehicleLabel?: string;
  target?: FacebookShareTarget;
  groupUrl?: string;
};

export type ShareResult = {
  outcome: ShareOutcome;
  /** Ảnh bị loại khi chuẩn bị (hỏng/nặng quá) — UI phải nói rõ, không im lặng. */
  skipped: SkippedImage[];
  /** Những chiến lược đã lần lượt thử, để báo cáo đúng sự thật. */
  tried: ShareStrategyId[];
  /** Payload bị chặn ở cửa kiểm tra (không có nghĩa là Facebook từ chối). */
  rejection?: ShareErrorCode;
};

const NOOP: StageReporter = () => undefined;

/**
 * Dòng chảy đầy đủ: chuẩn bị ảnh → kiểm tra payload → chiến lược tốt nhất →
 * rơi nhánh nếu cần. Mọi trạng thái được báo về qua `report` để UI hiển thị
 * đúng bước đang diễn ra.
 */
export async function shareVehiclePost(
  request: ShareRequest,
  report: StageReporter = NOOP,
): Promise<ShareResult> {
  report("PREPARING");
  const env = readBrowserEnv(false);
  const extensionReady = env.platform === "desktop" ? await pingExtension() : false;
  const runtime = createBrowserRuntime({ ...env, extensionReady });

  const paths = request.imagePaths ?? [];
  const prepared = paths.length
    ? await prepareShareImages(paths, request.vehicleLabel)
    : { images: [], skipped: [] as SkippedImage[] };

  const checked = validateSharePayload({
    caption: request.caption,
    images: prepared.images,
    target: request.target ?? "PERSONAL",
    groupUrl: request.groupUrl,
    vehicleLabel: request.vehicleLabel,
  });
  if (!checked.ok)
    return {
      outcome: {
        ...emptyOutcome("MANUAL"),
        stage: "FAILED",
        detail: rejectionMessage(checked.code),
        imagesExpected: paths.length,
      },
      skipped: prepared.skipped,
      tried: [],
      rejection: checked.code,
    };

  const run = await runShare(runtime, checked.value, report);
  return { outcome: run.outcome, tried: run.tried, skipped: prepared.skipped };
}

export function rejectionMessage(code: ShareErrorCode): string {
  if (code === "EMPTY_CAPTION") return "Chưa có nội dung để chuyển. Hãy tạo hoặc viết caption trước.";
  if (code === "CAPTION_TOO_LONG") return "Bài dài quá mức Facebook nhận trong một lần — hãy cắt ngắn.";
  if (code === "TOO_MANY_IMAGES") return "Một lần chỉ chuyển được tối đa 8 ảnh.";
  if (code === "IMAGE_TOO_LARGE" || code === "TOTAL_TOO_LARGE")
    return "Ảnh nặng quá so với giới hạn chuyển. Hãy tải ảnh về và đính kèm thủ công.";
  if (code === "BAD_IMAGE") return "Có ảnh không đúng định dạng nên không chuyển được.";
  if (code === "BAD_GROUP_URL") return "Cần link hội nhóm dạng https://www.facebook.com/groups/… để mở đúng nơi đăng.";
  return "Chưa chuyển được nội dung.";
}

/** Cho UI biết sẽ dùng cách nào trước khi bấm, kèm lý do. */
export async function describePlan(): Promise<{ env: ShareEnv; choice: StrategyChoice; extensionReady: boolean }> {
  const base = readBrowserEnv(false);
  const extensionReady = base.platform === "desktop" ? await pingExtension() : false;
  const env = { ...base, extensionReady };
  return { env, choice: chooseStrategy(env), extensionReady };
}
