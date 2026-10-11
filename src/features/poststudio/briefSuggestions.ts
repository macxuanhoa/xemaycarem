// Lời mồi cho ô "Mô tả tự do" ở bước 2 — bấm là có sẵn câu để sửa, khỏi nhìn ô
// trống. Tách ra file riêng để test được: mỗi câu phải qua được đúng bộ quét mà
// máy chủ sẽ áp (xem briefSignals.ts), nếu không thì người dùng bấm một cái là
// cả lượt tạo bài bị chặn mà không hiểu vì sao.
//
// Quy tắc Cà Rem cho bài công khai: không con số tiền, không số điện thoại riêng,
// không link, không từ kiểu trả góp / công nợ / giá thu / giá vốn.

export const briefSuggestions: { label: string; text: string }[] = [
  { label: "Đăng bán xe", text: "Viết bài đăng bán xe này, nhấn mạnh còn zin, kèm mời khách ghé quán xem xe." },
  { label: "Ưu đãi", text: "Viết bài ưu đãi cho xe này: quán hỗ trợ phí sang tên, tặng nhớt mới, nêu rõ ưu đãi chỉ áp dụng cuối tuần." },
  { label: "Cảm ơn khách đã mua", text: "Viết bài cảm ơn anh/chị đã tin tưởng mua xe, kể ngắn gọn chiếc xe vừa giao, mời mọi người ghé quán." },
  { label: "Khoe xe vừa độ", text: "Viết bài khoe chiếc xe vừa lên đồ tại quán, liệt kê vài hạng mục đã làm, giọng vui vẻ." },
  { label: "Bài marketing quán", text: "Viết bài marketing cho quán: quán có nhận thu mua xe cũ chính chủ, thủ tục nhanh gọn, xem xe tại quán cả tuần." },
  { label: "Xe đã bán", text: "Viết bài thông báo chiếc xe đã có chủ mới, cảm ơn khách đã tin quán, hẹn mọi người ghé quán uống trà xem xe." },
];
