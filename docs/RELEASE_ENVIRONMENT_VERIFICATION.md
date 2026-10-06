# Kiểm chứng môi trường và tương thích phát hành — 06/10/2026

## Phạm vi và quyết định

Đây là bằng chứng bổ sung cho vòng xử lý các FAIL của `CRM_RELIABILITY_MASTER_AUDIT.md`. Kiểm chứng chỉ chạy local, PostgreSQL tạm và dữ liệu giả. Không đọc customer/account thật, không gửi tin nhắn, không dùng thông tin đăng nhập production, không thay đổi Git index hoặc triển khai.

**Local migration và native Deno đạt trong phạm vi bên dưới. Production GO vẫn phụ thuộc các kiểm chứng hosted, backup/restore và thiết bị chưa có bằng chứng.** Báo cáo production cũ có các mốc ngày 02–03/10; những mốc đó không chứng minh nguồn code, migration hoặc backup mới ở ngày 06/10.

## 1. Edge Functions / Deno

### Môi trường thực sự đã dùng

- Deno/Supabase CLI không có trên PATH. Docker CLI có nhưng daemon không chạy: Docker báo không tìm thấy pipe `dockerDesktopLinuxEngine`.
- [Supabase native stack không hỗ trợ Windows](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes); cần Docker trên máy này. Không giả lập managed gateway rồi ghi nhận như full local Supabase PASS.
- Tải binary Deno Windows từ bản phát hành chính thức vào thư mục temp; kiểm tra SHA256 khớp checksum chính thức và release asset digest trước khi chạy. Không thêm package, dependency, lockfile hoặc Node modules cho dự án.
- Runtime dùng: Deno **2.9.7**, V8 **15.0.245.2-rusty**, TypeScript **6.0.3**. Đây là native Deno, không khẳng định chính là phiên bản Supabase hosted Edge Runtime hiện dùng.
- `scripts/check-edge-native.mjs` tạo cấu hình strict/cache riêng, `nodeModulesDir:none`, `--no-lock`; môi trường process bỏ toàn bộ credential ứng dụng. HTTP smoke chỉ dùng key giả và hạn chế mạng. Raw handlers dùng Deno.serve thực sự, không thay Deno bằng shim.

### Kết quả

| Kiểm chứng | Kết quả / giới hạn |
|---|---|
| Native strict typecheck `manage-users`, `process-message`, `ai-assist`, `reset-owner` | **PASS**, toàn bộ bốn module graph gồm provider/contracts |
| Native HTTP startup, OPTIONS, GET405, POST thiếu cấu hình503/thiếu auth401, no-store | **PASS**, 7 cấu hình chạy process thật tuần tự |
| Worker có auth transport giả → native PostgreSQL qua SDK thật | **5/5 PASS**: JSON shape sai trả400 trước claim, lease contracts, hai HTTP requests đồng thời, kill process sau claim commit rồi restart/expiry, mất mọi phản hồi finish sau commit vẫn một SENT/audit và retry không resend |
| CORS allowlist của manage-users | **PASS** allowed origin có header chính xác; origin khác không có header |
| Retired reset-owner | **PASS** HTTP410, không thay đổi account |
| Supabase Edge Runtime gateway/verify_jwt thực tế | **NOT VERIFIED**: không có runtime stack/gateway hoặc staging credential |
| Hosted GoTrue refresh/rotation, Auth Admin/profile compensation, deployed function parity | **NOT VERIFIED**: native smoke không được gọi là hosted Auth test |
| Gửi tin tới provider thật, provider delivery reconciliation | **NOT VERIFIED** và chưa được bật; provider hiện chỉ MOCK/DISABLED |

Chạy lại với binary Deno đã có: đặt `DENO_BINARY` tới executable và `DENO_DIR` tới cache ngoài repo, chạy `node scripts/check-edge-native.mjs`. Script không đọc `.env.local` và không cần secret.

`node scripts/check-worker-native.mjs` chạy raw process-message bằng Deno và SDK npm pinned thật, gateway HTTP loopback với auth user giả, RPC đi vào các connection PostgreSQL độc lập. Test kill process thật khi gateway đã commit claim nhưng chưa trả phản hồi; không chỉ đổi status rồi giả lập process chết. Fault finish commit ngắt mọi phản hồi transport của RPC đó để buộc browser/worker nhận unknown outcome; database SENT và một MESSAGE_SENT audit vẫn giữ đúng. Đây là runtime/RPC integration thật với synthetic Auth transport, không phải chứng minh chữ ký JWT/GoTrue/gateway managed.

Sau các tình huống crash/retry, kiểm tra trực tiếp vẫn đúng bốn sale COMPLETED, bốn vehicle SOLD, bốn snapshot, không có payment và tổng giá bán4000 theo fixtures; outbox recovery không tạo sai lệch kho hoặc sổ tiền.

Native regression cũng phát hiện body JSON `null` làm worker dereference và trả framework500. Runtime object/string/UUID guard đã được sửa; `null`, array, numeric ID và ID sai đều trả JSON400, không claim job. Unit và native regression mới giữ kiểm tra lỗi này.

[Deno hướng dẫn tải binary/checksum](https://docs.deno.com/runtime/getting_started/installation/) và [lệnh check](https://docs.deno.com/runtime/reference/cli/check/) hỗ trợ quy trình native này. [Supabase local development](https://supabase.com/docs/guides/functions/development-environment) sử dụng stack/runtime riêng; do đó native Deno smoke không thay thế gateway, Auth hoặc deployed parity.

## 2. Migration và ma trận client/schema

`tests/db/release-compatibility-rehearsal.mjs` chạy **native PostgreSQL**, áp dụng schema tới `20261006000800`, tạo acquisition/sale/initial payment/khoản thu cũ/chi phí/audit thật trong database tạm, rồi nâng cấp các migration mới theo thứ tự.

**17/17 PASS** ở lần chạy gồm 009/010/011/012/014:

1. Baseline cũ có dữ liệu tài chính thực trong database giả, không chỉ schema rỗng.
2. Với từng migration009–012 và014, chèn exception ngay trước COMMIT: toàn bộ DDL, function definitions, columns, constraints, indexes, policies/grants và dữ liệu tài chính/audit được rollback về snapshot trước migration.
3. Áp dụng thật từng migration giữ nguyên mọi row cũ trong vehicles, financials, acquisitions, sales, snapshots, payments, expenses, audit_logs và vehicle_activity.
4. Job PROCESSING từ phiên bản chưa có lease được chuyển FAILED + DELIVERY_OUTCOME_UNKNOWN + yêu cầu đối chiếu. Customer communication cũng FAILED. Không giả định đã/chưa gửi và không tự resend.
5. Receipt thao tác đã commit trước nâng cấp vẫn lookup/replay đúng, không tạo acquisition mới.
6. Caller cũ thiếu key/revision bị chặn tại server trước side effect: acquire/import/inventory creation/due date/expense edit/payment. Signature cũ còn tồn tại để trả lỗi nâng cấp thay vì âm thầm ghi đè.
7. Tạo tồn kho mới có key replay đúng một vehicle/cost/audit, không tự thêm acquisition hoặc payment.
8. Named argument signatures không trùng với default arguments trong các overload đã kiểm tra; anonymous không được ghi và authenticated không được sửa trực tiếp payment_receipts.
9. Proposal thanh toán PENDING không đổi payments/số dư. Owner xác minh tạo đúng một payment; staff replay hoặc UUID khác với cùng chứng từ trả về cùng payment. Khoản thu và sale snapshot trước nâng cấp giữ nguyên.

| Frontend/caller | Schema tới008 | Schema mới009–012 |
|---|---|---|
| Legacy không UUID/revision | Các đường cũ callable nhưng không đạt safety gate; bằng chứng baseline đã có | **Chặn nâng cấp**, không tự tạo operation ID hoặc thực hiện unsafe write |
| Phiên bản keyed intake và versioned due/expense trước vòng này | Hỗ trợ các guarded contracts cũ | Intake/due/expense tương thích; payment thiếu receipt bị chặn nâng cấp |
| Frontend mới có receipt proposal/verification và keyed inventory creation | API mới chưa có: không nên rollout trước backend; lỗi không chứng minh giao dịch chưa commit nếu có mutation cũ khác | Hợp đồng đã kiểm chứng bằng SQL callers và frontend regression riêng |
| Worker cũ không lease token | Claim/finish cũ hoạt động nhưng crash có thể kẹt | Old overload trả CLIENT_UPGRADE_REQUIRED; không được hoàn tất lease mới |
| Worker mới gửi mode và lease token | API mới chưa có: deploy trước schema sẽ lỗi | MOCK/DISABLED hỗ trợ lease/fencing; gateway parity còn NOT VERIFIED |

Đây là tương thích **SQL/RPC contract**, không phải test một PostgREST gateway thật. Schema-cache reload, gateway argument resolution thực tế, JWT chữ ký/expiry và migrated staging snapshot có drift: **NOT VERIFIED**. PostgreSQL tạm dùng Auth/Storage scaffolding của harness; không gọi đó là full Supabase managed environment.

## 3. PWA và thiết bị

Giữ bản build production có sẵn của vòng audit trước trong thư mục temp riêng trước khi build bản mới. `scripts/check-pwa-release-skew.mjs` dùng hai artifact directory thật và yêu cầu entry chunk lẫn worker bytes khác nhau; không chỉ sửa comment service worker để tạo cảm giác hai phiên bản.

| Kiểm chứng | Trạng thái |
|---|---|
| Hai build thật, mobile Chromium, waiting giữ input, người dùng kích hoạt, hashed asset mới, offline/online/no API cache | **PASS** rerun sau bản build có CSS cập nhật10:56: artifact cũ `/assets/index-CtqUJ7nL.js` → artifact mới `/assets/index-_lMFDL5p.js` |
| Preview cổng4173, manifest/installability/static cache/offline | **PASS** artifact CSS mới index-_lMFDL5p: npm test:pwa, no API responses in cache, offline→online/no runtime errors |
| Android/iOS thật: install, process kill, mất pin, storage eviction, camera/keyboard/print | **NOT VERIFIED**, cần thiết bị và matrix thực tế |
| CDN/Vercel rollback sang artifact khác với RPC/schema mới | **NOT VERIFIED**; local artifacts không chứng minh CDN atomic deploy hoặc production rollback |

Script PWA dùng server loopback riêng, không dừng server E2E/preview khác và chặn mọi HTTPS outbound. Nó không đăng nhập production hoặc gửi giao dịch.

## 4. Thứ tự triển khai và rollback

### Thứ tự đề xuất — chưa thực hiện

1. Xác nhận remote migration ledger/target/readiness bằng read-only staging inventory; xác minh pending subset thật. Không áp dụng lại các migration lịch sử có Auth/data updates chỉ vì local có file.
2. Trước canonical-frame index, kiểm tra collisions `upper(trim(frame_number))`; nếu có thì dừng để review. Trước010, kiểm kê PROCESSING chưa lease, provider/outcome và yêu cầu đối chiếu. Trước011, chỉ cho phép user có thẩm quyền xác minh chứng từ; không backfill lịch sử bằng suy luận amount/date.
3. Lấy checkpoint database và Storage mới theo quy trình vận hành; restore vào môi trường test, reconcile counts/totals/snapshots/audit. **Chưa có bằng chứng backup/restore production mới trong vòng này.**
4. Rehearse toàn bộ pending subset trên staging đã ẩn danh, kiểm tra PostgREST cache/grants và native Edge stack. Current local rehearsal chứng minh populated local schema và transaction rollback, chưa chứng minh production drift/load/locks.
5. Giữ write window có kiểm soát. Backend API/guards mới009–012 phải sẵn sàng trước frontend mới. Caller cũ có thể được chặn nâng cấp trong khoảng chuyển phiên bản; điều đó là fail closed có chủ đích, không hạ guard để cho code cũ viết tiền.
6. Deploy process-message tương thích lease sau010; deploy frontend mới sau011/012. Giữ receipt lookup, pending keys và audit trong suốt chuyển phiên bản; yêu cầu các tab/PWA cũ cập nhật khi nhận upgrade error.
7. Canary trên staging bằng dữ liệu giả: one-receipt replay, stale edits, old-client blocks, crash→lease expiry→fenced recovery, unknown legacy delivery review, online/offline. Không chạy chaos tài chính trên production.

### Rollback sau khi migration đã commit

- Exception trong transaction migration: local đã chứng minh rollback toàn bộ DDL và giữ dữ liệu. Đây không phải rollback một release đã nhận các giao dịch mới.
- Không drop payment_receipts/operation_receipts/lease history hoặc đổi payment/audit lịch sử để rollback. Những ID đang pending có thể đã commit và còn cần lookup.
- Frontend rollback về phiên bản không biết receipt/revision chỉ được xem là phục hồi read access hoặc được chặn protected writes. Không khôi phục writer cũ thiếu guard.
- Tắt gọi worker nếu phát hiện runtime mismatch; giữ QUEUED/unknown outcome để đối soát. Không tự coi timeout là chưa gửi.
- Backend áp dụng corrective forward migration giữ guards, receipts và snapshot/history. Restore database phải cân nhắc giao dịch mới và Storage; không dùng down migration hoặc restore mù để xóa lịch sử phát sinh.
- Full deployed rollback/backup restore drill: **NOT VERIFIED**. Cần người vận hành rehearsal artifact + schema + worker tương thích trên staging và ký nhận checkpoint/reconciliation.

## 5. Giới hạn nghiệp vụ còn cần vận hành

Unique business evidence bảo vệ cùng mã chứng từ; UUID độc lập không còn đủ để tự ghi tiền. Khi thiếu bằng chứng, nhân viên tạo proposal và manager đối chiếu trước khi ghi sổ. Hệ thống không thể tự chứng minh hai khoản tiền mặt thực tế là một nếu manager cấp hai chứng từ khác nhau cho cùng tiền; phải kiểm tra sổ phiếu tiền mặt/ngân hàng và khoản thu đang PENDING/đã RECORDED.

Không thay thế xác minh vật lý bằng uniqueness(amount,date). Hai khoản hợp lệ cùng số tiền được phép có hai chứng từ. Initial payment của sale vẫn là phần giao dịch bán atomic, không có registry chứng từ toàn cục của proposal thu nợ; retry của cùng sale được bảo vệ riêng, còn phân bổ một bank transaction qua nhiều sales cần quy trình nghiệp vụ và bằng chứng riêng. Không tự sửa/backfill lịch sử.

**Production hiện tại: NO-GO để tuyên bố toàn hệ thống đã kiểm chứng.** Các gate còn thiếu nằm ở hosted gateway/Auth/Edge parity, staging drift/backup restore, physical-device behavior, deployed rollback và kiểm soát chứng từ ngoài hệ thống. Báo cáo cuối của root tổng hợp kết quả regression và tình trạng các finding, không cộng các test trùng phạm vi thành số lượng invariant độc lập.
