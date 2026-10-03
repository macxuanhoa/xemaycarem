# Architecture Decisions — Xe CRM

## Existing foundation retained

## Customer communication Phase 1

- Thank-you event creation is part of `sell_vehicle`'s database transaction; external delivery is always outside the sale transaction.
- The outbox unique key is `(event_type, sale_id, channel)`. Jobs and customer history default to `SKIPPED` unless messaging, thank-you automation, a channel, and a valid Vietnamese phone are present.
- The worker supports explicit mock mode only. `SENT` from mock is workflow evidence, never production delivery evidence. Production provider credentials and behavior are not configured.
- Direct table access is revoked for the outbox/history; role-checked RPCs expose operational data. Customer history stores short previews and operational metadata only.

Xe CRM remains a React and TypeScript single-page application backed by Supabase Auth and PostgreSQL. Business writes continue through security-checked SQL RPCs. RLS remains the table boundary. TanStack Query owns client data freshness. Vietnam local business dates use Asia/Ho_Chi_Minh.

## Operational features

- Receivables are calculated from completed sales and active payment rows; no second debt ledger is introduced.
- A payment retry reuses a client-generated request UUID as the payment UUID. The server compares caller and complete payload before returning the original payment. Different payload with the same key is rejected.
- Reconciliation reports sales revenue by sale date and cash collected by payment date. Net cash movement means collected customer payments minus expenses recorded for that date. Purchase disbursements and expense settlements are unavailable in the existing model and are excluded.
- Customer history groups by normalized phone only. Shared phones carry an identity warning; names without a phone are not merged.
- Import first previews the full file, then asks for explicit confirmation. Only validated rows are submitted; invalid rows remain visible and are not silently represented as imported. Database insertion reuses the acquisition transaction and rolls back a failed batch.
- Printed customer documents use an explicit field allowlist. They exclude cost, profit and internal notes.
- QR stores a UUID and same-origin application route, never arbitrary external navigation.
- AI produces editable drafts or returns actual data from an authorized read-only RPC allowlist. No AI endpoint performs a business mutation.

## AI copilot mode

- The copilot answers strictly under the caller's JWT and RLS. Retrieval calls the existing read RPCs plus `search_knowledge`; `ai-assist` holds no service-role credential, so a STAFF answer physically cannot contain figures STAFF cannot open. Rejected: an unrestricted "see everything" assistant, which would defeat the RLS model the whole app is built on.
- Deterministic, permission-scoped retrieval is both the default and the fallback. The LLM (`mode: 'llm'`) may only re-word evidence already fetched in the same request, never invent a number, and is OWNER-only (`LLM_MODE_OWNER_ONLY`). `copilotSchema` + `validateGroundedAnswer` reject unknown citation ids, ungrounded prose, over-length answers and non-internal links with `INVALID_AI_RESULT`, and the handler degrades to the deterministic answer with a Vietnamese warning instead of failing the question. Rationale: the existing contract already forbids model-authored numbers, and a provider outage or a missing key must not take the feature away.
- Every fact and document excerpt carries a citation id that deep-links into the screen showing it, and the renderer only accepts internal routes. Evidence is a navigation control, not a footnote, because an unverifiable assistant answer would be a worse audit trail than no answer at all.
- Documentation lives in `public.knowledge_base`, generated from tracked markdown by `scripts/build-knowledge-seed.mjs` (one row per `##` section, audience tier per source file) instead of a hand-maintained content table or runtime filesystem reads. The repository stays the single source of truth and a fresh database, including PGLite tests, reproduces the corpus. Rejected: a second copy of the docs authored inside the app, which drifts immediately.
- The copilot is read-only by design: no draft payload, no write RPC, no action endpoint. "Full tool access" was rejected because MCP is an IDE/agent-loop concept that has no host in a Deno Edge Function or an offline PWA, and writes must stay human-approved in the existing secure forms.
- Copilot traffic gets a 30-request budget in the same rolling 10-minute per-user window other AI tasks share at 10, because one grounded question fans out into several read RPCs.

## UI feedback and system announcements

- Feedback layer is hand-built with zero new dependencies (no toast/dialog library added), reusing the project's bespoke CSS-class UI. Toasts use a small `useSyncExternalStore` store (`src/lib/toast.ts`) with SUCCESS/INFO/WARNING/ERROR variants, Vietnamese titles, and 3s/4s/5s/9s default durations (error/warning stay closable).
- Destructive confirmations use one reusable `confirmAction()` promise API backed by a single dialog host (`src/components/ui/ConfirmDialog.tsx`), replacing the last native `window.confirm`. The unsaved-draft navigation guard re-fires the link click after confirmation so native browser navigation is preserved.
- System announcements live in a dedicated `public.system_announcements` table rather than the settings blob, so scheduling, priority, audience, and dismissal have first-class columns. It is a small persistent banner, deliberately kept separate from transient toasts and per-sale business notifications.
- Announcement writes go only through OWNER-checked SECURITY DEFINER RPCs (`save_announcement`, `set_announcement_active`, `delete_announcement`, `list_announcements`); direct table access is revoked and RLS is enabled. Reads for the bar use `list_active_announcements`, which filters by `is_active`, the Asia/Ho_Chi_Minh time window, and audience role, and orders by type priority (CRITICAL>WARNING>INFO>SUCCESS). Every change reuses `private.audit` (ANNOUNCEMENT_CREATE/UPDATE/ACTIVATE/DEACTIVATE/DELETE).
- Dismissal is per-device via `localStorage` keyed by announcement id and `updated_at`, so a substantial edit re-surfaces the announcement; non-dismissible announcements always show. The scrolling ticker is CSS keyframes (not `<marquee>`), pauses on hover, and freezes under `prefers-reduced-motion`.

## Temporary-password proof

The profile flag is a user-flow signal, not proof. A private table stores a salted Auth hash fingerprint for comparison and a pending-reset flag. Server-side completion succeeds only after Supabase Auth changes the hash. Raw password/hash is never returned to the browser. Hosted migration status must be checked before applying this forward migration.

## Privacy and drafts

Local draft/recent values are scoped to the authenticated user and exclude financial amounts and secrets. Images sent for extraction are transient in the browser request; vehicle photo storage remains a separate existing workflow. The provider is disabled until explicit server configuration and policy review.

## Bỏ tab Báo cáo

- Toàn bộ tính năng "Báo cáo" (`/reports`, `src/features/reports/`) đã được gỡ khỏi giao diện: tuyến đường, mục điều hướng, preload, liên kết số liệu trên Tổng quan và trích dẫn copilot trỏ về `/reports` đều chuyển hướng sang màn hình còn tồn tại (Bán hàng/Tổng quan). Lý do: chủ cửa hàng yêu cầu xóa tab khỏi app; số liệu doanh thu/lợi nhuận đã hiển thị ngay trên Tổng quan và danh sách Bán hàng, tab riêng là trùng lặp.
- RPC database `report(p_kind, p_filters)` được giữ nguyên: hàm đã nằm trên production (migration 003/005 đã áp dụng), việc DROP là không đảo được và không cần thiết sau khi UI gỡ; nó chỉ là bề mặt đọc không còn consumer. Ghi quyết định này để agent sau không coi RPC "chết" là sót lại cần xóa vội.

## Ngưỡng tồn kho và chỉ báo trạng thái kho

- `low_stock_threshold` / `high_stock_threshold` là ngưỡng phục vụ đánh dấu hiển thị, KHÔNG phải hệ thống cảnh báo chủ động: hệ thống không gửi email, tin nhắn, thông báo đẩy hay tự tạo `system_announcements` khi chạm ngưỡng (bản cũ trong Cài đặt ghi "sẽ gửi cảnh báo tới quản lý" là sai, đã được sửa). Quyết định chốt: *"Inventory thresholds are operational dashboard indicators only. They do not generate automatic notifications or announcements."* — `system_announcements` vẫn do OWNER tự soạn thủ công. Nếu sau này bật cảnh báo tự động, đó là tính năng riêng phải thiết kế rõ: phát hiện chuyển trạng thái sang LOW, khử trùng lặp (deduplication), cooldown, đối tượng nhận, cách đóng thông báo khi kho trở về NORMAL, và xử lý LOW lặp lại.
- Audit ngữ nghĩa (giữ nguyên công thức server, chỉ sửa câu chữ UI): `inventory_indicator` tính trên TỔNG XE ĐANG TẠI CỬA HÀNG (`IN_STOCK` + `RESERVED`), không phải "xe sẵn sàng bán" — xe RESERVED đang giữ cho khách nên không được mô tả là sẵn sàng bán. Wording UI đổi thành "số xe đang tại cửa hàng". Phương án đổi công thức sang `IN_STOCK` thuần bị bác vì thay đổi semantics nghiệp vụ đang chạy trên production mà chưa được chủ cửa hàng duyệt.
- Biên ngưỡng là so sánh DẸT theo SQL hiện hành (`<` và `>`): LOW khi số xe tại cửa hàng nhỏ hơn mức tối thiểu, HIGH khi lớn hơn mức tối đa; hai ngưỡng là ranh giới của dải chấp nhận được, **số xe bằng đúng ngưỡng vẫn là NORMAL**. Ví dụ với low=5, high=100: 4 → LOW, 5 → NORMAL, 100 → NORMAL, 101 → HIGH. Không tạo migration mới, không đổi logic nghiệp vụ đã chạy trên production. `src/lib/inventory-status.ts` là resolver duy nhất (canonical, ưu tiên `inventory_indicator` từ server) và mirror đúng CASE này; kiểm thử biên nằm ở `tests/unit/inventory-status.test.ts` và `tests/db/operational-features.test.mjs`.
- Câu chữ trợ giúp trong Cài đặt phải phản ánh đúng semantics so sánh dẹt, diễn đạt theo ngôn ngữ kinh doanh đời thường: "giảm xuống dưới mức này" / "tăng vượt trên mức này", kèm ghi chú "Số xe bằng đúng ngưỡng vẫn là Tồn kho bình thường.". Cụm "bằng hoặc thấp hơn" / "bằng hoặc cao hơn" bị bác vì gợi ý ngưỡng là điểm kích hoạt, trái với hành vi thực tế của RPC.
- Nhãn hiển thị trên card "Kho xe hiện tại" (Dashboard): LOW → "Tồn kho thấp", NORMAL → "Tồn kho bình thường", HIGH → "Tồn kho cao", dùng tone màu ngữ nghĩa đã có trong theme (emerald/amber/indigo tint), không định nghĩa bảng màu mới.

## Thu xe tốc ký (/intake)

- Tái sử dụng cặp RPC `validate_import_vehicles` + `import_vehicles` đã tồn tại trên schema (migration `20260930002400`): không thêm migration, không thêm Edge Function. Lô thu xe là nguyên tử all-or-nothing do server thực thi; khách KHÔNG bao giờ ghi từng dòng `acquire_vehicle` khi nhập nhiều xe.
- Thứ tự chặn sai: bấm "Thu N xe vào kho" gọi validate TRƯỚC, map lỗi server (khung/biển trùng, vượt giới hạn) trở lại đúng từng thẻ xe và huỷ hộp thoại xác nhận; chỉ khi sạch mới confirm rồi mới import. Chi phí một round-trip validate đổi lấy việc không bao giờ mở hộp thoại "xác nhận" cho dữ liệu chắc chắn bị từ chối.
- Bộ nhớ viết tắt là localStorage theo thiết bị + theo tài khoản (`carem_shorthand_dict_v1:<userId>`), không có bảng server: cách viết tắt là thói quen cá nhân, không cần chia sẻ/audit; đánh đổi mất bộ nhớ khi đổi thiết bị được chấp nhận. Từ điển học được ƯU TIÊN hơn builtin (người dùng thắng mặc định), trần 300 quy tắc, sắp xếp theo số lần dùng.
- Thư viện parse nằm thuần trong `src/lib/shorthand/`, nhận từ điển và storage qua interface — unit-test chạy môi trường node của Vitest, không cần jsdom/localStorage.
- An toàn tài chính mô phỏng hợp đồng server: tài khoản không `can_view_financials` KHÔNG render trường Giá thu và key `purchase_price` không tồn tại trong payload (server sẽ `FINANCIAL_ACCESS_DENIED`); tài khoản tài chính bắt buộc nhập giá (`PURCHASE_PRICE_REQUIRED`). Client validate bản địa soi cùng luật để lỗi hiện tức thì, server vẫn là chuẩn cuối.
- Token lạ KHÔNG bao giờ bị âm thầm bỏ: hiển thị dạng chip kèm hai hành động `+ Ghi chú` và `Học`; từ đầu tiên chưa biết mới tạm đổ vào Dòng xe, và mọi trường đã có giá trị nhận token thừa vào chip lạ. Đây là điều kiện để dụng cụ học đúng thay vì đoán câm.
- Seed `knowledge_base` lệch sau khi thêm trang `/intake` (docs hệ thống sinh từ code): xử lý bằng quy trình chuẩn `npm run knowledge:seed` tái sinh migration-seed `20261001002900` — file seed không bao giờ sửa tay; migration này chưa deploy nên tái sinh local là forward-only hợp lệ.

## Bỏ bắt buộc đổi mật khẩu ở lần đăng nhập đầu tiên

- Chủ cửa hàng yêu cầu bỏ màn hình cưỡng chế **Đổi mật khẩu** (`/change-password`) sau khi nhân viên được tạo tài khoản đăng nhập lần đầu — coi là rườm rà; "họ thích thì họ đổi trong Cài đặt sau". Thay đổi đúng một điểm luồng: Edge Function `manage-users` (action `create`) không còn gửi `must_change_password: true` trong `update_profile`; trigger `private.new_auth_user` vốn đã mặc định `false`. Migration forward-only `20261002003500` giải phóng các tài khoản đang còn bị chặn bởi cổng lần đầu, có tạm treo trigger `protect_last_usable_owner` quanh câu UPDATE (chỉ để phục vụ quyết định sản phẩm có chủ đích, không mở đường tắt cho bypass từ phía người dùng).
- Cơ chế `must_change_password` GIỮ NGUYÊN cho hành động chủ động của OWNER: `reset_password` (cấp mật khẩu tạm mới vẫn buộc đổi). Các tài khoản đang có `reset_pending` không bị migration giải phóng — đảm bảo fail-closed: mật khẩu tạm chưa được xoay thật thì cổng vẫn đóng. Trang `/change-password` và RPC `complete_password_change` vẫn tồn tại phục vụ luồng đó; nhân viên chủ động đổi trong Cài đặt → **Đổi mật khẩu** (`supabase.auth.updateUser`, không cần RPC cổng). *(Ghi chú cập nhật: hành động `force_password_change` đã bị gỡ ở đợt Quản lý nhân sự bên dưới — điều khoản này không còn hiệu lực với action đó.)*
- Hệ quả chấp nhận: mật khẩu ban đầu do OWNER đặt tồn tại lâu hơn trong môi trường tin nhắn nội bộ — đổi lại là đánh đổi được chủ cửa hàng yêu cầu rõ ràng, không mặc định siết lại.

## Quản lý nhân sự: giờ làm chung, một Chủ cửa hàng, cấm sử dụng có thời hạn

- UI mobile popup chi tiết nhân sự (bottom sheet vừa khung 390×844, hai tab "Quyền & Vai trò" và "Bảo mật & Trạng thái", không tràn ngang) được fix theo yêu cầu; Playwright kiểm bằng bounding box và `scrollWidth` thay vì chỉ ảnh chụp.
- Xóa giờ làm việc theo từng người: các cột `allowed_from/allowed_until/working_days` trên profile còn trong DB nhưng thành legacy không đọc để xét quyền. Nguồn duy nhất là `staff_allowed_from/staff_allowed_until/staff_working_days` trên `system_settings`, áp dụng cho MỌI vai trò ngoài OWNER, hỗ trợ cửa sổข้าม đêm, múi giờ Asia/Ho_Chi_Minh. Chỉ OWNER ghi qua `save_settings` với kiểm tra đầu vào (`INVALID_SCHEDULE` cho giờ `25:00:00`, cửa trống, thứ ngoài 1..7). Migration forward-only `20261002003600_shared_schedule_and_single_owner.sql` — đổi số từ `003500` vì trùng version với migration `no_forced_first_password_change` đã tồn tại (CLI coi timestamp là số hiệu duy nhất).
- Bảo mật tài khoản còn đúng hai chế độ theo yêu cầu chủ cửa hàng: (1) **Xóa tài khoản** (`delete`, giữ lịch sử nghiệp vụ; OWNER cuối còn hoạt động không xóa được — `CANNOT_DELETE_FINAL_OWNER`); (2) **Cấm sử dụng tạm thời** (`disable` bắt buộc thời điểm tương lai `disabledUntil`, thiếu/quá hạn → `BAN_DURATION_REQUIRED`; preset Hết hôm nay / 7 ngày / 30 ngày / tự chọn; không cấm được OWNER — `CANNOT_BAN_OWNER`). Gỡ `force_password_change`, khóa tạm thời không thời hạn, và vô hiệu hóa kiểu cũ; Edge trả `INVALID_ACTION` với ba action này. Supersede điều khoản `force_password_change` còn hiệu lực ở mục trước; `reset_password` (OWNER) vẫn buộc đổi mật khẩu qua `reset_pending`.
- Một Chủ cửa hàng duy nhất: OWNER set role mọi tài khoản khác; ghi raw role=OWNER cho người thứ hai bị `update_profile` chặn (`SINGLE_OWNER_REQUIRED`). Nâng người khác lên OWNER phải qua RPC `transfer_ownership` — hạ rồi thăng nguyên tử trong một transaction, dùng chung advisory lock 761482190 với `update_profile` để tuần tự hóa; cấm tự chuyển (`SELF_TRANSFER_NOT_ALLOWED`), đích phải đang hoạt động (`TARGET_NOT_ACTIVE`). MANAGER chỉ `change_role` cho cấp thấp hơn (STAFF), chạm MANAGER/OWNER trả 403; STAFF không có quyền quản lý nhân sự, trang `/users` đổi sang `access="manage"`.
- Gỡ câu chữ "tài khoản chủ cửa hàng có toàn quyền quản trị cao nhất trên toàn hệ thống Cà Rem" khỏi giao diện.
- Dọn phụ trợ trong vòng kiểm chứng: `playwright.config.ts` đặt `reuseExistingServer: !process.env.CI` (tiến trình vite con do Playwright quản lý chết giữa suite trên máy Windows này — hạ tầng, không phải sản phẩm); sửa hai assertion nhãn `+ Chi phí` → `Chi phí` trong `ux-convenience.spec.mjs` do CTA PageHeader của VehicleDetailPage đã đổi tên từ phiên trước, lệch nhãn có sẵn.

## Unverified external state

These decisions describe local code. They do not assert the current contents of a hosted Supabase project or any production account credential.

