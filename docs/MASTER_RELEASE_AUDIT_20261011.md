# MASTER RELEASE AUDIT — CÀ REM CRM (11/10/2026)

## 1. TỔNG QUAN PHIÊN HOÀN THIỆN & PHÁT HÀNH

- **Thời điểm thực thi**: 11/10/2026
- **Mục tiêu**: Hoàn thiện toàn bộ codebase Cà Rem, xử lý WIP, tích hợp toàn bộ tính năng, sửa lỗi regression, kiểm thử toàn diện, đồng bộ database migrations, commit, push và phát hành Vercel Production.
- **Trạng thái cổng kiểm thử (Release Gates)**:
  - `lint`: PASS (0 warnings, 0 errors)
  - `typecheck`: PASS (`tsc -b` 0 errors)
  - `unit tests` (vitest): PASS (793 tests / 66 test files)
  - `knowledge:check`: PASS (`docs/SYSTEM_REFERENCE.md` & `knowledge_base` 244 sections)
  - `edge check` (`check:edge`): PASS (8 edge entrypoints & 11 native Deno HTTP smoke tests)
  - `db integration & rpc security` (`test:db`): PASS (30 integration tests + 200+ specialized DB tests across 18 test suites)
  - `concurrency audit` (`test:concurrency`): PASS (16 core + 23 extended concurrency tests)
  - `pwa verification` (`test:pwa:release`): PASS (manifest, icons, installability, SW precache, offline shell, update gate)
  - `migration rehearsal` (`rehearse-production-migrations.mjs`): PASS (10 pending migrations tested on production backup snapshot, atomic rollback verified, financial history intact)
  - `production build` (`build`): PASS (Vite production bundle + SW generation)
  - `e2e browser verification` (`test:e2e`): PASS (233 / 233 Playwright tests)

---

## 2. PHẠM VI TÍNH NĂNG TÍCH HỢP HOÀN CHỈNH

### A. Vehicle CRM Core
- **Quy trình Quản lý xe**: Thu xe, tồn kho, bán xe, quản lý loại xe (danh mục tự do có autocomplete), biển số, số khung.
- **Duplicate Detection**:
  - `FULL_FRAME_MATCH`: Chặn tuyệt đối (HARD RED block), không cho phép ghi đè hay ngoại lệ.
  - `PLATE_AND_LAST5`: Cảnh báo nghi vấn trùng (SUSPECTED); nhân viên bị chặn lưu và phải gửi yêu cầu xác minh (`REQUEST`).
  - Hàng đợi xác minh trùng (`/duplicate-reviews`): Chỉ OWNER/MANAGER xem và giải quyết.
  - Phê duyệt ngoại lệ: Bắt buộc kèm lý do và hồ sơ đối chiếu; bản ghi được đánh dấu `OVERRIDE`.
  - Giữ bí mật tài chính: Hàng đợi duyệt không để lộ giá vốn riêng tư của xe đối chiếu.

### B. Finance & Smart Sales Automation
- **Phân quyền & Bảo mật**:
  - OWNER-private financial provenance: Giá thu do OWNER nhập là `PRIVATE`; STAFF/MANAGER không đọc được và không suy diễn được qua bất kỳ RPC/thông báo nào.
  - `SALE_OWNER_CONFIRMATION_REQUIRED`: Mọi đề xuất bán xe có giá vốn PRIVATE đều phải qua OWNER xác nhận độc lập, triệt tiêu nguy cơ oracle attack dò giá vốn.
  - Bán dưới giá thu PUBLIC (`SALE_BELOW_COST_APPROVAL_REQUIRED`): Nhân viên gửi duyệt, OWNER phê duyệt/từ chối.
- **VietQR & Bank Reconciliation**:
  - Sinh mã VietQR động với mã tham chiếu duy nhất chuẩn cú pháp `CAREM GDxxxxx`.
  - Webhook ngân hàng (`ingest_bank_transaction`): Chỉ `service_role` được gọi, chống double-credit qua `(provider, provider_txn_id)` idempotent.
  - Tự động khớp (`MATCHED_PENDING`) khi khớp đúng mã và số tiền; lệch số tiền đưa vào `MANUAL_REVIEW` mà không làm lộ số tiền đúng.
  - Xác nhận giao dịch ghi nhận thanh toán `BANK_TRANSFER` và giảm công nợ an toàn.
- **Customer Contacts & Outreach**:
  - Quản lý danh bạ khách hàng liên kết đơn bán.
  - Chống rò rỉ: Danh bạ không chứa trường giá; mẫu tin nhắn từ chối placeholder giá tiền.
  - Tích hợp Zalo OA, Facebook Page, SMS: Các adapter chưa có credential thực tế được giữ ở trạng thái an toàn `NOT_CONFIGURED` (fail-closed, không giả lập thành công).

### C. PostStudio / Facebook Sharing
- Tách thành menu riêng **Đăng bài từ kho xe** (`/posts`).
- Quy trình 2 bước: Chọn xe từ Kho (`?pick=post`) -> Nhập tóm tắt mô tả tự do -> Gửi nguyên văn cho AI (nằm ở `contents`, không đưa vào prompt hệ thống).
- Nhắc nhở an toàn sớm qua `briefSignals.ts` (whitelist hotline Cà Rem 0914929292, loại bỏ thông tin giá/SĐT/CCCD/trả góp).
- Ba luồng chia sẻ Facebook trung thực:
  1. `EXTENSION`: Tiện ích Chrome MV3 tự điền và đọc lại xác nhận (≥85% khớp).
  2. `NATIVE`: Mobile Web Share API.
  3. `MANUAL`: Sao chép nội dung vào clipboard và mở Facebook.
- Tuyệt đối không bao giờ tự ý bấm "Đăng" hay nói "Đã đăng" khi người dùng chưa duyệt.

### D. Seasonal Theme Tết 2027
- Cấu hình theme hệ thống quản lý bởi OWNER tại Cài đặt: `DEFAULT` / `TET_2027` / `AUTO` (theo lịch trình ngày cấu hình).
- Mở đầu điện ảnh (cinematic opening) có thể bật/tắt độc lập, tôn trọng `prefers-reduced-motion`.
- Mặc định sau khi phát hành: `DEFAULT`, cinematic disabled. Không tự kích hoạt theme Tết trên production khi chưa tới thời điểm.

### E. Nền tảng Core & DevSecOps
- RBAC nghiêm ngặt: OWNER / MANAGER / STAFF.
- RLS kích hoạt trên 100% bảng public.
- Toàn bộ RPC bảo mật `SECURITY DEFINER` với `SET search_path = ''` cố định.
- Chống race condition: Khóa giao dịch `FOR UPDATE` và `pg_advisory_xact_lock`.
- Giám sát lỗi runtime an toàn: Không ghi nhật ký PII hay tham số nhạy cảm.

---

## 3. DANH SÁCH DATABASE MIGRATIONS ĐÃ ÁP DỤNG TRÊN PRODUCTION

Toàn bộ 80 migrations (từ `20260930000100` đến `20261014000300`) đã được áp dụng và đồng bộ hoàn toàn trên production Supabase:
1. `20261011000200_hide_gen_frame_in_label.sql`
2. `20261011000300_frame_kind_auto_only.sql`
3. `20261011000400_duplicate_plate_last5_review.sql`
4. `20261012000100_smart_sales_customer_contacts.sql`
5. `20261012000200_official_outreach_channels.sql`
6. `20261012000300_bank_transaction_reconciliation.sql`
7. `20261013000100_seasonal_theme_tet2027.sql`
8. `20261014000100_security_integration_hardening.sql`
9. `20261014000200_message_delivery_trust.sql`
10. `20261014000300_knowledge_reseed.sql`

---

## 4. AN TOÀN SAO LƯU & KHÔI PHỤC

- Bản sao lưu hợp lệ trước khi áp dụng thay đổi: `carem-prod-2026-10-11-182131-*`.
- Đầy đủ 25 tệp mã hóa SHA-256, bao gồm cấu trúc schema, dữ liệu, lịch sử migration và 21 tệp ảnh nhị phân Storage.
- Kiểm tra tính toàn vẹn đạt chuẩn qua `node scripts/backup-verify.mjs --integrity-only`.
