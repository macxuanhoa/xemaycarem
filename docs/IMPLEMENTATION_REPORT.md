# Báo cáo triển khai Xe CRM — 30/09/2026

Phạm vi gồm cải thiện quy trình vận hành, bảo mật và UX trên worktree hiện có. Worktree đã có nhiều thay đổi chưa commit trước khi phần việc này hoàn tất; danh sách đường dẫn dưới đây là các phần liên quan trong kết quả cuối, không giả định toàn bộ đều được tạo mới trong lượt này.

## 1. Kiến trúc hiện có

Ứng dụng là SPA React 19 + TypeScript + Vite, có PWA và React Router. TanStack Query quản lý dữ liệu. Supabase Auth cấp danh tính; PostgreSQL, RPC, RLS và Storage giữ quy tắc nghiệp vụ. Giao dịch chính được ghi qua RPC PostgreSQL nguyên tử. Edge Functions dùng cho thao tác quản trị và trợ lý AI.

## 2. Quy ước giữ lại

Giữ luồng Thu vào → Tồn kho → Chi phí/cập nhật → Bán ra; tái sử dụng RPC và bảng hiện có; phân quyền OWNER/MANAGER/STAFF ở server; ngày nghiệp vụ Asia/Ho_Chi_Minh; trạng thái bán/thu chỉ báo thành công sau phản hồi server; giao diện dùng card, form, modal, navigation hiện có. Bản nháp cục bộ khôi phục đầy đủ nội dung nghiệp vụ của biểu mẫu (giá, thông tin liên hệ, ghi chú); không giữ trạng thái, số CCCD hay thông tin xác thực.

## 3. Tính năng đã triển khai

- Trang công nợ lọc theo trạng thái/kỳ, tra cứu, mở giao dịch và thu tiền qua luồng ghi khoản thanh toán hiện có. Gửi lại cùng một yêu cầu sau mất phản hồi dùng cùng UUID nên không tạo khoản thu thứ hai.
- Đối soát theo ngày tách doanh thu bán xe khỏi tiền thực thu trong ngày, phân biệt thu từ giao dịch mới và nợ cũ, hiển thị chi phí xe/cửa hàng. “Dòng tiền ròng” được định nghĩa rõ là tiền khách trả trừ chi phí đã ghi nhận; không bao gồm dòng chi mua xe hay thanh toán chi phí chưa được hệ thống ghi riêng.
- Dashboard có liên kết tới công nợ quá hạn, xe tồn lâu và xe chưa rõ giá vốn, cùng lọc kho tương ứng.
- Danh sách khách hàng/lịch sử nhóm theo số điện thoại chuẩn hóa. Số điện thoại dùng chung giữa nhiều tên có cảnh báo và vẫn giữ danh sách tên; không gộp theo tên.
- Tìm toàn hệ thống có debounce thật, phím tắt Ctrl/Cmd+K, điều hướng bàn phím, kết quả theo vai trò và mục vừa mở theo tài khoản.
- Nhập danh sách từ CSV UTF-8: mẫu tải xuống, kiểm tra cú pháp/giá/ngày/enum và trùng lặp phía trình duyệt lẫn server, xem trước theo dòng, nhập phần hợp lệ với xác nhận rõ số dòng bị bỏ qua; giao dịch nhập kho dùng acquisition hiện có và rollback nguyên tử.
- QR dùng thư viện QR thật, chứa mã/đường dẫn cùng origin, yêu cầu đăng nhập như route xe, tải SVG và in nhãn. Trang chụp hỗ trợ camera QR và tìm tay khi không cấp quyền camera.
- Phiếu bán/phiếu thu có danh sách trường cho khách hàng, không lộ giá vốn/lợi nhuận/ghi chú nội bộ; PDF A4 được kiểm tra chỉ một trang.
- Thu xe, bán xe, chi phí nhanh, chi tiết xe và kho được nối với gợi ý từ dữ liệu cửa hàng, chips, nhập tiền VND kiểm tra nghiêm, bản nháp an toàn, xe gần đây theo tài khoản, thao tác mobile và ảnh nén/xem trước/thử lại.
- Trợ lý ảnh/lời nói/câu hỏi có trang UI và Edge Function theo schema giới hạn; phải bấm gửi, đồng ý gửi ảnh, xem/sửa bản nháp rồi mới dùng form/RPC hiện có. Truy vấn chỉ đọc dùng RPC cho phép của tài khoản hiện tại.

## 4. Triển khai một phần

- Trợ lý AI sẵn sàng tích hợp nhưng không có khóa provider/model được cấu hình, không gọi dịch vụ AI và chưa deploy Edge Function. OCR/chất lượng đọc chứng từ chưa kiểm chứng bằng ảnh thật.
- Giọng nói dùng Web Speech API của trình duyệt khi có; nhập transcript bằng bàn phím là đường lui. Chưa kiểm tra quyền microphone trên máy thật.
- QR camera và trạng thái từ chối quyền được kiểm tra tự động giả lập. Cần thử thiết bị thật.
- PWA, PDF, camera fallback được kiểm tra tự động trên Chromium; chưa thử các máy in, điện thoại hoặc trình duyệt khác.
- Edge TypeScript được kiểm tra với type cục bộ và khai báo Deno tối thiểu; không thay thế biên dịch Deno/module remote thật.

## 5. Tính năng chủ ý chưa làm

- Không thêm parser XLSX; Excel có thể xuất CSV UTF-8, tránh thêm thư viện và xử lý một định dạng nữa.
- Không thêm bút toán chi mua xe hoặc quyết toán tiền chi phí vì hệ thống hiện không lưu đủ các khoản tiền mặt tương ứng. Báo cáo không suy diễn dữ liệu tài chính chưa có.
- Không thêm lịch hẹn/bảo dưỡng/đặt chỗ mới vì kho hiện tại không có thực thể nghiệp vụ đó.
- Không thêm tự động thực hiện lệnh bằng AI, lưu ảnh giấy tờ nhạy cảm hoặc gửi ảnh/tin nhắn khi mở màn hình.
- Không thêm vuốt/nhấn giữ/đảo ảnh: các hành động thường dùng đã có nút thấy được và không nên gắn nghiệp vụ tiền vào cử chỉ ẩn.

## 6. Các tệp mới liên quan

- migrations 024/025; Edge Function ai-assist và reset-owner; hợp đồng trợ lý AI.
- Trang khách hàng, công nợ, đối soát, nhập CSV, QR/chụp, trợ lý và phiếu in trong src/features.
- Tiện ích debounce, draft, dialog, recent vehicles, suggestions, CSV/QR/money/image.
- Bộ test DB, Edge/security, unit, E2E và script kiểm tra type Edge.

## 7. Các tệp đã chỉnh sửa liên quan

- App/routes, AuthProvider, Login/Change Password, AppLayout, Dashboard, Search palette.
- Trang kho/xe/thu xe/bán/thu tiền/chi phí/báo cáo/người dùng và styles.
- scripts/test-db.mjs, scripts/db-harness.mjs, package/test/build config và docs.

Worktree đã bẩn trước khi triển khai; vui lòng xem diff của workspace để phân biệt thay đổi sẵn có với phần mới.

## 8. Migration

- 20260930002400_operational_integrity.sql sửa RPC vận hành và thêm chỉ mục điện thoại chuẩn hóa.
- 20260930002500_auth_and_financial_visibility.sql siết quyền giá vốn, xác minh đổi mật khẩu thật và sửa quyền xem báo cáo nhân sự.
- 023 là migration tính năng đã có trong worktree. Cả chuỗi 001–025 được replay trên schema thử nghiệm.
- Không có migration nào được áp dụng lên Supabase production trong lượt này.

## 9. Bảng/cột

Không thêm cột vào bảng nghiệp vụ hiện hữu. Thêm bảng private.required_password_changes để lưu dấu vân tay so sánh hash Auth, trạng thái reset đang chờ và thời điểm buộc đổi mật khẩu. Bảng private không đọc được từ anon/authenticated/service_role qua quyền SQL thông thường. Không lưu mật khẩu hoặc trả dấu vân tay cho client.

## 10. RPC thay đổi

024 thay thế/hardens: list_vehicles, list_receivables, list_customers, get_customer_history, global_search, dashboard, get_sale, add_payment, daily_reconciliation, acquire_vehicle, validate_import_vehicles và import_vehicles.

025 thay đổi complete_password_change, thêm require_password_change, thay private.is_user_authorized/check_user_access, đổi view user_performance_summary sang security invoker và xóa hai helper xóa tài khoản không được bảo vệ. Không tạo luồng ghi giao dịch trực tiếp từ trình duyệt.

## 11. RLS/quyền

SELECT trực tiếp acquisitions chỉ dành cho vai trò có quyền tài chính; danh sách vận hành đi qua RPC đã che giá vốn. Mọi thao tác import/acquisition vẫn kiểm vai trò và giá nhập tại server. Quyền thu tiền/chi phí/báo cáo dùng vai trò cũ. check_user_access cho phép màn đổi mật khẩu, trong khi các RPC/table/storage nghiệp vụ yêu cầu tài khoản đã xác thực quyền và không còn cờ buộc đổi. View hiệu suất chỉ đọc cho OWNER và vẫn chịu quyền bảng cơ sở.

## 12. Chỉ mục

Thêm sales_customer_phone_normalized trên biểu thức chuẩn hóa số điện thoại để tra cứu/nhóm khách. Những chỉ mục khác là chỉ mục sẵn có trong schema/migration trước.

## 13. Logic và phụ thuộc được tái sử dụng

Dùng lại sell_vehicle, save_expense, add_payment, get_sale, get_vehicle, acquire_vehicle, list_vehicles, hệ thống permissions/RLS, Supabase Auth, TanStack Query, form hiện có và lưu ảnh hiện có. Giao diện thu tiền không tạo trạng thái công nợ thứ hai.

## 14. Dependencies và lý do

Phần triển khai này không thêm dependency. UI dùng các thư viện QR/camera đã có trong worktree và API trình duyệt hiện có. Không thêm parser XLSX vì CSV UTF-8 đáp ứng đường nhập bảng tính hiện tại.

## 15. Kiểm thử được thêm

DB tests cho tổng công nợ/phân trang, ngày quá hạn, đối soát lịch sử, nhóm khách trùng số, tìm kiếm, masking, import atomic, khóa tiền, retry thanh toán, RLS và reset mật khẩu. E2E kiểm tra thanh toán gửi lại, role, QR, camera fallback, preview CSV, search bàn phím, thao tác mobile, lịch sử kho và PDF. Unit/security tests kiểm tra money, CSV, QR, quyền, trợ lý AI và allowlist phiếu.

## 16. Kết quả kiểm thử

Kết quả lượt cuối:
- ESLint: đạt, 0 lỗi/cảnh báo.
- TypeScript: đạt.
- Vitest: 174 test / 15 file đạt.
- PostgreSQL thật tạm thời: 73 kiểm tra đạt (10 business risk + 25 operational + 9 auth/security + 29 integrity/concurrency); replay 25 migration đạt.
- E2E: 34/34 luồng Chromium đạt, gồm đổi role, QR/camera fallback và PDF đúng một trang.
- Seed: đạt, idempotent; 8 xe thử nghiệm và số liệu dashboard/báo cáo/sort/phân trang khớp.
- Edge TS: 4 tệp đạt với type cục bộ; Deno thật chưa cài/kiểm tra.
- Build production: đạt. Vite cảnh báo chunk camera 737 kB vượt 500 kB; chunk tải tách theo route/chức năng. Có cảnh báo vị trí pure annotation của Zod; build tự bỏ chú thích và thành công.
- PWA: đạt manifest/icons, installability Chromium, service worker, login desktop/mobile và offline shell; không có lỗi runtime browser.

Mọi DB test dùng dữ liệu giả trong cluster dùng một lần. E2E gọi dịch vụ Supabase giả ở ranh giới HTTP và dùng PostgreSQL thử nghiệm cho SQL nghiệp vụ.

## 17. Lỗi được phát hiện

Một số RPC công nợ/khách hàng/tìm kiếm có lỗi CTE/phạm vi alias; khách hàng có thể bị gộp nhầm hoặc hụt payment; payment gửi lại sau mất phản hồi có thể ghi hai lần; import kiểm tra trùng khác nhau giữa client/server; truy cập bảng acquisitions và view hiệu suất có thể làm lộ dữ liệu tài chính; flow đổi mật khẩu chỉ dựa vào cờ profile; reset Edge cũ trả kết quả không an toàn; quay lại kho mất vị trí; phiếu in bị kéo thành nhiều trang.

## 18. Lỗi đã sửa

Sửa CTE/alias và tổng tiền, khóa và idempotency payment, chuẩn hóa/chặn duplicate import ở server, rollback batch, mask/RLS giá nhập, view OWNER-only, so sánh hash trước/sau đổi mật khẩu, khóa reset đang chờ, hủy helper xóa thiếu quyền, fail closed khi kiểm quyền lỗi, xóa cache khi đổi user, trả về route trước đổi mật khẩu, CSS in loại layout thừa.

## 19. Các rủi ro bảo mật được tìm thấy

Acquisition cost bị đọc trực tiếp qua RLS; view hiệu suất expose thông tin ngoài OWNER và có join nhân tổng; helper xóa tài khoản cũ thiếu kiểm quyền; boolean must_change_password có thể bị dùng như bằng chứng thay mật khẩu; retry khoản thu chưa có khóa idempotency; receipt có nguy cơ spread trường nội bộ. Các đường đó đã được che/chặn/kiểm tra ở migration, Edge, form và test.

## 20. Hiệu năng

Search debounce 300 ms; giữ danh sách cũ khi tải filter mới; truy vấn và invalidate theo key liên quan; chỉ prefetch khi hover/focus/touch; camera module tải lười; truy vấn giới hạn và phân trang; chỉ mục điện thoại chuẩn hóa; ảnh nén trước upload; autosave draft debounce 350 ms. Bundle camera là chunk riêng; cần so lại sau build.

## 21. Smoke test thủ công còn cần

1. OWNER và STAFF đăng nhập; thử đổi mật khẩu tạm rồi mở lại QR liên kết xe.
2. Thu một khoản công nợ nhỏ, xem lại lịch sử khách hàng và thử kết nối chập chờn.
3. Đối soát ngày có bán xe, thu nợ cũ, chi phí xe và chi phí cửa hàng.
4. Nhập CSV có một dòng sai và một dòng trùng; xác nhận preview không tự ghi.
5. Quét QR với camera thật, từ chối quyền camera, dùng tìm kiếm tay.
6. Chụp ảnh số khung/biển và xác nhận ảnh nén còn đọc được; thử upload và retry.
7. Xem và in phiếu bán/thu trên máy in thực, kiểm tra đúng 1 trang A4 và không lộ dữ liệu nội bộ.
8. Thử PWA offline, khi có mạng trở lại, trên thiết bị dùng thực tế.
9. Nếu bật AI: cấu hình khóa/model ở server, giới hạn chi phí, rà chính sách lưu giữ, thử OCR/transcript bằng dữ liệu thử, duyệt draft trước khi ghi.

## 22. Cân nhắc trước khi deploy production

Kiểm tra migration ledger của Supabase trước. Chỉ lập kế hoạch chạy migration mới 024/025 theo thứ tự sau khi đối chiếu trạng thái; không replay mù các migration lịch sử 007–021 vốn chứa thao tác Auth cũ. Test backup/restore, RLS, reset Auth và Edge secrets trong project staging. Cần triển khai bản retire cho endpoint reset-owner cũ nếu endpoint đó từng được deploy. Không bật ai-assist cho tới khi provider/key/model, spending limits, retention và quyền gửi ảnh được phê duyệt. Chưa có deployment hoặc secret nào được thực hiện ở lượt này.

## 23. Xác nhận về dữ liệu thật

Không kết nối Supabase production, không sửa tài khoản/credential dữ liệu thật, không deploy Edge Function và không gọi provider AI. Các test DB dùng PostgreSQL tạm và dữ liệu giả; e2e dùng API giả; PWA chạy cục bộ.

## Cây thư mục liên quan

- docs/
  - IMPLEMENTATION_REPORT.md
  - AI_ASSIST_CONTRACT.md
  - AUTH_RECOVERY_AUDIT.md
  - UX_FRICTION_AUDIT.md
  - VERIFICATION.md
- src/
  - features/
    - assistant/
    - auth/
    - capture/
    - customers/
    - sales/
    - vehicles/
    - reports/
  - components/search/
  - layouts/
  - lib/
- supabase/
  - functions/ai-assist/
  - functions/manage-users/
  - functions/reset-owner/
  - migrations/20260930002400_operational_integrity.sql
  - migrations/20260930002500_auth_and_financial_visibility.sql
- tests/
  - db/
  - e2e/
  - security/
  - unit/
- scripts/
  - check-edge-types.mjs
  - test-db.mjs



