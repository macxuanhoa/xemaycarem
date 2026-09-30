# Kết quả kiểm chứng — 30/09/2026

Môi trường: Windows, Node 22, PostgreSQL 18.4 tạm thời (nhiều kết nối riêng), Chromium headless. Mọi dữ liệu test là hư cấu, chỉ nằm trong cluster thử nghiệm và được dọn khi test kết thúc.

| Kiểm tra | Kết quả |
|---|---|
| TypeScript | Đạt |
| ESLint | Đạt |
| Validation/tiền VND/ngày Việt Nam/CSV/role | 9 unit test đạt |
| Migration/RLS/business integrity/transactions | 29 integration test đạt |
| 2 nhân viên bán cùng xe | Một giao dịch thành công, giao dịch còn lại bị chặn |
| 2 người thu tiền đồng thời | Không thể cùng làm vượt số dư còn phải thu |
| Thêm chi phí đồng thời với bán | Sale đợi khóa và dùng chi phí đã commit |
| Thu tiền đồng thời hủy bán | Khoản thu đến sau hủy bị từ chối |
| 2 OWNER hạ quyền đồng thời | Luôn giữ ít nhất một OWNER hoạt động |
| Database seed | 8 xe, idempotent; báo cáo/tổng/sort/phân trang đạt |
| Browser: nhập/sửa/chi phí/bán/thu/hủy | Đạt, tiền và trạng thái kiểm chứng lại tại PostgreSQL |
| Browser: responsive mobile/tìm toàn hệ thống | Đạt, không tràn ngang các màn hình đã thử |
| Browser: staff/route bảo vệ/user bị khóa | Đạt |
| Browser: báo cáo/CSV/audit/cài đặt | Đạt |
| Browser: chặn bán offline | Đạt, không thay đổi trạng thái tại DB |
| Production build | Đạt, có manifest + service worker + icons |
| Chromium PWA installability | Không có lỗi installability; service worker điều khiển trang |
| Offline application shell | Trang đăng nhập mở lại được khi tắt mạng |
| Dependency audit | 0 vulnerability tại thời điểm kiểm tra |

## Giới hạn của kết quả

- Integration tests tạo schema `auth`/`storage` tương thích tối thiểu để kiểm tra SQL/RLS thật. E2E mô phỏng Supabase HTTP/Auth tại biên trình duyệt, nhưng mọi RPC nghiệp vụ đều chạy trên PostgreSQL thật. Đây không phải một Supabase hosted project đang chạy.
- Chưa có URL/public key/quyền dự án cloud: chưa chạy migration trên Supabase của cửa hàng, chưa tạo OWNER thật, chưa xác nhận hosted Auth/SMTP/Edge Function hoặc upload ảnh qua Storage HTTP thật.
- Edge Function đã qua Deno strict typecheck. Test RLS Storage kiểm chứng quyền upload/read/soft-delete tại PostgreSQL; cần smoke test platform API sau khi deploy.
- Kiểm tra PWA installability bằng Chromium và viewport điện thoại. Chưa cài trực tiếp trên iPhone/Android/Windows của người dùng.
- Không dùng dữ liệu thật; không gửi email, không tạo tài khoản hoặc giao dịch bên ngoài môi trường thử nghiệm.

Chạy lại bằng các lệnh trong README. Với PWA: build, chạy `npm run preview -- --port 4173 --strictPort`, rồi ở terminal khác chạy `npm run test:pwa`.
