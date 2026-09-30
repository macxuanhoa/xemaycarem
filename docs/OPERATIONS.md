# Vận hành, sao lưu và khôi phục

## Trước khi dùng dữ liệu thật

Chạy migrations trên staging, tạo OWNER và các tài khoản thử thuộc bốn vai trò, thử đăng nhập/khóa tài khoản, nhập xe và ảnh, ghi chi phí, bán một phần thanh toán, thu tiếp, hủy giao dịch. Đối chiếu dashboard/báo cáo với số đã nhập. Chỉ sau khi đúng mới dùng production. Dùng tài khoản riêng cho mỗi người, bật MFA cho tài khoản quản trị Supabase, hạn chế người có quyền SQL Editor/service-role.

Không bật đăng ký công khai. Cấu hình SMTP và redirect URL trước khi bật quên mật khẩu. Kiểm tra Supabase Security Advisor sau triển khai. Migration/release phải được lưu vào repository riêng do cửa hàng quản lý, tuyệt đối không commit secret.

## Kế hoạch sao lưu

- Dùng backup của Supabase phù hợp với gói hiện tại; kiểm tra thời gian lưu và khả năng Point-in-Time Recovery trong Dashboard. Không mặc định rằng mọi gói đều có PITR.
- Mục tiêu ban đầu: dump ngoài hệ thống mỗi ngày, giữ ít nhất 7 bản ngày/4 bản tuần/12 bản tháng. Điều chỉnh theo lượng giao dịch; nếu mất một ngày dữ liệu không chấp nhận được, bật PITR và rút ngắn khoảng backup.
- Mã hóa bản dump, lưu ngoài dự án Supabase ở nơi chỉ OWNER/quản trị có quyền. Giữ thêm bản ngoại tuyến. Ghi ngày chạy, kích thước, mã SHA-256 và kết quả vào sổ vận hành.
- Database backup không chứa nội dung binary của ảnh. Sao lưu riêng private bucket `vehicle-images` qua Storage API/CLI được hỗ trợ; lưu đầy đủ object path, metadata và checksum. Không chỉ sao lưu signed URL vì chúng hết hạn.
- Sao lưu cấu hình Auth/SMTP, redirect URLs, policies, migrations, phiên bản ứng dụng và danh mục secrets (secret thật trong password manager). Không đưa mật khẩu/token vào log.

Với kết nối Postgres tin cậy, dùng `pg_dump` cùng hoặc mới hơn phiên bản server. Đặt mật khẩu trong `.pgpass`/`PGPASSFILE` được bảo vệ, tránh đưa vào command history:

```powershell
pg_dump --host=YOUR_DB_HOST --port=5432 --username=postgres --dbname=postgres --format=custom --no-owner --no-acl --schema=public --schema=private --file=xe-crm-YYYY-MM-DD.dump
pg_restore --list xe-crm-YYYY-MM-DD.dump
Get-FileHash xe-crm-YYYY-MM-DD.dump -Algorithm SHA256
```

Dump business schemas có khóa ngoại tới `auth.users`: **phải có bản backup Auth users tương thích** khi khôi phục dự án mới. Ưu tiên quy trình backup/restore đầy đủ được Supabase hỗ trợ cho Auth và Storage metadata. Nếu tự xuất `auth`, coi đó là dữ liệu đặc biệt nhạy cảm vì chứa password hashes/session records; mã hóa và giới hạn truy cập. Không đưa nguyên schema hệ thống managed từ phiên bản khác vào một dự án mới mà chưa kiểm tra tương thích.

## Diễn tập khôi phục

Ít nhất mỗi quý, và trước thay đổi schema lớn:

1. Chọn bản backup, kiểm tra checksum và khả năng đọc bằng `pg_restore --list`.
2. Tạo **dự án staging tách biệt**; không thử restore lên production đang hoạt động.
3. Dùng restore của Supabase cho bản full backup/PITR. Với logical dump, chuẩn bị extensions/schema Auth/Storage tương thích và phục hồi users giữ nguyên UUID trước nghiệp vụ. Dùng quy trình Supabase hỗ trợ, không sửa bảng auth tùy tiện.
4. Restore business schemas vào database staging trống/tương thích. Tránh chạy migration tạo bảng hai lần. Có thể dùng `pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname=STAGING_DATABASE xe-crm-YYYY-MM-DD.dump` khi đã chuẩn bị đúng dependency. Lệnh này chỉ được dùng với staging xác định rõ.
5. Áp lại grants/RLS cần thiết, xác minh tất cả bảng exposed bật RLS và anon không đọc được. Khi `--no-acl` được dùng, permissions không được tự restore; đối chiếu migration grants đã lưu theo release.
6. Phục hồi file ảnh về đúng bucket private và object path; kiểm tra signed URL/ảnh trong xe.
7. Đối chiếu số xe theo trạng thái, số sale hoàn tất/hủy, tổng thanh toán ACTIVE/VOIDED, tổng doanh thu, snapshot giá vốn và audit. Kiểm tra constraint sale trùng, số tiền không âm, không có sale mồ côi.
8. Chạy smoke test với OWNER/MANAGER/STAFF/VIEWER và tài khoản bị khóa. Ghi thời gian restore thực tế và các lỗi phát hiện.

Nếu cần khôi phục production, tạm dừng nhập giao dịch, ghi rõ mốc phục hồi và các giao dịch sau mốc có thể phải đối chiếu. Backup trạng thái hiện tại trước khi thay thế. Chỉ chuyển ứng dụng sang database đã phục hồi sau khi OWNER đối chiếu số dư và các giao dịch.

## Sự cố thường gặp

| Hiện tượng | Kiểm tra |
|---|---|
| Chưa kết nối cửa hàng | URL/public key frontend và khởi động/build lại |
| Đăng nhập được nhưng chưa có quyền | `profiles.active`, role và profile UUID trùng Auth user |
| Tạo nhân viên lỗi | Edge Function đã deploy, OWNER active, `ALLOWED_ORIGINS`, Edge logs |
| Không thấy giá mua | OWNER hoặc MANAGER có `can_view_financials=true` |
| Không bán được xe | Trạng thái không SOLD/CANCELLED, `cost_pending=false`, ngày bán hợp lệ |
| Số vốn tồn là `—` | Có xe chờ bổ sung giá mua; kiểm tra kho |
| Mất mạng khi lưu | Không bấm lặp liên tục; tải lại danh sách kiểm tra giao dịch đã ghi chưa |
| Hủy sale đã thu tiền | Khoản thu được VOIDED trên sổ; hoàn tiền thực tế và đối chiếu riêng |
| Ảnh không tải | Bucket private/policies, metadata path, signed URL mới, CSP custom domain |
| Không có nút cài PWA | HTTPS/localhost, manifest/service worker, Chrome/Edge hỗ trợ, app đã cài chưa |

Auth/Edge/Storage hosted không được giả định đã kiểm thử chỉ vì unit test hoặc PostgreSQL cục bộ chạy thành công. Theo dõi log không chứa mật khẩu/token và ghi lại các lỗi giao dịch cần đối chiếu.

## Tài liệu chính thức

- [Supabase database functions](https://supabase.com/docs/guides/database/functions)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
- [Vite PWA](https://vite-pwa-org.netlify.app/guide/)
