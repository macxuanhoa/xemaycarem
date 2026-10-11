# Cà Rem · Cầu đăng Facebook (tiện ích trình duyệt MV3)

Công cụ phụ giúp người bán hàng **chuyển bài đã duyệt sang Facebook** mà không phải
copy–paste từng chữ và tải từng ảnh. Chạy được trên Chrome / Edge / Cốc Cốc / Brave.

## Nó làm gì

1. Trang CRM gửi caption + ảnh xe (ảnh là data-URL do trình duyệt của bạn tự ký từ
   Supabase Storage) sang tiện ích qua `chrome.runtime.sendMessage`.
2. Tiện ích tìm tab `facebook.com` đang mở (không có thì mở tab mới; nhắm hội nhóm
   nếu bài đăng chọn hội nhóm).
3. Content script xác định **ô soạn thảo**, điền caption (giữ nguyên Unicode, emoji,
   xuống dòng), rồi thử đính kèm ảnh bằng `paste` tệp — fallback sang `input[type=file]`.
4. **Đọc lại** composer: so nội dung thực tế với nội dung gửi đi (ngưỡng khớp 85%) và
   đếm ảnh xem trước `blob:` thật sự xuất hiện.
5. Chỉ khi bước 4 có bằng chứng, CRM mới nói "đã chuyển sang Facebook — kiểm tra lại
   rồi bấm Đăng".

## Nó KHÔNG làm gì

- **Không bấm nút Đăng.** Không có dòng code nào click vào nhãn "Đăng"/"Post"/"Gửi".
  Người dùng luôn là người quyết định bài lên sóng.
- Không đọc cookie, localStorage, token GraphQL hay dữ liệu tài khoản Facebook.
- Không tự đăng bằng API Page, không chạy headless browser, không vượt CAPTCHA.
- Không giữ ảnh lại sau lượt chia sẻ (chỉ đi qua bộ nhớ tạm của service worker).

## Cài đặt (5 phút, dùng nội bộ)

Chrome không cho cài tiện ích từ website nội bộ, nên cài thủ công một lần:

1. Trong CRM, mục **Cài Cầu đăng Facebook** → tải `carem-fb-extension.zip`, giải nén
   ra thư mục `carem-fb-share`.
2. Mở `chrome://extensions` → bật **Developer mode** (góc phải trên).
3. Bấm **Load unpacked** → chọn thư mục `carem-fb-share` vừa giải nén.
4. Quay lại CRM, bấm lại nút chuyển bài. Nếu hiện "Chưa có Cầu đăng", bấm F5 trang CRM
   một lần.

ID tiện ích được ấn định bởi khoá `key` công khai trong `manifest.json`
(`njlnpebadapfckldkmdhdhbmnmckgcap`) nên giống nhau trên mọi máy — CRM không phải dò ID.
Khoá riêng tư **không** nằm trong repo; file này chỉ chứa khoá công khai.

## Vì sao phải là tiện ích

Trang web của ta **không được phép** chạm vào DOM của `facebook.com` (same-origin
policy). Đó là giới hạn của trình duyệt, không phải chưa viết code. Muốn "điền sẵn
bên đó" thì chỉ có hai đường hợp lệ: tiện ích mở rộng (desktop) hoặc share sheet
của hệ điều hành (điện thoại). Cả hai đều đã được cài trong CRM.

## Khi nào thì hỏng, và CRM nói gì

| Hiện tượng | Nguyên nhân | CRM báo |
| --- | --- | --- |
| "Chưa có Cầu đăng Facebook" | chưa cài / sai origin trong `externally_connectable` | tự động rơi về dán thủ công + hướng dẫn cài |
| "Tab Facebook chưa đăng nhập" | trang đang ở `/login` | đăng nhập rồi bấm lại |
| "Không tìm thấy ô đăng bài" | Facebook đổi giao diện, tab ở trang lạ | mở trang cá nhân rồi bấm lại |
| "Chỉ thấy x/y ảnh" | bản render Facebook chặn paste tệp | chữ đã vào, ảnh đính kèm tay |
| "Bài dài hơn mức Facebook cho phép" | caption > 5000 ký tự | cắt ngắn |

## Cấu trúc

| File | Vai trò |
| --- | --- |
| `manifest.json` | khai báo MV3, host Facebook, `externally_connectable` (chỉ site Cà Rem + localhost dev) |
| `background.js` | service worker: kiểm tra origin + giới hạn payload, chọn/mở tab, bơm content script, giữ worker sống, trả kết quả |
| `content.js` | adapter composer: dò ô soạn thảo theo nhiều dấu hiệu, điền, đính kèm ảnh, **đọc lại để xác minh** |

Sửa xong thì chạy `npm run fb:pack` (tự chạy trong `prebuild`) để tái tạo
`public/carem-fb-extension.zip`, và **tải lại tiện ích** ở `chrome://extensions`
(Chrome không tự nạp lại code đã cài).

## Hợp đồng phải khớp giữa hai bên

`extension/*.js` và `src/lib/fbShare/protocol.ts` dùng chung: tên kênh
`carem-fb-share`, phiên bản `1`, ngưỡng khớp caption `0.85`, giới hạn
5000 ký tự / 8 ảnh / 4 MB mỗi ảnh / 12 MB tổng. Đổi một bên là phải đổi bên kia
và tăng `FB_SHARE_PROTOCOL_VERSION`, nếu không tiện ích cũ sẽ nhận payload rồi
im lặng.
