// Bộ mẫu caption dự phòng khi AI không khả năng/hết hạn mức. Chạy 100% trong
// trình duyệt trên đúng bản chiếu Tier-A — không bao giờ chạm dữ liệu tài chính.
// Quy tắc vàng như prompt AI: chỉ sự kiện có thật trong hồ sơ, không giá,
// không bịa; kết bài điều hướng ghé quán / hotline công khai.
import type { PostChannel, PostKind, StudioContext, Tone } from "@/lib/postStudioApi";

export const PUBLIC_HOTLINE = "0914.92.92.92";

type Opener = (vehicle: StudioContext) => string;

const kindOpeners: Record<PostKind, Opener[]> = {
  NEW_STOCK: [
    (v) => `${v.vehicle_title} ${v.vehicle_type ?? "xe"}${v.year ? ` ${v.year}` : ""} vừa cập bến Cà Rem.`,
    (v) => `Em ${v.vehicle_type ?? "xe"}${v.color ? ` ${v.color.toLowerCase()}` : ""}${v.year ? ` đời ${v.year}` : ""} mới về, biển ${v.license_plate ?? "sạch sẽ"}.`,
    (v) => `Cà Rem vừa nhận thêm ${v.vehicle_type ?? "xe"}${v.year ? ` ${v.year}` : ""}${v.color ? ` màu ${v.color.toLowerCase()}` : ""}.`,
  ],
  PROMO: [
    () => `Tuần này Cà Rem có mấy em tay ga sẵn kho, khách ghé là có xe đi liền.`,
    () => `Cà Rem đang có sẵn vài mẫu xe ga gọn đẹp cho bà con đổi xe cuối tuần.`,
    () => `Cuối tuần ghé Cà Rem uống trà coi xe — đang có mấy em nước còn thơm lắm.`,
  ],
  SOLD: [
    (v) => `Cảm ơn anh/chị đã tin Cà Rem. ${v.vehicle_type ?? "Chiếc xe"}${v.license_plate ? ` biển ${v.license_plate}` : ""} đã sang tay chủ mới.`,
    (v) => `Em ${v.vehicle_type ?? "xe"}${v.year ? ` ${v.year}` : ""} đã có bến mới. Cà Rem xin cảm ơn khách đã ghé quán.`,
    () => `Thêm một chiếc xe yên vị với chủ mới. Cảm ơn khách đã tin Cà Rem!`,
  ],
  MULTI: [
    (v) => `Kho Cà Rem đang sẵn mấy em ${v.vehicle_type ?? "xe ga"}${v.year ? ` đời ${v.year}` : ""}, khách chọn biển nào cũng có.`,
    () => `Cà Rem đang có vài xe ga đẹp nước, giấy tờ gọn — ghé quán xem hết một lượt cho nhanh.`,
    () => `Cuối tuần này Cà Rem mở cửa cả ngày, kho còn mấy em xe ga tới khách qua chọn.`,
  ],
  BUYBACK: [
    () => `Cà Rem đang tìm thu mua xe ga chính chủ — bán nhanh, gọn, không qua trung gian.`,
    () => `Nhà có xe cũ cần thanh lý? Cà Rem nhận thu mua, xem xe báo giá ngay tại quán.`,
    () => `Cà Rem thu mua xe máy các loại, thủ tục gọn gàng, hỗ trợ giấy tờ đầy đủ.`,
  ],
};

const closers: Record<PostChannel, string[]> = {
  FACEBOOK: [
    "Ghé quán Cà Rem xem xe trực tiếp hoặc inbox nhé bà con.",
    `Ai cần chỉ việc ghé quán hoặc alo ${PUBLIC_HOTLINE}.`,
    "Quan tâm inbox Cà Rem, dẫn đi chạy thử ngay.",
  ],
  FB_GROUP: [
    "Ai có nhu cầu cứ để lại comment hoặc inbox, Cà Rem báo giá trực tiếp (không đăng công khai).",
    "Ghé quán Cà Rem xem xe cho chắc, gọi trước 0914.92.92.92.",
    "Cà Rem ở Hội An — khách ghé quán em hướng dẫn xem xe tận nơi.",
  ],
  ZALO: [
    `Chi tiết alo/zalo ${PUBLIC_HOTLINE} nhé anh/chị.`,
    "Em gửi thêm ảnh qua Zalo, anh/chị nhắn nhé.",
    `Gọi ${PUBLIC_HOTLINE} để Cà Rem hẹn lịch xem xe.`,
  ],
};

const toneMarks: Record<Tone, string> = {
  THAN_THIEN: "Có dịp ghé Cà Rem uống ly nước coi xe cho vui nha bà con.",
  NGAN_GON: "Xem xe: gọi trước để Cà Rem dắt ra sẵn.",
  CHUYEN_NGHIA: "Xe có hồ sơ rõ ràng, khách kiểm tra giấy tờ trực tiếp tại quán.",
  VUI_VANG: "Đẹp hết ý, rinh về chạy cà phê cuối tuần là bài!",
};

const pick = <T,>(list: T[], seed: number, offset: number): T =>
  list[(seed + offset) % list.length];

/**
 * Sinh 3 caption khác nhau từ hồ sơ xe. `variation` xoay vòng theo lượt bấm
 * "Tạo lại" để mỗi lần cho bộ ba câu mới mà không cần AI.
 */
export function buildTemplateCaptions(
  vehicle: StudioContext | null,
  kind: PostKind,
  channel: PostChannel,
  tone: Tone = "THAN_THIEN",
  variation = 0,
): string[] {
  const seed = Math.max(0, Math.floor(variation));
  const openers = kindOpeners[kind];
  const fallbackContext: StudioContext = {
    id: "", internal_code: null, license_plate: null, frame_number: null,
    vehicle_type: "", year: null, color: null, status: "IN_STOCK",
    vehicle_title: "xe", vehicle_subtitle: null, images: [], store: {},
  };
  const v = vehicle ?? fallbackContext;
  return [0, 1, 2].map((index) => {
    const opener = pick(openers, seed, index)(v);
    const closer = pick(closers[channel], seed, index + 1);
    const mark = tone === "NGAN_GON" && index === 2 ? "" : ` ${toneMarks[tone]}`;
    return `${opener}${mark}\n${closer}`.trim();
  });
}
