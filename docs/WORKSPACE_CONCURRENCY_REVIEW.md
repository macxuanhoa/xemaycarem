# Concurrency, Failure Recovery & Git Workspace Audit

> Báo cáo lịch sử trước vòng master hardening. Kết quả cuối và các bản sửa tiếp theo nằm trong [CRM_RELIABILITY_MASTER_AUDIT.md](CRM_RELIABILITY_MASTER_AUDIT.md); không dùng số liệu/bảng blocker bên dưới như trạng thái hiện tại.

Ngày kiểm tra: 06/10/2026. Phạm vi: workspace local so với HEAD, ứng dụng React, RPC/migrations, PostgreSQL/RLS, Edge handler và PWA production preview. Báo cáo này thay thế bản đánh giá trước khi sửa.

## 1. Kết luận

**Chưa đạt quality gate để phát hành toàn bộ workspace.** Các bộ regression hiện có đều PASS, nhưng bộ concurrency/failure bổ sung còn **11 PASS / 3 FAIL**, và một số tình huống hosted/thiết bị thật là **NOT VERIFIED**. Không có bằng chứng đủ để kết luận an toàn toàn diện. Chưa phát hiện P0 trong phạm vi thực sự kiểm tra; đây không phải chứng nhận không tồn tại P0.

Đã sửa local các lỗi có nguyên nhân và kiểm chứng được: phục hồi mã thanh toán qua reload, đối soát kết quả mất phản hồi, xung đột form xe cũ, thu hồi quyền trong lúc chờ khóa, lưu nháp thông tin cá nhân và nhánh lỗi purge báo sai kết quả. Không sửa số tiền, công thức lợi nhuận, snapshot tài chính, trạng thái hủy hay mô hình phân quyền. Không thêm dependency. Không stage/commit/push/deploy, không dùng khách hàng thật, không sửa production. Verified snapshots được giữ nguyên.

## 2. Bằng chứng và cách kiểm tra

- Test database dùng PostgreSQL disposable với dữ liệu giả; không dùng credential cloud. `tests/db/concurrency-audit.mjs` mở các kết nối độc lập và chạy đồng thời bằng `Promise.allSettled`.
- Với tình huống thu hồi quyền và các interleaving trong `scripts/test-db.mjs`, kiểm tra `pg_stat_activity.wait_event_type='Lock'` trước khi nhả khóa. Không suy diễn khóa chỉ từ thứ tự gọi hàm frontend.
- Failure injection trong `tests/e2e/business-flows.spec.mjs:206` gọi RPC thật trên database local, đợi commit rồi hủy phản hồi HTTP. Test tiếp tục đối soát hoặc reload rồi thử lại, kiểm tra số dòng và tổng tiền database.
- E2E ứng dụng sử dụng hạ tầng/mock transport local. Điều này không chứng minh gateway, Auth và Edge Function hosted hoạt động như production.
- `tests/unit/manageUsersFailure.test.ts` chạy handler Edge thực tế đã transpile với shim Deno/SDK; kiểm tra HTTP 500 và không gọi xóa. Không tương đương chạy Deno/Supabase hosted.

## 3. Phát hiện, nguyên nhân và bản sửa

| Mức | Vấn đề / nguyên nhân / bằng chứng | Xử lý và giới hạn |
| --- | --- | --- |
| P1 | Thanh toán mất phản hồi trước đây chỉ giữ request UUID trong useRef; reload/remount tạo UUID khác, có thể thu trùng khi còn dư nợ. | Thêm `src/lib/paymentRecovery.ts`: lưu duy nhất UUID opaque theo user/sale trước khi gửi. `SaleDetailPage.tsx:396` đọc lại lịch sử và đối soát UUID trước thao tác tiếp. Unit và 2 E2E mất phản hồi/reload PASS. Không bảo đảm dedup khi đổi thiết bị, xóa/corrupt storage hoặc hai tab tạo key cùng lúc. |
| P1 | Cùng một khoản nhận tiền thực tế, nhưng hai request_id khác nhau, được nhận hai lần nếu tổng chưa vượt dư nợ. `concurrency-audit.mjs:72` tái hiện và FAIL. | **CÒN LỖI theo yêu cầu chống trùng nghiệp vụ.** Database không có định danh phiếu thu/chuyển khoản chung. Không tự dedup theo số tiền/ngày vì sẽ xóa nhầm hai khoản thu hợp lệ. Cần xác định định danh chứng từ hoặc quy trình đối soát dùng chung. Mã bền trên một thiết bị chỉ giảm một nguyên nhân phát sinh key mới. |
| P1 | acquire_vehicle không có request UUID. Khi số khung để trống, gọi lại payload sau commit mất phản hồi tạo hai vehicle/acquisition. Audit chạy RPC thật hai lần và xác minh hai dòng acquisition. | **CÒN LỖI recovery thu xe.** Unique số khung bảo vệ trường hợp có số khung nhưng không bảo vệ nhập thiếu số khung được cho phép hiện tại. Cần idempotency backend và mã giao dịch bền frontend; không suy ra cùng xe chỉ từ model/giá. Test mô phỏng commit rồi retry ở DB, chưa inject mất phản hồi thu xe qua UI. |
| P1 | Kiểm tra quyền trước khi đợi khóa xe có thể dùng quyền đã bị thu hồi trong thời gian chờ. | Migration `20261005001200_transaction_conflict_guards.sql:18,108,178` kiểm tra lại quyền sau khi lấy khóa trong save_vehicle/sell_vehicle/add_payment. Test thu hồi quyền lúc sale đang chờ khóa PASS, không tạo sale. Không chứng minh mọi RPC hoặc thời điểm sau lần kiểm tra cuối cùng đều an toàn. |
| P2 | Form chỉnh sửa xe dùng dữ liệu cũ; khóa hàng chỉ tuần tự hóa ghi, không phát hiện lost update. | Form giữ updated_at của lần mở đầu (`VehicleFormPage.tsx`), gửi expected_updated_at. RPC so sánh sau khóa và trả VEHICLE_EDIT_CONFLICT (migration mới:19). Test đảm bảo màu mới không bị form cũ ghi đè PASS. Token còn tùy chọn cho caller cũ; caller không gửi token vẫn có thể ghi đè. |
| P2 | Hai lần sửa hạn công nợ đều được chấp nhận; update_sale_due_date chỉ khóa sale, không kiểm tra revision. Migration `20260930002300_operational_features.sql:109`; audit test:152 FAIL. | **CÒN LỖI.** Chưa thay đổi chữ ký RPC/caller hạn thanh toán trong đợt này. Tổng tiền không bị thay đổi trong test, nhưng người dùng chưa được báo xung đột hạn thanh toán. |
| P2 | Draft lưu tên, số điện thoại và ghi chú; dictionary tốc ký từng có thể học người bán, số tiền hoặc ghi chú. | formDrafts bỏ các trường này, scrub draft cũ khi đọc; useFormDraft vẫn bảo vệ dữ liệu chưa lưu và giải thích trường cần nhập lại. Dictionary chỉ học brand/model/variant/color/year; UI lọc tương ứng. Unit PASS. Các key legacy chưa được mở và dữ liệu đã lưu từ trước trong các cơ chế khác chưa được xóa toàn cục. Không tuyên bố mọi browser storage đều sạch dữ liệu nhạy cảm. |
| P2 | RPC log đầy đủ lỗi server có thể mang giá trị người dùng nhập. | api.ts:135 chỉ log code ở DEV. Không log raw RPC error trong production. Các DEV Edge diagnostic vẫn có response body được lọc một số key; audit không chứng minh redaction toàn bộ log backend/DEV. |
| P2 | purgeOne trả Response thay vì object outcome/error khi truy vấn kiểm tra thất bại; caller có thể báo thành công thiếu outcome. | manage-users/index.ts sửa return `{ outcome: 'failed', error: response(...) }`. Test handler lỗi truy vấn PASS: HTTP 500, không xóa. Purge/restore đồng thời, Auth/profile rollback và hosted runtime vẫn NOT VERIFIED. |
| P2 | Bán xe không có request_id trả lại sale đã commit khi mất phản hồi. | Lock/state/unique constraint ngăn lần bán thứ hai; DB test PASS một sale/một initial payment. UI reconciliation sau timeout sale chưa kiểm chứng; phải tải lại xe/lịch sử và xác nhận trước thao tác tiếp. Không gắn PASS recovery bán xe từ kết quả chống trùng DB. |
| P3 | E2E phát cảnh báo MaxListenersExceededWarning ở Client test; build cảnh báo annotation Zod. | Suite và build vẫn exit 0. Chưa chứng minh rò rỉ tài nguyên runtime production; chưa sửa listener harness trong đợt này. |

## 4. Concurrency: UI → RPC → database → RLS

| Tình huống | Cơ chế và kết quả thực tế |
| --- | --- |
| Hai nhân viên bán cùng xe, có khoản thu ban đầu | SellVehiclePage → api.sales.sell → sell_vehicle; FOR UPDATE xe, kiểm tra trạng thái sau khóa, insert snapshot/payment/state/audit cùng transaction; unique one_completed_sale_per_vehicle. **PASS** chỉ một sale/payment. |
| Hai người cùng đặt cọc | **NOT VERIFIED / chưa có luồng riêng**. Chỉ thấy trạng thái RESERVED trong form xe; không có phiếu cọc với khách/số tiền/expiry/owner. initial_payment thuộc sale COMPLETED. Không triển khai luồng cọc bằng suy đoán. |
| Bán xe cạnh tranh với giữ chỗ/form xe cũ | RESERVED vẫn được bán theo nghiệp vụ hiện tại. Form cũ không thể đổi SOLD về RESERVED: **PASS**. Token cập nhật chặn stale edit khi caller gửi token. Giữ chỗ chưa có chủ sở hữu hay quyền bán riêng. |
| Thu cùng số khung | Acquisition form → acquire_vehicle; normalization/constraint backend. **PASS** hai request thật đồng thời chỉ tạo một vehicle và một acquisition. **FAIL** commit rồi retry cùng payload khi số khung trống: hai acquisition. |
| Hai khoản thu vượt tổng dư nợ | add_payment khóa vehicle rồi sale, tính ACTIVE payments dưới khóa. **PASS** chỉ khoản hợp lệ được nhận, không vượt dư nợ. |
| Cùng request UUID từ hai tab | **PASS** một payment/audit; lần gọi sau trả UUID cũ. RPC so actor/payload trước replay; khác payload/actor bị PAYMENT_REQUEST_CONFLICT theo suite operational. |
| Hai UUID độc lập cho cùng receipt | **FAIL**, ghi hai payment nếu dư nợ đủ. Giới hạn phân biệt giao dịch thực tế, không phải thiếu khóa chống overpayment. |
| Hai người sửa thông tin xe | **PASS** stale edit có expected_updated_at bị từ chối, dữ liệu trước còn nguyên. Mọi caller cũ và mọi loại trường chưa được bao phủ riêng. |
| Hai người sửa công nợ/khách hàng | Hạn thanh toán **FAIL** conflict. Tổng tiền được bảo vệ qua add_payment; sửa tên/thông tin khách đồng thời ở mọi màn hình **NOT VERIFIED**. |
| Thu tiền cạnh tranh hủy bán | **PASS** không còn ACTIVE payment trên CANCELLED sale; suite hiện có cũng kiểm tra chờ hủy rồi payment bị từ chối. Snapshot và void history được giữ. |
| Tác vụ nền cạnh tranh | claim_message dùng atomic UPDATE QUEUED→PROCESSING; **PASS** hai worker chỉ một claim. Worker chết sau claim, reclaim lease và lỗi nhà cung cấp ngoài hệ thống **NOT VERIFIED**; không thấy cơ chế lease recovery đầy đủ qua code đã kiểm tra. |
| Thu hồi quyền trong lúc request chờ khóa | Sale **PASS** sau bản sửa; RLS/direct writes/disabled token suite hiện có **PASS**. Tất cả RPC, upload hay Edge khi revoke giữa request **NOT VERIFIED**. |
| Deadlock/stress nhiều thao tác | Các cặp đã chạy kết thúc, không gặp deadlock. Luồng sale/payment giữ thứ tự vehicle→sale. Mọi chu trình lock, tải kéo dài, nhiều worker/khác isolation level **NOT VERIFIED**; không kết luận không có deadlock toàn hệ thống. |

RLS không thay thế validation RPC: browser bị cấm direct writes vào bảng nghiệp vụ/tài chính. Các hàm security-definer và search_path/grants được suite DB kiểm tra. Không chỉ dùng disabled button frontend để chống trùng.

## 5. Failure recovery và trạng thái hiển thị

Draft là dữ liệu local chưa xác nhận; Saving là mutation pending; Confirmed chỉ sau kết quả server hoặc tìm được payment đã commit trong lịch sử; Failed là lỗi; Conflict có thông báo cụ thể cho stale vehicle edit/payload không khớp. UUID pending biểu thị cần đối soát, không chứng minh server chưa lưu. UI chưa có một trạng thái Pending/Unknown thống nhất cho tất cả loại giao dịch.

| Tình huống | Kết quả / giới hạn |
| --- | --- |
| Offline trước khi Lưu | ensureOnline chặn, mutation retry:false, không queue hoàn tất nghiệp vụ offline. E2E bán offline **PASS**, không gửi RPC. Không dùng navigator.onLine làm bằng chứng server có thể truy cập. |
| Đứt mạng sau payment commit | Route hủy phản hồi sau commit, UI đối soát UUID qua get_sale; **PASS** đúng một khoản thu, không gửi add_payment lần hai. |
| Reload sau payment commit mất phản hồi | **PASS** UUID còn, đối soát trên mở lại form, không tạo khoản thu thứ hai. E2E `business-flows.spec.mjs:404`. |
| Thu xe thiếu số khung, commit rồi retry | **FAIL** hai acquisition qua RPC thật. Chưa có request UUID/reconciliation. Không được tự gửi lại thu xe khi chưa biết kết quả lần trước; cần kiểm tra tồn kho/phiếu thu. Failure injection HTTP cho riêng luồng này **NOT VERIFIED**. |
| Storage đầy/không truy cập được khi lưu payment key | Unit **PASS** chặn gửi nếu không giữ được key. Storage bị xóa, UUID hỏng hoặc đổi thiết bị: không còn đủ thông tin recovery; cần kiểm tra sổ thu trước khi tạo mới. |
| Sửa payload trong khi có payment pending | Nếu UUID đã ghi, UI tìm payment và trả kết quả cũ thay vì tạo giao dịch mới; nếu caller gửi khác payload tới UUID có sẵn, backend báo conflict. Không tự coi amount giống nhau là receipt giống nhau. |
| Đóng trang khi chưa lưu | Draft debounce 350 ms và navigation guard hiện có; unit/storage/E2E regression **PASS** phạm vi suite. Tiền/tên/điện thoại/ghi chú không được tự lưu; đóng đột ngột có thể mất các trường này và phần nhập trong cửa sổ debounce. |
| Mạng chậm/chập chờn/mất đúng trước commit | Chưa chạy ma trận latency/timeouts trước mọi ranh giới transaction: **NOT VERIFIED**. Lỗi transport không chứng minh rollback; không retry vô hạn. |
| Supabase/API/Edge gián đoạn | Có error mapping frontend; purge query failure handler **PASS** qua shim. Hosted outage, cold start, gateway 5xx thực tế **NOT VERIFIED**. |
| Session hết hạn/storage Auth bị chặn | Có error handling auth và disabled-role DB tests. Auth storage adapter truy cập storage không có catch đầy đủ; runtime blocked-storage/login refresh và session-expiry giữa save **NOT VERIFIED**. |
| Điện thoại hết pin/đóng ứng dụng | Reload mô phỏng một phần payment recovery **PASS**. Thiết bị thật/process kill/unflushed storage **NOT VERIFIED**. |
| SW/cache/offline | Preview production đúng 4173; manifest/installability/controller, static cache, offline login reload và về online **PASS**. Cache snapshot của context mới không chứa REST/Auth/Functions responses; runtimeCaching hiện rỗng. Không kiểm tra mọi phiên authenticated từ lâu. |
| SW cũ/deploy mới giữa giao dịch | registerType prompt, UI yêu cầu lưu trước update theo code review. Chuỗi hai phiên bản SW, rollback/deploy thật, key/schema compatibility giữa bản cũ và bản mới **NOT VERIFIED**. |
| PDF/thông báo lỗi | DB transaction, rollback audit và atomic outbox claim đã kiểm tra. PDF download fail, provider đã nhận nhưng callback mất và outbound notification dedup ngoài hệ thống **NOT VERIFIED**. Không chạy gửi ngoài hệ thống. |

## 6. Kết quả quality gate sau bản sửa

| Bộ | Lệnh / phạm vi | Kết quả |
| --- | --- | --- |
| Lint | npm run lint | **PASS**, exit 0; chạy lại sau sửa PWA test. Không bao gồm supabase/functions. |
| Typecheck | npm run typecheck | **PASS**, exit 0. tsconfig không bao gồm Edge Deno. |
| Production build | npm run build | **PASS**, exit 0; 62 precache entries. Có warning annotation Zod. |
| Unit | npm run test | **PASS**, 30 files / 338 tests. Có UUID storage/quota, legacy draft scrub, dictionary và Edge failure. |
| Database/RLS/integration | npm run test:db | **PASS**, PostgreSQL disposable; migration/business/operational/auth/knowledge/copilot/identity/showroom/hard-delete/notification suites và 30 checks integration cuối. Concurrency hiện có chạy multi-session. |
| Knowledge generated artifacts | npm run knowledge:check | **PASS**, artifacts up-to-date, 184 sections. |
| E2E | npm run test:e2e -- --reporter=line | **PASS**, 92/92; mất phản hồi/reload payment nằm trong suite. Có warning test Client listeners. |
| Focused payment recovery E2E | 2 tests business-flows | **PASS**, 2/2, chạy thêm ngoài full suite. |
| PWA | npm run preview -- --port 4173 --strictPort; npm run test:pwa | **PASS** production preview, cache/static shell/offline→online/desktop/mobile. |
| Audit concurrency/failure bổ sung | node tests/db/concurrency-audit.mjs | **FAIL**, exit 1: 11 PASS / 3 FAIL (thu xe không số khung retry, receipt khác key, conflict hạn công nợ). Log local: test-results/concurrency-audit.log (ignored). Không skip hoặc đổi kỳ vọng để làm xanh. |
| Git whitespace | git diff --check | **PASS**; Git có cảnh báo LF→CRLF, không phải lỗi nội dung. |
| Hosted Edge/Deno / production / thiết bị thật | Không thực thi | **NOT VERIFIED**. |

Các test đã xanh không loại bỏ ba lỗi audit còn lại. Script audit chưa đưa vào npm test:db; cần chạy riêng khi review/release. Không sửa test để che lỗi: assertions format UI được đối chiếu nghiệp vụ trước đó; payment recovery đổi kiểm tra từ resend sang reconciliation và vẫn kiểm tra request count/database aggregate. Không sửa snapshots.

## 7. Git workspace: nguồn gốc và phân loại từng file

Ký hiệu: **Trước** = đã tồn tại từ các yêu cầu UI/audit trước; **Hiện tại** = bổ sung ở vòng concurrency/failure recovery; **Trộn** = cùng file có cả hai. Nguồn gốc dựa vào trạng thái đầu vòng và diff đã đọc, không phải suy ra tác giả/timestamp Git. 30 file modified, 10 untracked; staged rỗng; không có file deleted. acquisitionSchema có status M nhưng diff ngữ nghĩa trống.

| File | Nguồn gốc / nhóm | Kiểm chứng hoặc phần chưa kiểm chứng |
| --- | --- | --- |
| scripts/check-pwa.mjs | Hiện tại: cache, online recovery assertions | PWA PASS |
| src/components/ui/index.tsx | Trước: export input | Build/typecheck PASS |
| src/components/ui/GroupedIntegerInput.tsx (mới) | Trước: nhập số có nhóm | Build/E2E; mọi biến thể caret/backspace NOT VERIFIED |
| src/lib/vehicleInputFormatting.ts (mới) | Trước: năm/km | Build/E2E; toàn bộ biên NOT VERIFIED |
| src/features/acquisitions/AcquisitionFormPage.tsx | Trước: gọn form/format/bỏ useRef | Full E2E/build PASS |
| src/features/acquisitions/acquisitionSchema.ts | Trước: status M, nội dung diff trống | Không ghép vào commit tính năng khi diff trống |
| src/features/intake/ShorthandIntakePage.tsx | Trộn: format/dán/ngày/flexible; giới hạn dictionary | Unit/E2E PASS; clipboard thật đa browser NOT VERIFIED |
| src/lib/shorthand/intakeRows.ts | Trước: trường tùy chọn | Unit/E2E + backend empty-model test PASS |
| src/lib/shorthand/parseIntakeNotes.ts | Trước: token tiền/năm | Unit PASS; mọi ngữ pháp NOT VERIFIED |
| src/lib/shorthand/learnedDictionary.ts | Hiện tại: whitelist learning | Unit PASS; dormant legacy storage cần kiểm tra riêng |
| src/features/sales/SaleDetailPage.tsx | Hiện tại: UUID recovery/reconciliation | Unit và E2E + DB PASS phạm vi cùng UUID |
| src/lib/paymentRecovery.ts (mới) | Hiện tại: durable UUID | Unit/quota + E2E reload PASS; multi-tab creation race còn giới hạn |
| src/features/sales/SellVehiclePage.tsx | Hiện tại: draft banner đúng trường lưu | Full E2E/typecheck PASS |
| src/features/vehicles/VehicleFormPage.tsx | Hiện tại: revision của form | DB stale edit + build/E2E PASS; mọi UI conflict scenario NOT VERIFIED |
| src/lib/errors.ts | Hiện tại: thông báo edit conflict | DB/typecheck PASS |
| src/lib/formDrafts.ts | Trộn: format; bỏ PII/scrub legacy | Unit/storage PASS |
| src/lib/useFormDraft.ts | Hiện tại: giữ guard cho trường không persist | Unit/E2E regressions PASS |
| src/features/vehicles/VehicleDetailPage.tsx | Trước: actions mobile, bỏ chi phí trùng | E2E/mobile PASS |
| src/styles.css | Trước: actions/title tốc ký | E2E/mobile PASS; tách hunk |
| src/features/showroom/ShowroomPage.tsx | Trước: modal focus/labels/icon name | E2E accessibility PASS phạm vi hiện có |
| src/styles-showroom.css | Trước: reduced motion | Build PASS; computed-style setting runtime NOT VERIFIED |
| src/lib/useDialog.ts | Trước: reusable generic ref | Typecheck/E2E focus PASS |
| src/features/users/UsersPage.tsx | Trước: toast/banner | E2E PASS |
| src/features/users/components/CreateUserModal.tsx | Trước: gọn text/accessibility | E2E PASS |
| src/features/users/components/StaffSettingsModal.tsx | Trước: toast/accessibility | E2E PASS |
| src/lib/api.ts | Trộn: purge/sweep API; RPC log giảm dữ liệu | Typecheck PASS; purge hosted NOT VERIFIED |
| src/types/index.ts | Trước: purged_at | Typecheck PASS; cùng nhóm purge |
| supabase/functions/manage-users/index.ts | Trộn: purge/sweep; failure result fix | Unit handler PASS; Deno/hosted NOT VERIFIED |
| supabase/migrations/20261005001000_staff_trash_purge.sql (mới) | Trước: purged_at | Migration replay PASS; Auth/profile atomicity NOT VERIFIED |
| supabase/migrations/20261005001100_optional_shorthand_vehicle_fields.sql (mới) | Trước: empty model/unknown cost | Migration replay + RPC actual backend audit PASS; unknown cost vẫn chặn bán |
| supabase/migrations/20261005001200_transaction_conflict_guards.sql (mới) | Hiện tại: post-lock role/revision checks | Migration/full DB + concurrency PASS phần đã sửa |
| tests/e2e/business-flows.spec.mjs | Hiện tại: committed-response-loss/reload reconciliation | Full E2E PASS |
| tests/e2e/shorthand-intake.spec.mjs | Trước: format và flexible entry | E2E PASS |
| tests/e2e/ux-convenience.spec.mjs | Trước: expense locator/focus/mobile/showroom | E2E PASS |
| tests/unit/shorthandIntake.test.ts | Trộn: flexible và whitelist privacy | Unit PASS |
| tests/unit/ux-storage.test.ts | Hiện tại: privacy expectations/legacy scrub | Unit PASS |
| tests/unit/manageUsersFailure.test.ts (mới) | Hiện tại: Edge failure reproduction | Unit PASS; không phải Deno runtime |
| tests/unit/paymentRecovery.test.ts (mới) | Hiện tại: UUID only/quota | Unit PASS |
| tests/db/concurrency-audit.mjs (mới) | Hiện tại: release diagnostic gate | 11 PASS / 3 FAIL; giữ nguyên failure |
| docs/WORKSPACE_CONCURRENCY_REVIEW.md (mới) | Hiện tại: báo cáo thay thế baseline cũ | Tài liệu, không chứng minh runtime |

### Generated artifacts, config và secrets

.env.local, dist/index.html và test-results/.last-run.json được git check-ignore xác nhận ignored. Không có package/dependency/config thay đổi trong danh sách diff hiện tại. Migration mới chưa được deploy. Lint/tsconfig bỏ Edge functions nên kết quả app xanh không phủ code Deno.

Scan các dirty/untracked text cho private-key PEM, sb_secret và JWT live-token pattern không có candidate được phát hiện; không in giá trị nhạy cảm. Đây là scan giới hạn, không thay secret scanner toàn repo/history hoặc chứng nhận không có secret. Không đưa .env, ảnh/log test hay database disposable vào commit. Git diff --stat chỉ tính tracked diff; untracked code vẫn đã được build/tests dùng qua import.

### Cách chia commit đề xuất (chưa thực hiện)

1. UI/accessibility: showroom, modal users, useDialog, reduced motion và hunks tests tương ứng; toast/gọn text có thể tách riêng.
2. Vehicle detail mobile actions + CSS/expense locator.
3. Format/gọn thu xe: AcquisitionFormPage, input/helper/exports, parse và CSS/hunks tốc ký; giữ imports và tests đồng bộ.
4. Flexible shorthand fields: migration 011 + intakeRows + UI/tests liên quan. Backend coverage mới phải đi cùng.
5. Failure recovery/privacy: paymentRecovery, SaleDetailPage, drafts/dictionary/banner, API log và unit/E2E tương ứng. Tách hunk những file trộn.
6. Transaction conflict guards: migration 012, VehicleFormPage/errors + audit tests. Không để caller UI và RPC migration tách thành bản phát hành thiếu nhau.
7. Purge: migration 010, Edge, type/API hunks và handler test giữ nhóm riêng; chưa đủ hosted verification để ghép vào production release.
8. Audit/PWA test và báo cáo. Audit script vẫn phải hiện FAIL cho ba rủi ro chưa giải quyết.

Không dùng git add . cho workspace này. Phân loại theo hunk và dependency giữa các nhóm; không sửa/xóa thay đổi cũ để làm commit sạch.

## 8. Điều kiện trước phát hành

- Chốt định danh receipt hoặc quy trình đối soát nhiều thiết bị, kiểm chứng hai request key độc lập không thu trùng cùng chứng từ mà vẫn cho phép các khoản tiền thực sự riêng biệt.
- Bổ sung idempotency/recovery cho acquire_vehicle khi xe không có số khung, gồm test mất phản hồi sau commit trên luồng thu thường và tốc ký.
- Bổ sung conflict guard/caller cho sửa hạn thanh toán và kiểm tra các màn sửa thông tin khách/hạn nợ còn lại.
- Kiểm tra Deno/hosted purge, race restore/purge và failure rollback liên hệ Auth/profile; giữ feature này riêng khi chưa xác minh.
- Chạy ma trận timeout/slow network/session-expiry/blocked Auth storage và nâng cấp SW giữa hai phiên bản trên môi trường test; kiểm tra thiết bị thật khi yêu cầu tương đương production.
- Review từng nhóm Git, chạy lại suites phù hợp trên chính tập commit dự kiến. Các kết quả hiện tại áp dụng toàn workspace, không tự chứng minh từng tập commit con đều hoạt động độc lập.

Không tự phát hành khi audit gate còn FAIL. Các mục NOT VERIFIED giữ nguyên nhãn, không chuyển thành PASS theo suy luận.
