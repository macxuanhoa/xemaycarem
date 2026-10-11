// Ba chiến lược chuyển bài đăng sang Facebook, dùng chung một hợp đồng.
//  - EXTENSION: tiện ích điền thẳng vào composer rồi ĐỌC LẠI để xác nhận.
//  - NATIVE:     share sheet gốc của hệ điều hành — chữ + ảnh trong một lần.
//  - MANUAL:     để sẵn bộ nhớ tạm / tải ảnh, mở Facebook, người dùng dán.
// Không chiến lược nào được quyền nói "đã đăng". Mỗi chiến lược chỉ báo đã trao
// dữ liệu tới đâu và có bằng chứng gì. Runtime truyền vào từ ngoài để test dựng
// được cả ba nhánh mà không cần trình duyệt thật.

import type { ExtensionShareReply } from "./bridge";
import { chooseStrategy } from "./detect";
import type { ShareEnv } from "./detect";
import { shareImageToFile } from "./images";
import { FB_HOME } from "./protocol";
import type { ShareImage, SharePayload } from "./protocol";
import { emptyOutcome } from "./status";
import type { ShareOutcome, ShareStage, ShareStrategyId } from "./status";

export type StageReporter = (stage: ShareStage, detail?: string) => void;

export type ShareStrategy = {
  id: ShareStrategyId;
  run: (payload: SharePayload, report: StageReporter) => Promise<ShareOutcome>;
};

/** Mọi副作用 đều đi qua đây: mở tab, clipboard, share sheet, gọi tiện ích. */
export type ShareRuntime = {
  env: ShareEnv;
  open: (url: string) => void;
  writeClipboard: (text: string, images: ShareImage[]) => Promise<{ text: boolean; images: number }>;
  share: (data: { text: string; files: File[] }) => Promise<void>;
  extensionShare: (payload: SharePayload) => Promise<ExtensionShareReply>;
  extensionPing: () => Promise<boolean>;
};

export type BuiltStrategies = Record<ShareStrategyId, ShareStrategy>;

function outcome(
  strategy: ShareStrategyId,
  stage: ShareOutcome["stage"],
  detail: string,
  extra: Partial<ShareOutcome> = {},
): ShareOutcome {
  return { ...emptyOutcome(strategy), stage, detail, ...extra };
}

/**
 * Mã lỗi từ content script → lời người. Không lộ selector/DOM, nhưng đủ để
 * người dùng biết phải làm gì tiếp (đăng nhập, chờ FB đổi, đính kèm ảnh tay).
 */
export function describeExtensionCode(code?: string): string {
  if (code === "COMPOSER_NOT_FOUND")
    return "Không tìm thấy ô đăng bài trên Facebook — có thể tab đang ở trang khác, chưa đăng nhập, hoặc Facebook vừa đổi giao diện. Bạn mở sẵn trang cá nhân rồi bấm lại nhé.";
  if (code === "NOT_LOGGED_IN") return "Tab Facebook chưa đăng nhập. Đăng nhập rồi thử lại nhé.";
  if (code === "CAPTION_REJECTED") return "Facebook không nhận nội dung đã điền (bài quá dài hoặc bị chặn).";
  if (code === "CAPTION_TOO_LONG") return "Bài dài hơn mức Facebook cho phép trong một lần — hãy cắt ngắn rồi thử lại.";
  if (code === "IMAGES_REJECTED") return "Facebook không nhận ảnh tự động. Bạn đính kèm ảnh thủ công.";
  if (code === "EXTENSION_PROTOCOL_MISMATCH" || code === "PROTOCOL_MISMATCH")
    return "Tiện ích đang ở phiên bản khác. Hãy tải lại tiện ích.";
  if (code === "TAB_LOAD_TIMEOUT" || code === "NO_FACEBOOK_TAB")
    return "Không mở được tab Facebook. Kiểm tra mạng hoặc tự mở facebook.com rồi bấm lại.";
  if (code === "CONTENT_SCRIPT_UNAVAILABLE" || code === "CONTENT_SCRIPT_NO_REPLY")
    return "Tiện ích không nói chuyện được với trang Facebook — tải lại tab Facebook rồi bấm lại.";
  if (code === "ORIGIN_NOT_ALLOWED")
    return "Trang này không được tiện ích chấp nhận. Chỉ site Cà Rem đã khai báo mới dùng được Cầu đăng.";
  return "Tiện ích không xác nhận được nội dung đã vào Facebook.";
}

function extensionStrategy(runtime: ShareRuntime): ShareStrategy {
  return {
    id: "EXTENSION",
    async run(payload, report) {
      report("OPENING");
      report("TRANSFERRING");
      let reply: ExtensionShareReply;
      try {
        reply = await runtime.extensionShare(payload);
      } catch (error) {
        const code = error instanceof Error ? error.message : "EXTENSION_FAILED";
        return outcome(
          "EXTENSION",
          "FAILED",
          code === "SHARE_TIMEOUT"
            ? "Tiện ích không phản hồi kịp — có thể Facebook đang thay đổi giao diện."
            : "Tiện ích không trả lời nên chưa chuyển được nội dung.",
          { imagesExpected: payload.images.length },
        );
      }
      report("VERIFYING");
      const expected = payload.images.length;
      const attached = Number(reply.imagesAttached ?? 0);
      if (!reply.ok || !reply.captionFilled)
        return outcome("EXTENSION", "FAILED", describeExtensionCode(reply.code), {
          imagesAttached: attached,
          imagesExpected: expected,
        });
      if (expected > 0 && attached < expected)
        return outcome(
          "EXTENSION",
          "PARTIAL_SUCCESS",
          `Facebook đã nhận chữ và ${attached}/${expected} ảnh. Số ảnh còn thiếu bạn đính kèm thêm trong Facebook rồi hãy Đăng.`,
          { captionFilled: true, imagesAttached: attached, imagesExpected: expected },
        );
      return outcome(
        "EXTENSION",
        "READY_FOR_REVIEW",
        expected
          ? `Facebook đã nhận đủ chữ và ${expected} ảnh — chữ và ảnh đều đã được đọc lại trên composer. Kiểm tra lại rồi bấm Đăng.`
          : "Facebook đã nhận nội dung (đã đọc lại trên composer). Kiểm tra lại rồi bấm Đăng.",
        { captionFilled: true, imagesAttached: attached || expected, imagesExpected: expected },
      );
    },
  };
}

function nativeStrategy(runtime: ShareRuntime): ShareStrategy {
  return {
    id: "NATIVE",
    async run(payload, report) {
      const files = payload.images.map(shareImageToFile);
      report("TRANSFERRING");
      try {
        await runtime.share({ text: payload.caption, files });
      } catch (error) {
        // Người dùng đóng bảng chia sẻ là HUỶ, không phải lỗi hệ thống.
        if (error instanceof DOMException && error.name === "AbortError")
          return outcome("NATIVE", "CANCELLED", "Bạn đã tắt bảng chia sẻ — chưa gửi gì cả.", {
            imagesExpected: files.length,
          });
        return outcome("NATIVE", "FAILED", "Thiết bị từ chối nhận nội dung chia sẻ.", {
          imagesExpected: files.length,
        });
      }
      const tookImages = runtime.env.webShareFiles && files.length > 0;
      return outcome(
        "NATIVE",
        tookImages ? "READY_FOR_REVIEW" : "PARTIAL_SUCCESS",
        tookImages
          ? "Đã mở bảng chia sẻ kèm chữ và ảnh. Chọn Facebook, kiểm tra lại rồi bấm Đăng."
          : files.length
            ? "Đã mở bảng chia sẻ kèm chữ. Ảnh không đi cùng được — tải ảnh về rồi đính kèm khi đăng."
            : "Đã mở bảng chia sẻ kèm chữ. Chọn Facebook rồi bấm Đăng.",
        // Share sheet chỉ chứng minh đã trao dữ liệu cho hệ điều hành, không phải
        // Facebook đã nhận — nên captionFilled luôn false ở nhánh này.
        { imagesExpected: files.length },
      );
    },
  };
}

function targetUrl(payload: SharePayload): string {
  return payload.target === "GROUP" ? (payload.groupUrl ?? FB_HOME) : FB_HOME;
}

function manualStrategy(runtime: ShareRuntime): ShareStrategy {
  return {
    id: "MANUAL",
    async run(payload, report) {
      report("TRANSFERRING");
      let clipboard = { text: false, images: 0 };
      try {
        clipboard = await runtime.writeClipboard(payload.caption, payload.images);
      } catch {
        clipboard = { text: false, images: 0 };
      }
      report("OPENING");
      runtime.open(targetUrl(payload));
      const detail = !clipboard.text
        ? "Trình duyệt không cho copy tự động. Bôi đen nội dung rồi copy tay, hoặc tải ảnh về."
        : payload.images.length && !clipboard.images
          ? `Đã copy chữ. Đã mở Facebook — dán (Ctrl+V) vào ô đăng bài, rồi tải ${payload.images.length} ảnh về và đính kèm.`
          : payload.images.length
            ? `Đã copy chữ và ${clipboard.images} ảnh. Dán (Ctrl+V) vào ô đăng bài của Facebook rồi bấm Đăng.`
            : "Đã copy nội dung. Dán (Ctrl+V) vào ô đăng bài của Facebook rồi bấm Đăng.";
      return outcome("MANUAL", "FALLBACK_REQUIRED", detail, { imagesExpected: payload.images.length });
    },
  };
}

export function buildStrategies(runtime: ShareRuntime): BuiltStrategies {
  return {
    EXTENSION: extensionStrategy(runtime),
    NATIVE: nativeStrategy(runtime),
    MANUAL: manualStrategy(runtime),
  };
}

/**
 * Chạy chiến lược tốt nhất cho môi trường hiện tại, tự rơi về nhánh thấp hơn
 * khi nhánh trên thất bại. Thứ tự rơi: EXTENSION → NATIVE (nếu máy có share)
 * → MANUAL. CANCELLED thì DỪNG: người dùng đã chủ động huỷ, không nài họ dán.
 *
 * `tried` chỉ liệt kê những nhánh THỰC SỰ đã chạy — UI in dòng "đã lần lượt thử"
 * từ danh sách này, nên kê cả nhánh chưa đụng tới là nói quá.
 */
export async function runShare(
  runtime: ShareRuntime,
  payload: SharePayload,
  report: StageReporter,
): Promise<{ outcome: ShareOutcome; tried: ShareStrategyId[] }> {
  const strategies = buildStrategies(runtime);
  const chain: ShareStrategyId[] = [];
  const primary = chooseStrategy(runtime.env).strategy;
  chain.push(primary);
  if (primary !== "NATIVE" && (runtime.env.webShare || runtime.env.webShareFiles)) chain.push("NATIVE");
  if (primary !== "MANUAL") chain.push("MANUAL");

  const tried: ShareStrategyId[] = [];
  let last = outcome("MANUAL", "FAILED", "Chưa chuyển được nội dung sang Facebook.");
  for (const id of chain) {
    tried.push(id);
    const result = await strategies[id].run(payload, report);
    last = { ...result, strategy: id };
    // Đã xong (có/không có bằng chứng) hoặc người dùng huỷ → dừng, giữ nguyên lời.
    if (id === "MANUAL") break;
    if (result.stage === "READY_FOR_REVIEW" || result.stage === "PARTIAL_SUCCESS") break;
    if (result.stage === "CANCELLED") break;
  }
  return { outcome: last, tried };
}
