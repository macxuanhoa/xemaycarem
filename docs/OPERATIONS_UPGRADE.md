# Môi trường thử riêng và sức khỏe sao lưu

## Môi trường staging

Staging phải là **dự án Supabase khác production**, có tài khoản và dữ liệu thử riêng. Không dùng `.env` production với `vite --mode staging`: Vite vẫn có thể đọc các tệp môi trường chung. Quy trình dưới tạo bộ môi trường biệt lập và từ chối URL/anon key thuộc production, service-role key, hoặc project ref không khớp.

1. Tạo/chọn dự án Supabase thử riêng trong tài khoản của cửa hàng. Chi phí và vùng đặt dự án do OWNER quyết định. Không tự tạo dịch vụ tính phí từ script.
2. Sao chép `config/staging.env.example` thành `.env.staging` (đã được git-ignore). Điền `CAREM_PRODUCTION_PROJECT_REF`, `CAREM_STAGING_PROJECT_REF`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Frontend chỉ dùng publishable/anon key của staging.
3. Chạy `node scripts/staging-check.mjs --offline`. Nếu repository đang linked production, reference khai báo phải khớp linkage đó; URL staging phải đúng dự án riêng đã khai báo. Script không đổi linkage và không chạy migration.
4. Áp migrations và deploy Edge Functions vào staging qua dự án đích được xác định riêng. Đối chiếu project ref trước khi thao tác; không dùng `db push --linked` trong checkout đang linked production. Secrets AI/SMTP ở staging phải riêng; không gửi email/tin nhắn tới khách thật khi thử.
5. Chạy `node scripts/staging-check.mjs` để kiểm tra Auth và xác nhận anon không đọc được hàng xe/CCCD. Script chỉ gửi GET, không lưu response chứa dữ liệu vào báo cáo. Báo cáo ở `scratch/staging-readiness.json`.
6. Chạy `npm run typecheck`, `npm run ocr:assets`, rồi `node scripts/staging-build.mjs`. Bản riêng nằm ở `scratch/staging-dist`, có `VITE_APP_ENV=staging`; bộ build không dùng biến `VITE_*` production từ process hoặc `.env` chung. Phục vụ bản đó trên hostname staging riêng có HTTPS để kiểm tra camera điện thoại.
7. Tạo OWNER/MANAGER/STAFF thử, chạy nhập xe + ảnh, chi phí, bán/thu tiền/hủy, khóa tài khoản và phân quyền. Đối chiếu dashboard, dữ liệu, signed URL ảnh và hành vi camera trên máy thật. Các kiểm tra GET không thay thế bước này.

Workflow `.github/workflows/staging-readiness.yml` chạy thủ công khi có biến `STAGING_PROJECT_REF`, `PRODUCTION_PROJECT_REF` và secret `STAGING_SUPABASE_ANON_KEY` trong GitHub Environment `staging`. Nó kiểm tra và xuất artifact build; **không tự tạo dự án, áp migrations hoặc deploy**. Chỉ dùng dữ liệu giả trong môi trường thử; bản khôi phục chứa dữ liệu thật cần quyền truy cập riêng và không public qua preview.

## Sao lưu hằng ngày và diễn tập hằng tuần

Lịch Windows hiện có được giữ nguyên: **21:30 mỗi ngày**, chạy bù khi người dùng đăng nhập sau giờ hẹn. Script `scripts/install-backup-task.ps1` dùng cùng tên task để tránh tạo bản trùng; không đổi giờ lịch đang tồn tại trừ khi truyền `-At` rõ ràng. Lịch **Chủ nhật 22:00** diễn tập khôi phục vào PostgreSQL tạm trên máy; chạy bù khi mở máy. Task không cất mật khẩu Windows nên chỉ chạy khi người dùng đã đăng nhập.

- Hằng ngày: dump schema/data, migration ledger và tải **binary của mọi Storage object**, lưu inventory đường dẫn/metadata, bucket private/public/giới hạn loại và kích thước file. Bộ mới dùng đủ **64 ký tự SHA-256** cho từng tệp. Bản cũ dùng 16 ký tự vẫn kiểm tra được nhưng không được báo là full SHA-256.
- CLI được cố định ở phiên bản `supabase@2.120.0`, chạy qua Node trực tiếp thay vì shell/npx tự cập nhật. Tên object là dữ liệu; dấu đặc biệt trong đường dẫn không được diễn giải thành lệnh. Trên Windows, script kiểm đường dẫn tuyệt đối rồi truyền đường dẫn tương đối vì CLI coi `C:` là URL scheme.
- Số hàng nghiệp vụ trong manifest được đếm từ **snapshot data.sql**, để giao dịch phát sinh trong lúc tải ảnh không làm đối chiếu restore sai. Không áp migration/schema change cùng lúc chạy dump.
- Sau khi chụp: kiểm checksum, số lượng object, inventory và giải mã đầy đủ ảnh JPEG/PNG/WebP. File ảnh chỉ có chữ ký đầu đúng nhưng bị cắt đuôi phải thất bại. Nếu tệp lỗi, không chạy SQL restore từ bộ đó.
- Hằng tuần: nạp schema và dữ liệu nghiệp vụ vào PostgreSQL dùng một lần, đối chiếu số hàng và RLS. Không kết nối tới production khi replay. Kết quả và thời lượng ở `backups/verify-<stamp>.json`; kết quả kiểm tệp hằng ngày ở `backups/integrity-<stamp>.json`.
- Trạng thái tổng ở `backups/LATEST.json`, cập nhật qua tệp tạm rồi thay thế. `npm run backup:status` báo bản quá 26 giờ, checksum sai, diễn tập quá 7 ngày/lỗi và bản sao thứ hai thiếu/cũ/hỏng.
- Lịch hằng ngày tiếp tục retention có sẵn 7 ngày/4 tuần/12 tháng; bộ dở dang không tự xóa. Lần nâng cấp này không xóa bộ backup nào. Không chạy retention trên bản sao ngoài máy.

**Phạm vi chứng minh:** replay cục bộ chứng minh DDL/dữ liệu nghiệp vụ và file ảnh; nó dùng Auth/Storage stub nên chưa chứng minh được đăng nhập, session, grants managed hoặc truy cập ảnh trên Supabase. Phải diễn tập trên dự án staging tách biệt và kiểm OWNER/MANAGER/STAFF/ảnh trước khi coi full platform restore đã đạt. Không restore vào production đang hoạt động.

Kiểm tra ngay:

```powershell
npm run backup:status
node scripts/backup-verify.mjs --integrity-only
npm run backup:verify
Get-ScheduledTask -TaskName 'Carem CRM - *'
```

## Bản sao Google Drive ngoài máy

OWNER đã chọn thư mục Drive `1raeU_EIyuAxzLRMcwv8FMn8Bfyth8wEF`. Chưa coi bản sao ngoài máy hoạt động chỉ vì có đường dẫn Drive hoặc tạo được archive trên máy. Tài khoản thực hiện upload cần quyền ghi vào thư mục và lịch upload phải có thông tin xác thực sử dụng được khi chạy không tương tác.

Đường thực thi hiện có là Google Drive for Desktop: sau khi đúng tài khoản đã đồng bộ thư mục này, ghi **đường dẫn thư mục Windows thật** vào `backups/offsite.txt`, tạo tệp `.carem-backup-mirror` trong đúng thư mục đó rồi chạy backup. Script chỉ sao chép vào nơi có marker xác nhận, không xóa bản cũ ở nơi ngoài máy, kiểm lại mọi SHA-256 tại nơi nhận và chỉ cập nhật trạng thái mirror sau khi kiểm xong. Không coi thư mục khác trên cùng máy là bản sao ngoài máy.

Upload một lần qua Drive connector là bản sao bổ sung; nó **không tự trở thành lịch upload hằng ngày**. Nếu Drive Desktop không phù hợp, cần cấu hình tài khoản dịch vụ/refresh token hoặc công cụ đồng bộ được OWNER chọn và hạn chế quyền; không đưa credential vào repository hoặc log. Khi mất quyền mạng/thư mục, giữ nguyên bản local và báo việc cần xử lý.

Để chuẩn bị một bộ đầy đủ cho upload riêng tư, chạy `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-export.ps1`. Script kiểm lại checksum/inventory/ảnh trước khi tạo ZIP với tên dễ đọc như `backups/Cà Rem - Sao lưu dữ liệu và ảnh xe - 09-10-2026 lúc 23h58m48s.zip`, trả kích thước và SHA-256 của archive. Tạo ZIP không đồng nghĩa đã upload; chỉ ghi đã có bản ngoài máy sau khi kiểm tra tệp tồn tại trong đúng thư mục Drive của OWNER. Đường dẫn Drive được ghi riêng ở `backups/cloud-target.json`; không chứa token và không kích hoạt upload tự động.

Các tệp trong ZIP có tên tiếng Việt: cấu trúc cơ sở dữ liệu, dữ liệu cửa hàng, lịch sử cập nhật, danh mục ảnh và hướng dẫn. Ảnh được chia thành `Ảnh xe/Xe 001/Ảnh 01.jpg` và `Ảnh giấy tờ/Hồ sơ 001/Ảnh 01.jpg`; tên mới dùng để đọc và tìm ảnh trong archive. `06 - Bảng đối chiếu tên tệp và mã kiểm tra.json` ghi đường dẫn gốc, đường dẫn trong ZIP, kích thước và SHA-256. Khi khôi phục, dựng lại tên và đường dẫn gốc theo bảng này rồi kiểm bản sao; ảnh Storage phải tải lên đúng bucket và tên object gốc, không dùng tên đánh số trong ZIP. Nội dung SQL, ảnh, inventory và manifest gốc giữ nguyên byte; bộ sao lưu tự động trên máy vẫn dùng tên kỹ thuật để kiểm tra và giữ lịch sử. Mở `ĐỌC TRƯỚC - Hướng dẫn bản sao lưu.txt` trước khi khôi phục.

Database dumps chứa CCCD/dữ liệu khách và password hashes. Hạn chế quyền OWNER/quản trị, không chia sẻ thư mục công khai, không commit backups, không dùng bản thật để demo. Bảo vệ máy/tài khoản Drive; mã hóa ổ/thiết bị sao lưu theo cấu hình cửa hàng.
