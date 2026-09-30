# Kết quả kiểm chứng — 30/09/2026

## Kết quả trên worktree hiện tại

| Kiểm tra | Kết quả |
|---|---|
| npm run lint | Đạt; ESLint không báo lỗi/cảnh báo |
| npm run typecheck | Đạt |
| npm test -- --reporter=dot | 174 test trên 15 file đạt |
| npm run test:db | Đạt: 10 business risk + 25 operational + 9 auth/security + 29 integrity/concurrency = 73 kiểm tra; replay 25 migration đạt |
| npm run test:e2e -- --reporter=line | 34/34 luồng Chromium đạt |
| npm run test:seed | Đạt; seed lặp không nhân dữ liệu, dashboard/báo cáo/sort/phân trang đúng |
| node scripts/check-edge-types.mjs | Đạt cho 4 tệp Edge với type cục bộ |
| npm run build | Đạt; kiểm tra lại 30/09/2026 |
| npm run test:pwa | Đạt: manifest/icons, installability Chromium, service worker, login desktop/mobile, offline shell; không có lỗi runtime |

## Phạm vi các kiểm tra quan trọng

- DB suite chạy toàn bộ 25 migration trên PostgreSQL tạm; tạo schema Auth/Storage tối thiểu, dùng dữ liệu giả và kiểm quyền/RLS bằng các role PostgreSQL thật.
- Concurrency tests dùng kết nối PostgreSQL riêng, kiểm tra cạnh tranh bán xe, thu tiền, chi phí và OWNER. PGlite chỉ dùng cho seed/local smoke, không giả lập concurrency.
- E2E dùng PostgreSQL tạm cho nghiệp vụ SQL và mock Supabase HTTP/Auth ở trình duyệt. Các flow gồm thanh toán gửi lại cùng request ID, lọc/thu công nợ, customer history, đối soát, import có dòng trùng, QR, camera bị từ chối, search debounce/keyboard, bảo toàn bộ lọc kho, kiểm tra vai trò và in PDF một trang.
- Phiếu thu được kiểm tra không lộ giá vốn, lợi nhuận, ghi chú nội bộ; PDF Chromium có đúng một trang A4.
- Type Edge không xác nhận Deno runtime/module resolution hoặc Edge deployment.

## Bundle local và cảnh báo

- Build mới sinh entry JavaScript tải ban đầu 736.97 kB (220.67 kB gzip), vượt ngưỡng cảnh báo Vite 500 kB. Đây là entry ứng dụng, không phải riêng camera; hiệu năng production chưa đo.
- Route Capture là chunk động 3.62 kB. `html5-qrcode` nằm trong chunk riêng 375.14 kB (110.56 kB gzip), chỉ được import sau khi người dùng bấm mở quét camera. Thư viện camera không nằm trong JavaScript tải ban đầu.
- Zod phát hai cảnh báo vị trí pure annotation trong mã thư viện; Rollup bỏ annotation và build hoàn tất.

## Giới hạn và cảnh báo

- Không có Supabase CLI hoặc `SUPABASE_ACCESS_TOKEN` trong môi trường này. Production project identity, migration ledger, backup/PITR, schema/RLS, Auth hosted, Edge status và production smoke tests chưa xác minh.
- Build/test không kết nối Supabase production, không thay đổi tài khoản thật, Auth credentials, Edge deployments hay dữ liệu thật.
- Không có khóa/provider AI cấu hình. Camera, OCR, microphone, upload Storage HTTP, máy in thật, và cài PWA trên điện thoại cần kiểm tra thủ công.
- Migration 018 chứa mật khẩu OWNER mặc định dạng cứng và ghi giá trị đó vào notice. File được giữ lại trong worktree nhưng loại khỏi checkpoint Git; không được áp dụng.

Xem `docs/PRODUCTION_RELEASE.md` để biết bảng migration, trạng thái production và bước tiếp theo an toàn. Xem `docs/IMPLEMENTATION_REPORT.md` để biết phạm vi tính năng và giới hạn kiểm thử.
