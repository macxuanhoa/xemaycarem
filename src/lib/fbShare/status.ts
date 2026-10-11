// Trạng thái của một lần chuyển nội dung sang Facebook. Tách thành file riêng vì
// bộ đếm trạng thái là thứ duy nhất cho phép UI được nói tới bước nào đã xong — nói
// sai ở đây tức là nói dối người dùng rằng bài đã nằm trên Facebook.

export const SHARE_STAGES = [
  "IDLE",
  "PREPARING",
  "OPENING",
  "TRANSFERRING",
  "VERIFYING",
  "READY_FOR_REVIEW",
  "PARTIAL_SUCCESS",
  "FAILED",
  "FALLBACK_REQUIRED",
  "CANCELLED",
] as const;
export type ShareStage = (typeof SHARE_STAGES)[number];

export type ShareStrategyId = "EXTENSION" | "NATIVE" | "MANUAL";

export type ShareOutcome = {
  stage: ShareStage;
  strategy: ShareStrategyId;
  /** Đã được XÁC MINH là composer nhận caption (chỉ EXTENSION trả về được). */
  captionFilled: boolean;
  /** Số ảnh composer thực sự đính kèm, theo xác nhận của content script. */
  imagesAttached: number;
  imagesExpected: number;
  /** Mô tả ngắn bằng tiếng Việt để hiển thị thẳng cho người dùng. */
  detail: string;
};

/**
 * Ba khái niệm phải tách bạch, không được gộp lời:
 *  - đã trao dữ liệu cho hệ điều hành/share sheet  → READY_FOR_REVIEW
 *  - đã xác minh Facebook nhận nội dung            → captionFilled === true
 *  - người dùng đã bấm Đăng                        → CRM không bao giờ biết, không assert
 */
export function isVerifiedByFacebook(outcome: ShareOutcome): boolean {
  return outcome.strategy === "EXTENSION" && outcome.captionFilled;
}

export const stageLabels: Record<ShareStage, string> = {
  IDLE: "Sẵn sàng",
  PREPARING: "Đang chuẩn bị nội dung và ảnh…",
  OPENING: "Đang mở Facebook…",
  TRANSFERRING: "Đang chuyển nội dung sang Facebook…",
  VERIFYING: "Đang kiểm tra Facebook đã nhận đủ chưa…",
  READY_FOR_REVIEW: "Đã chuyển sang Facebook — kiểm tra lại rồi hãy bấm Đăng.",
  PARTIAL_SUCCESS: "Chưa chuyển đủ — xem hướng dẫn bên dưới.",
  FAILED: "Chưa chuyển được sang Facebook.",
  FALLBACK_REQUIRED: "Không tự điền được, đã chuẩn bị sẵn để bạn dán.",
  CANCELLED: "Bạn đã huỷ giữa chừng — chưa gửi gì cả.",
};

export function emptyOutcome(strategy: ShareStrategyId = "MANUAL"): ShareOutcome {
  return {
    stage: "IDLE",
    strategy,
    captionFilled: false,
    imagesAttached: 0,
    imagesExpected: 0,
    detail: "",
  };
}
