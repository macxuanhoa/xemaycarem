# Xe CRM — Quản Lý Cửa Hàng Xe

Ứng dụng nội bộ cho cửa hàng xe, xây dựng bằng React 19, TypeScript, Vite, Tailwind CSS, thành phần theo cấu trúc shadcn/ui, React Router, React Hook Form, Zod, TanStack Query và Supabase. Responsive trên máy tính/điện thoại, có manifest và service worker PWA.

**Không có dữ liệu kinh doanh giả trong ứng dụng.** Khi chưa cấu hình Supabase, màn hình đăng nhập báo chưa kết nối và không cho ghi dữ liệu. Dữ liệu mẫu chỉ nằm trong seed phát triển, không tự chạy lên production.

## Cài đặt nhanh

Yêu cầu Node.js 22.16+ (xem `.node-version`) và npm. Từ thư mục dự án:

```powershell
npm ci
Copy-Item .env.example .env.local
# Điền URL và publishable/anon key của dự án Supabase vào .env.local.
npm run dev
```

Mở `http://127.0.0.1:5173`. Chưa có Supabase vẫn có thể chạy build, unit test và kiểm thử PostgreSQL cục bộ; đăng nhập thực tế cần backend đã cấu hình.

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY
VITE_ENABLE_PASSWORD_RESET=false
```

Mọi biến `VITE_*` được đưa vào trình duyệt. **Không bao giờ dùng service_role/secret key trong biến VITE.** `.env.local` được gitignore.

## Thiết lập Supabase

1. Tạo dự án Supabase riêng cho cửa hàng. Giữ riêng môi trường phát triển và production.
2. Trong Authentication, **tắt Allow new users to sign up**, tắt anonymous sign-in. Không có đăng ký công khai trong giao diện. `supabase/config.toml` cũng tắt signup cho Supabase local; cấu hình này không tự thay đổi dự án hosted.
3. Cài/chạy Supabase CLI qua `npx supabase`, đăng nhập tài khoản của bạn và liên kết dự án:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Migration có thứ tự trong `supabase/migrations/`, bao gồm schema, constraints, indexes, RLS, RPC, audit và private Storage bucket. Không cần tạo bảng thủ công. Không chạy `db reset` trên production.

4. Trong Auth URL Configuration, đặt Site URL bằng địa chỉ HTTPS của ứng dụng. Cho phép redirect chính xác `https://YOUR_APP/reset-password`; thêm `http://127.0.0.1:5173/reset-password` chỉ ở môi trường phát triển. Cấu hình SMTP trước khi bật chức năng quên mật khẩu; đặt `VITE_ENABLE_PASSWORD_RESET=true` rồi build lại.
5. Tạo **tài khoản OWNER đầu tiên** bằng Supabase Dashboard → Authentication → Users → Add user, dùng email của chủ cửa hàng và mật khẩu mạnh. Không chọn gửi lời mời nếu bạn chưa muốn gửi email. Trigger mặc định tạo profile STAFF, không tin role trong user metadata. Trong SQL Editor tin cậy, thay UUID rồi chạy:

```sql
update public.profiles
set full_name = 'Chủ cửa hàng', role = 'OWNER', active = true,
    can_view_financials = true
where id = 'UUID_TAI_KHOAN_VUA_TAO';
```

6. Triển khai chức năng tạo tài khoản nhân viên. Function này chỉ chạy phía server, kiểm tra OWNER còn hoạt động và dùng Auth Admin API. Secret service-role mặc định do Supabase cung cấp cho Edge runtime, không đưa vào frontend:

```powershell
npx supabase secrets set ALLOWED_ORIGINS=https://YOUR_APP,http://127.0.0.1:5173
npx supabase functions deploy manage-users
```

Function chỉ **tạo tài khoản bằng mật khẩu**, không tự gửi email. Nhân viên đổi mật khẩu trong Cài đặt sau khi được cấp tài khoản. Đảm bảo `verify_jwt=true`. Nếu dự án dùng khóa publishable mới với JWT signing keys khác, kiểm tra tương thích gateway Edge và chạy thử flow thực tế trước khi bàn giao.

7. Điền public config frontend, khởi động lại Vite, đăng nhập OWNER, vào Nhân sự để tạo từng tài khoản riêng.

## Kiến trúc và tính toàn vẹn

```text
React PWA → Supabase Auth → PostgreSQL RPC + RLS
                            ├─ vehicles + vehicle_financials
                            ├─ vehicle_expenses / business_expenses
                            ├─ sales + sale_financials + payments
                            ├─ profiles / system_settings
                            ├─ audit_logs / vehicle_activity
                            └─ private Supabase Storage
```

- `vehicles` chỉ chứa dữ liệu vận hành. Giá mua nằm ở `vehicle_financials`; snapshot lợi nhuận nằm ở `sale_financials`. RLS chặn dữ liệu nhạy cảm ngay cả khi gọi bảng trực tiếp. Các RPC bỏ các trường nhạy cảm khỏi JSON của người không đủ quyền.
- Browser role không được INSERT/UPDATE/DELETE trực tiếp các bảng nghiệp vụ. RPC `SECURITY DEFINER` có `search_path=''`, kiểm tra `auth.uid()`, active và quyền; không dùng role do client tự truyền.
- Tiền là số nguyên VND, PostgreSQL BIGINT, một khoản tối đa 1.000.000.000.000 ₫. Tổng được kiểm tra trong giới hạn số nguyên an toàn của JavaScript, không làm tròn sai âm thầm.
- `sell_vehicle` khóa xe, kiểm tra trạng thái, tính và chốt giá mua/chi phí, tạo sale/thanh toán, chuyển SOLD và ghi audit trong một transaction. Partial unique index bảo đảm tối đa một sale COMPLETED trên mỗi xe.
- Sửa chi phí và giá mua cùng khóa hàng xe với thao tác bán. Thu thêm tiền khóa sale và ngăn vượt số còn phải thu. Không tự retry mutation khi lỗi mạng.
- Xe do nhân viên nhập chưa có giá mua được đánh dấu `cost_pending`; chủ cửa hàng/quản lý được cấp quyền phải bổ sung trước khi bán. Tổng vốn tồn kho hiện `—` nếu còn xe chưa xác nhận giá mua.
- Giá vốn = giá mua + chi phí xe ACTIVE. Lợi nhuận gộp = giá bán − snapshot giá vốn. Chi phí cửa hàng được báo riêng, không cộng vào giá vốn xe.
- Hủy sale giữ lịch sử, vô hiệu khoản thu (`VOIDED`), đưa xe về IN_STOCK; hoàn tiền ngân hàng/tiền mặt thực tế cần đối chiếu bên ngoài hệ thống.
- Ngày nghiệp vụ dùng `Asia/Ho_Chi_Minh`. Trang tồn kho hiển thị tồn kho **hiện tại**, có lọc ngày nhập, không phải tái dựng số dư lịch sử.
- Ảnh lưu trong bucket private, đường dẫn theo UUID xe; trình duyệt dùng signed URL ngắn hạn. Gỡ ảnh soft-delete metadata, không hard-delete lịch sử.

Chi tiết hợp đồng API: [supabase/API.md](supabase/API.md). Mô hình bảo mật: [supabase/SECURITY.md](supabase/SECURITY.md).

## Vai trò

| Vai trò | Quyền chính |
|---|---|
| OWNER | Toàn bộ nghiệp vụ, giá mua/lợi nhuận, nhân sự, audit, cài đặt |
| MANAGER | Nhập/sửa/bán xe, thu tiền, chi phí, doanh thu; giá mua và lợi nhuận cần `can_view_financials` |
| STAFF | Xem kho, nhập/cập nhật thông tin vận hành, bán xe đủ giá vốn, ghi nhận thanh toán; không quản trị/chi phí nhạy cảm |

Tài khoản `active=false` bị từ chối tại database dù session Auth còn tồn tại. Frontend làm mới quyền định kỳ và khi quay lại cửa sổ. Không cho vô hiệu hóa hoặc hạ vai trò OWNER hoạt động cuối cùng.

## Màn hình và thao tác

- Đăng nhập, duy trì phiên theo lựa chọn; đăng xuất; đổi mật khẩu; khôi phục mật khẩu khi đã cấu hình.
- Tổng quan: tồn kho, giữ chỗ, bán hôm nay/tháng này, doanh thu/lợi nhuận theo quyền, vốn tồn, tuổi tồn, xe mới/xe lợi nhuận cao.
- Kho xe: tìm mã xe/biển số/hãng/dòng/số khung/số máy/SĐT khách; lọc trạng thái/hãng/năm/giá/ngày; phân trang/sắp xếp; nhập/sửa/chi tiết/ảnh/lịch sử.
- Bán hàng: bán xe trong một biểu mẫu, trả nhiều lần, chi tiết giao dịch và hủy có lý do.
- Chi phí xe và cửa hàng: thêm, sửa, hủy có lịch sử.
- Nhân sự, audit trước/sau thay đổi, hồ sơ và cài đặt cửa hàng.
- Trợ lý AI (`/copilot`) hỏi đáp có bằng chứng bấm được, và tài liệu cửa hàng (`/docs`) xem ngay trong app.

## Trợ lý AI và tài liệu cửa hàng

Sidebar có mục **TRỢ LÝ AI**, hiện với tài khoản vận hành được (STAFF còn active trở lên):

- **Hỏi AI Cà Rem** (`/copilot`): hỏi tự nhiên về cửa hàng. Server tra cứu bằng đúng JWT/RLS của người đang đăng nhập — số nghiệp vụ qua các RPC đọc đã có (`dashboard`, `list_vehicles`, `list_receivables`, `list_expenses`, `list_audit`, `list_profiles`, `get_settings`) và tài liệu qua `search_knowledge`. Mỗi con số, mỗi đoạn tài liệu đi kèm một mã bằng chứng (`[m2]`, `[d1]`); bấm vào là mở đúng màn hình chứa bằng chứng đó. Chế độ này chỉ đọc: không tạo, không sửa, không lưu giao dịch nào.
- Mặc định là **tra cứu chắc chắn** (deterministic): câu trả lời chỉ gồm số đã kiểm chứng, chạy được kể cả khi chưa cấu hình nhà cung cấp AI.
- Chủ cửa hàng bật thêm **“Bật AI viết câu tóm tắt”** (`mode: 'llm'`). AI chỉ được diễn đạt lại đúng bằng chứng đã truy xuất; trích dẫn không khớp, số bịa hoặc link ra ngoài bị loại và tự động rơi về kết quả tra cứu kèm cảnh báo. Tài khoản không phải OWNER bật sẽ nhận `LLM_MODE_OWNER_ONLY`.
- **Tài liệu cửa hàng** (`/docs`): toàn bộ markdown của dự án được tách theo mục `##` và xem trong app, chỉ hiện phần đúng quyền người đọc (ALL/STAFF/MANAGER/OWNER).

Không có MCP hay “tool tùy tiện” trong ứng dụng: tool của copilot đúng là danh sách RPC đọc mà database đã kiểm tra quyền. Tài liệu cho copilot lấy từ bảng `public.knowledge_base`, sinh tự động từ markdown trong repo — sửa file `.md` rồi chạy `npm run knowledge:seed` (xem [docs/OPERATIONS.md](docs/OPERATIONS.md)). Hợp đồng chi tiết: [docs/AI_ASSIST_CONTRACT.md](docs/AI_ASSIST_CONTRACT.md).

## Kiểm thử

```powershell
npm run lint
npm run typecheck
npm run test
npm run test:db
npm run knowledge:check
node supabase/tests/seed-smoke.mjs
npm run build
```

`knowledge:check` (đã nằm trong `npm run check`) báo lỗi khi tài liệu `.md` đã sửa mà migration seed chưa sinh lại; khi đó chạy `npm run knowledge:seed`.

`test:db` tạo một PostgreSQL thật tạm thời bằng `embedded-postgres` trên loopback/cổng ngẫu nhiên, chạy tất cả migration và dọn cluster riêng sau khi kết thúc. Không sử dụng hoặc thay đổi database production. Có kiểm thử nhiều kết nối đồng thời, RLS, tài chính, audit, thanh toán, hủy bán, quyền OWNER cuối cùng. Môi trường không chạy được binary có thể dùng `node scripts/test-db.mjs --pglite`; bản này không kiểm chứng concurrency nhiều kết nối.

Kiểm thử giao diện:

```powershell
npx playwright install chromium
npm run test:e2e
```

E2E dùng cấu hình riêng trong `playwright.config.ts`, PostgreSQL thử nghiệm thật và mô phỏng biên HTTP của Supabase Auth/REST. Test session không dùng trong bản build production. Hosted Auth, SMTP, Edge Function và Storage cần kiểm tra lần cuối trên dự án Supabase thực; kiểm thử cục bộ không thay thế việc này.

Kiểm tra PWA sau build: chạy `npm run preview -- --port 4173 --strictPort`, rồi ở terminal khác chạy `npm run test:pwa`. Kết quả kiểm chứng và giới hạn được ghi trong [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Dữ liệu phát triển và types

`supabase/seed.sql` có 8 xe hư cấu, chi phí và vài giao dịch. Seed chỉ hoạt động khi có OWNER hoạt động, có thể chạy lại mà không nhân đôi. Chỉ chạy trên database phát triển. `supabase db reset` dùng được trên Supabase local khi chấp nhận xóa database local.

`src/types/index.ts` chứa DTO trả về theo quyền. Sau khi có Supabase CLI/local stack, tạo thêm types bảng bằng `npm run db:types` (lệnh yêu cầu CLI đã cài) hoặc `npx supabase gen types typescript --project-id YOUR_PROJECT_REF`; không dùng bảng financial trực tiếp thay RPC cho write.

## Build và hosting

```powershell
npm run build
npm run preview
```

Cloudflare Pages: build command `npm run build`, output `dist`, Node 22.16+ (`.node-version`), đặt `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, tùy chọn reset trong build environment. Không cần Node backend. `_redirects` hỗ trợ SPA routes; `_headers` có CSP và các header cơ bản. Nếu dùng Supabase custom domain, cập nhật `connect-src`/`img-src` tương ứng. Chỉ upload `dist`, không upload `.env`, source test hoặc server secret.

Sau khi có tên miền HTTPS: cập nhật Auth URL và `ALLOWED_ORIGINS`; kiểm tra đăng nhập, nhập xe, ảnh, bán/thu tiền, phân quyền trên điện thoại. Bản build hiện tại không được coi là production đã kết nối khi chưa có cấu hình cloud.

## PWA và ngoại tuyến

Tên cài đặt: **Quản Lý Cửa Hàng Xe**; tên ngắn **Xe CRM**. Chrome/Edge: biểu tượng cài ứng dụng; Android: Cài đặt ứng dụng; iPhone Safari: Chia sẻ → Thêm vào màn hình chính. HTTPS hoặc localhost là điều kiện cho service worker. Có thể ghim ứng dụng Windows sau khi cài.

Service worker chỉ cache application shell và tài nguyên tĩnh. Không cache Supabase responses/ảnh riêng tư hoặc xếp hàng financial mutation. Mất mạng không báo thành công giả. Nếu kết nối mất sau khi server nhận yêu cầu, tải lại danh sách trước khi gửi lại, tránh ghi trùng khoản chi/thanh toán.

## Sao lưu và vận hành

Xem [docs/OPERATIONS.md](docs/OPERATIONS.md) để thiết lập backup Supabase, dump định kỳ ra ngoài, sao lưu Storage, khôi phục và kiểm tra sau restore. CSV chỉ là báo cáo, không thay bản sao lưu đầy đủ.
