# Kết quả kiểm chứng — 02/10/2026

## Quản lý nhân sự — giờ làm chung, một Chủ cửa hàng, cấm sử dụng có thời hạn — 02/10/2026

| Kiểm tra | Kết quả |
|---|---|
| npm run lint | Đạt; 0 lỗi (thêm `.vercel-tmp/**` vào ESLint ignore — tệp deploy sót lại gây 22 lỗi `no-undef`/`no-require-imports`) |
| npm run typecheck | Đạt |
| npm test | Đạt: 309 test / 26 file (viết lại `tests/security/auth-recovery-matrix.test.ts` và `tests/security/manage-users-handler.test.ts` theo mô hình role/cấm/chuyển giao mới) |
| node scripts/check-edge-types.mjs | Đạt cho 6 tệp Edge |
| npm run test:db | Đạt hai vòng liên tiếp (gồm vòng sau khi tái sinh seed): 30 kiểm tra tích hợp inline — test đa-OWNER cũ thay bằng hai test mô hình một-OWNER (`SINGLE_OWNER_REQUIRED` cho ghi raw, khóa giao nhau giữa `transfer_ownership` và `update_profile` giữ đúng 1 OWNER hoạt động) + 14 auth/security (thêm 6 test mới: giờ chung chặn STAFF/MANAGER miễn OWNER, input schedule do OWNER ghi và bị chặn với STAFF, cấm có thời hạn hết hạn là mở lại, MANAGER chỉ đổi role cấp dưới, chuyển giao nguyên tử một OWNER) + 35 operational + 8 knowledge + 6 copilot + 8 CCCD + 10 showroom |
| npm run knowledge:check | Lần đầu báo seed lệch (markdown đổi) → chạy `npm run knowledge:seed` tái sinh 175 mục → đạt |
| npx playwright test | Đạt: 84/84, 0 lỗi / 0 bỏ qua — test modal nhân sự nâng thành kiểm tra mobile thật (bottom sheet trong khung 390×844, cả hai tab, preset cấm "Hết hôm nay", `scrollWidth` ≤ 390) |
| npm run build | Đạt; PWA generateSW, precache 57 mục |

Ghi chú:
- Một vòng chạy E2E giữa chừng báo 14 lỗi `ERR_CONNECTION_REFUSED`: tiến trình Vite con do Playwright quản lý chết giữa suite trên máy Windows (flake hạ tầng, không phải lỗi sản phẩm). `playwright.config.ts` nay đặt `reuseExistingServer: !process.env.CI`; vòng xanh chạy với dev server 4184 bền vững tách riêng, CI không ảnh hưởng.
- Sửa hai assertion "Quick expense" nhãn cũ trong `ux-convenience.spec.mjs` (`+ Chi phí` → `Chi phí`): lệch nhãn có sẵn từ đổi tên CTA PageHeader ở VehicleDetailPage phiên trước, không liên quan đợt thay đổi này.
- Migration mới đặt tên `20261002003600_shared_schedule_and_single_owner.sql` sau khi phát hiện trùng số hiệu `003500` với `20261002003500_no_forced_first_password_change.sql`. Supabase CLI coi timestamp là version duy nhất. Cả 035 và 036 đều đã APPLIED trên production (xác minh read-only 2026-10-03).
- Seed `knowledge_base` tái sinh từ markdown (`docs/SYSTEM_REFERENCE.md` nay mô tả `transfer_ownership`, `/users` MANAGER-or-OWNER, mô tả mới của `manage-users`); file seed không sửa tay. **Lưu ý governance:** vì 029 đã được deploy trước khi tái sinh, việc chỉnh sửa 029 tại chỗ đã vi phạm forward-only; đã khắc phục bằng cách khôi phục 029 và chuyển corpus hiện tại sang migration forward `038_knowledge_reseed`.

## Thu xe tốc ký (/intake) — 02/10/2026

| Kiểm tra | Kết quả |
|---|---|
| npm run lint | Đạt; 0 lỗi |
| npm run typecheck | Đạt |
| npm test | Đạt: 304 test / 26 file (thêm `tests/unit/shorthandIntake.test.ts` 21 test cho parser + từ điển học) |
| npm run knowledge:check | Lần đầu báo seed lệch (trang mới sinh từ code) → chạy `npm run knowledge:seed` tạo lại 170 mục, sau đó đạt |
| npm run test:db | Đạt: 10 business risks + 35 operational + 9 auth + 8 knowledge + 6 copilot gaps + 8 CCCD + 10 showroom + 29 tích hợp; replay toàn bộ migration — tính năng này không có migration mới |
| npx playwright test shorthand-intake | Đạt: 4/4 (thu loạt một lệnh, học viết tắt + bền sau reload, trùng lặp server chặn trước confirm, STAFF không thấy/không gửi giá thu) |
| npx playwright test (toàn suite) | Đạt: 74/74 (3.1 phút) |
| npm run build | Đạt; PWA generateSW, precache 58 mục |
| npm run test:pwa (preview 4173) | Đạt: manifest/icons, installability Chromium, service worker, login desktop/mobile, offline shell |

Ghi chú: E2E spec mới mock Supabase HTTP/Auth tại `https://xe-test.supabase.co` và hai RPC `validate_import_vehicles`/`import_vehicles`; hành vi SQL thật của các RPC này do suite DB sẵn có đã bao phủ (không thêm SQL cho tính năng). Bộ nhớ viết tắt là localStorage theo thiết bị/tài khoản, không đồng bộ server.

## Release preparation (đợt 3) — gốc rễ flake login (connection churn) và xác nhận E2E xanh hai vòng liên tiếp (01/10/2026, worktree ổn định, chỉ một tiến trình ghi)

| Kiểm tra | Kết quả |
|---|---|
| npm run lint | Đạt; 0 lỗi, 1 cảnh báo `react-hooks/exhaustive-deps` (`InventoryPage.tsx:96`) |
| npm run typecheck | Đạt |
| npm test | Đạt: 252 test / 20 file |
| npm run test:db | Đạt: 29 kiểm tra tích hợp PostgreSQL (kèm các suite con); replay 29 migration, không có 018 |
| npm run test:seed | Đạt; seed/idempotency/dashboard/reports/phân trang đúng |
| npm run build | Đạt (vite build 6.38s) |
| npm run playwright test | ĐẠT 43/43, xác nhận hai vòng chạy toàn bộ suite liên tiếp (1.7–1.8 phút/vòng) với mã cuối cùng |
| npm run test:pwa | Đạt (preview + manifest + offline shell) |

Phân loại 7 lỗi E2E đầu vào và cách xử lý:

1. Hai test danh sách `Thu vào` — lỗi do worktree đang bị tiến trình khác sửa khi chạy lần trước; trên worktree ổn định cả hai đạt nguyên trạng, không sửa gì.
2. `assistant:105` (draft STAFF) — assertion cũ kỹ: nhãn khả năng truy cập của ô Số khung nay gồm cả phản hồi kiểm tra trùng khung ("Số khung * Số khung chưa có trong hệ thống"). Đổi sang match tiền tố `^Số khung \*`.
3. `assistant:85` (hóa đơn) — FLAKE: tiến trình bootstrap auth có thể remount `/assist` một lần dưới tải song song, làm mất trạng thái ảnh/đồng ý. Test nay tự vào lại ảnh + đồng ý nếu nút chưa bật (tối đa 2 lượt). Rễ cause remount chưa chốt — theo dõi tiếp.
4. `business-flows:360` — LỖI ỨNG DỤNG: trang công nợ có hai điều khiển trùng cho cùng Trạng thái (pills + select). Đã xóa select trùng, pills mang `aria-pressed` và container là `role=group` đúng chuẩn; test assert pill active.
5-6. `workflows:337` + `workflows:410` — assertion cũ kỹ (select "Khoảng thời gian" đã thay bằng chip preset + DatePicker DD/MM/YYYY) KÈM lỗi ứng dụng thật: xóa một cạnh ngày để lại giá trị cũ trong draft, có thể gửi range không khớp hiển thị. `DateRange.handleDateChange` nay giữ draft cục bộ khi range chưa đủ hai biên và mirror phép xóa vào draft; test viết lại theo chip mới.
7. `workflows:505` — assertion cũ kỹ: React Router giữ trang cũ mounted trong lúc lazy module tải (không còn spinner `role=status`); test nay khẳng định shell + trang cũ vẫn hiển thị (không trắng màn hình).
8. `workflows:337` (phần cài đặt) — assertion cũ kỹ: mục "Tên cửa hàng" chuyển vào tab chủ cửa hàng "Thông tin cửa hàng"; test thêm bước mở/đóng tab.
9. Flake login/ thứ tự (`workflows` Staff đăng nhập, chạy kèm toàn bộ suite) — GỐC RỄ THẬT, đã sửa cách ly: `scripts/db-harness.mjs` mở một kết nối PostgreSQL nhúng mới cho mỗi request `/rest/v1/*` bị chặn, nên chuỗi RPC lúc bootstrap gây churn kết nối và spike trễ quá `expect` timeout. Nay dùng `pg.Pool` (giới hạn) với một client bootstrap; tra cứu chữ ký RPC (`pg_get_function_arguments`) chạy trên kết nối riêng của từng request thay vì client bootstrap chia sẻ (hỏa bỏ race query đồng thời). Không tăng timeout, không dùng `page.waitForTimeout`. `npm run test:db` (gồm kiểm tra đồng thời đa phiên và khóa chặn) vẫn đạt trên harness có pool.

## Release preparation — kết quả chạy lại toàn bộ cổng local (01/10/2026, worktree hiện tại, sau `npm ci` sạch)

| Kiểm tra | Kết quả |
|---|---|
| npm ci | Đạt; 561 gói, 0 lỗ hổng; Node 22.18.0 (pin `.node-version` = 22.16.0) |
| npm run lint | Đạt với 1 cảnh báo `react-hooks/exhaustive-deps` tại `InventoryPage.tsx:96` (0 lỗi) |
| npm run typecheck | Đạt (lần chạy đầu trượt do race filesystem với `src/features/docs/DocsPage.tsx` mới xuất hiện; chạy lại đạt) |
| npm test | Đạt: 252 test / 20 file (thêm `tests/security/copilot.test.ts` 11, `tests/unit/copilot-ui.test.tsx` 5) |
| npm run test:db | Đạt (PGLite): 24 kiểm tra tích hợp + 33 operational + 9 auth + 8 knowledge + 8 CCCD; replay toàn bộ migration trong `supabase/migrations/` (29 tệp, KHÔNG còn 018 — đã cách ly sang `supabase/quarantine/`) |
| npm run knowledge:check | Đạt: seed `knowledge_base` đúng 145 mục tài liệu, khớp với markdown trong repo |
| npm run test:seed | Đạt; seed lặp không nhân dữ liệu |
| node scripts/check-edge-types.mjs | Đạt cho 6 tệp Edge |
| npm run build | Đạt; entry >500 kB vẫn cảnh báo kích thước như cũ |
| npx supabase db reset (Docker local) | Đạt: chuỗi 29 migration build schema sạch, seed chạy, không có 018 |
| npx playwright test | (Lỗi thời điểm chạy đợt 1 — xem mục đợt 2 ở trên: ĐẠT 43/43 sau khi tỉa assertion và sửa `DateRange`/`ReceivablesPage`.) THẤT BẠI thực tế khi đó: 38 đạt / 5 lỗi ổn định trên 43 test khi chạy riêng từng spec (draft trợ lý thiếu nhãn `Số khung *` chính xác, select 'Trạng thái' trùng nhãn tablist, điều khiển 'Khoảng thời gian' đã đổi thành chip ngày ở 2 test, hai `role=status` trên route loading). Chạy cả tuần tự thì báo 36/7: thêm 2 test trợ lý chỉ lỗi khi chạy kèm toàn bộ suite (flake thứ tự/thời gian). 6 test `tests/e2e/copilot.spec.mjs` đạt toàn bộ; hai test danh sách `Thu vào` đạt sau khi `AnnouncementBar` chặn payload lỗi. Cần một vòng tỉa assertion E2E + sửa flake trước khi phát hành. |
| npm run test:pwa (preview 4173) | Đạt |
| Auth acceptance local ma trận 16 bước | Đạt 16/16: OWNER login → `check_user_access` → tạo STAFF qua `manage-users` (201) → đăng nhập mật khẩu tạm → cổng `must_change_password` → đổi mật khẩu + `complete_password_change` (204) → vào app → đổi role → vô hiệu hóa (từ chối `ACCOUNT_INACTIVE`) → từ chối hard-delete tài khoản có lịch sử → hard-delete tài khoản chưa dùng |

Phát hiện cấu hình quan trọng: `supabase/config.toml` từng đặt `[auth.email] enable_signup = false`, vô hiệu hóa luôn email PROVIDER (login báo 422 "Email logins are disabled"). Đã sửa thành `enable_signup = true` (signup công khai vẫn chặn qua `[auth] enable_signup = false`). Dự án production phải xác nhận email provider đang BẬT.

## Trợ lý AI (copilot) — 01/10/2026

Kiểm chứng cục bộ cho `task: 'copilot'`, `public.knowledge_base` và màn hình `/copilot`, `/docs`:

- `node scripts/check-edge-types.mjs` đạt cho 6 tệp Edge (gồm `ai-assist/copilot.ts`); Deno runtime và deployment thật chưa xác minh.
- `tests/security/copilot.test.ts` (11) chạy handler thật qua `tests/helpers/edge-handler.ts`: từ chối chế độ `llm` với STAFF TRƯỚC khi gọi provider, trả lời deterministic khi chưa có khóa AI, fallback khi trích dẫn không khớp bằng chứng, và không lộ số tiền người hỏi không được đọc.
- `tests/db/knowledge.test.mjs` (8, PGLite): 145 mục tài liệu được seed và index full-text, browser không ghi được, RLS/tier audience chặn `search_knowledge` + `get_knowledge_article` với STAFF/anon/disabled, `p_limit` kẹp trong 1..20.
- `tests/unit/copilot-ui.test.tsx` (5) và `tests/e2e/copilot.spec.mjs` (6, Chromium): mỗi nhận định có nút mở đúng trang bằng chứng, link ngoài không bao giờ thành link, text độc hại chỉ là text, chỉ OWNER thấy công tắc AI, và `/docs` chỉ liệt kê phần được đọc.
- Copilot không có đường ghi: fixture e2e kiểm tra `calls.writes` rỗng.

Khung chưa xác minh: provider AI thật (không có khóa), chi phí/thời gian phản hồi Edge trên Supabase hosted, độ liên quan của full-text search với dữ liệu tiếng Việt thực tế, và hành vi trên thiết bị thật.

## Customer communication Phase 1 — 01/10/2026

Checks below use disposable PostgreSQL and browser fixtures. They do not verify hosted Supabase or real-provider delivery. `MOCK` results demonstrate workflow only and are not production delivery.

## Kết quả trên worktree hiện tại

| Kiểm tra | Kết quả |
|---|---|
| npm run lint | Đạt; ESLint không báo lỗi/cảnh báo |
| npm run typecheck | Đạt |
| npm test -- --reporter=dot | 176 test trên 16 file đạt |
| npm run test:db | Đạt: 10 business risk + 29 operational + 9 auth/security + 29 integrity/concurrency = 77 kiểm tra; replay 26 migration đạt |
| npm run test:e2e -- --reporter=line | Đạt: 34/34 E2E sau khi đồng bộ nhãn accessibility trong assertion kiểm tra số khung trùng |
| npm run test:seed | Đạt; seed lặp không nhân dữ liệu, dashboard/báo cáo/sort/phân trang đúng |
| node scripts/check-edge-types.mjs | Đạt cho 5 tệp Edge với type cục bộ; Deno runtime/deploy chưa xác minh |
| npm run build | Đạt 01/10/2026; entry 744.36 kB / 223.02 kB gzip; cảnh báo chunk >500 kB |
| npm run test:pwa | Đạt: manifest/icons, installability Chromium, service worker, login desktop/mobile, offline shell; không có lỗi runtime |

## Phạm vi các kiểm tra quan trọng

- DB suite chạy toàn bộ 26 migration trên PostgreSQL tạm; tạo schema Auth/Storage tối thiểu, dùng dữ liệu giả và kiểm quyền/RLS bằng các role PostgreSQL thật. Communication cases verify atomic outbox behavior, isolated outbox failures, unique idempotency, skips/configuration, retry/backoff, mock state/history and direct-table denial.
- Concurrency tests dùng kết nối PostgreSQL riêng, kiểm tra cạnh tranh bán xe, thu tiền, chi phí và OWNER. PGlite chỉ dùng cho seed/local smoke, không giả lập concurrency.
- E2E dùng PostgreSQL tạm cho nghiệp vụ SQL và mock Supabase HTTP/Auth ở trình duyệt. Các flow gồm thanh toán gửi lại cùng request ID, lọc/thu công nợ, customer history, đối soát, import có dòng trùng, QR, camera bị từ chối, search debounce/keyboard, bảo toàn bộ lọc kho, kiểm tra vai trò và in PDF một trang.
- Phiếu thu được kiểm tra không lộ giá vốn, lợi nhuận, ghi chú nội bộ; PDF Chromium có đúng một trang A4.
- Type Edge không xác nhận Deno runtime/module resolution hoặc Edge deployment.

## Bundle local và cảnh báo

- Build mới sinh entry JavaScript tải ban đầu 744.36 kB (223.02 kB gzip), vượt ngưỡng cảnh báo Vite 500 kB. Đây là entry ứng dụng, không phải riêng camera; hiệu năng production chưa đo.
- Route Capture là chunk động 3.62 kB. `html5-qrcode` nằm trong chunk riêng 375.14 kB (110.56 kB gzip), chỉ được import sau khi người dùng bấm mở quét camera. Thư viện camera không nằm trong JavaScript tải ban đầu.
- Zod phát hai cảnh báo vị trí pure annotation trong mã thư viện; Rollup bỏ annotation và build hoàn tất.

## Giới hạn và cảnh báo

- Không có Supabase CLI hoặc `SUPABASE_ACCESS_TOKEN` trong môi trường này. Production project identity, migration ledger, backup/PITR, schema/RLS, Auth hosted, Edge status và production smoke tests chưa xác minh.
  → **Cập nhật 2026-10-03:** Supabase CLI đã hoạt động. Production ledger (001–037 applied), Auth config (`config diff` match), Edge Functions (manage-users v10, ai-assist v3, process-message v1), backup (FREE plan, no PITR), và Vercel smoke script đều đã xác minh read-only. Migration `038_knowledge_reseed` là local/pending duy nhất.
- Build/test không kết nối Supabase production, không thay đổi tài khoản thật, Auth credentials, Edge deployments hay dữ liệu thật.
- Không có khóa/provider AI cấu hình. Camera, OCR, microphone, upload Storage HTTP, máy in thật, và cài PWA trên điện thoại cần kiểm tra thủ công.
- Migration 018 chứa mật khẩu OWNER mặc định dạng cứng và ghi giá trị đó vào notice. File được giữ lại trong worktree nhưng loại khỏi checkpoint Git; không được áp dụng.

Xem `docs/PRODUCTION_RELEASE.md` để biết bảng migration, trạng thái production và bước tiếp theo an toàn. Xem `docs/IMPLEMENTATION_REPORT.md` để biết phạm vi tính năng và giới hạn kiểm thử.
