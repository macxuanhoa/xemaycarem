// Cửa ngõ module rồng 3D: chỉ trả về lời hứa đã sẵn sàng để lớp ngoài
// (src/lib/celebrate.ts) quyết định dùng điện ảnh 3D hay pháo hoa dự phòng.
// Mọi lỗi khởi tạo WebGL được ném ra ngoài chứ không nuốt — người gọi sẽ
// tự fallback, không bao giờ để người bán hàng thấy một màn hình đen.

export { createStage, detectTier } from "./stage";
export type { StageOptions, Tier } from "./stage";
