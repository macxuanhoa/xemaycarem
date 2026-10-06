# CRM reliability remediation — 06/10/2026

## Kết luận

**NO-GO cho production toàn diện.** Năm FAIL gốc đã có biện pháp chặn/sửa và regression local; quyết định phát hành còn cần chứng minh hosted gateway/Auth, quy trình chứng từ thực tế, backup/restore, staging drift và rollback đã triển khai. Không dùng test local xanh để suy ra production-ready.

Đây là phần tiếp theo của [audit gốc](CRM_RELIABILITY_MASTER_AUDIT.md). Bằng chứng gốc giữ làm lịch sử; các kết luận FAIL/NOT VERIFIED trong đó được cập nhật theo báo cáo này và [kiểm chứng môi trường](RELEASE_ENVIRONMENT_VERIFICATION.md). Chỉ chạy local với dữ liệu giả và PostgreSQL disposable. Không stage, commit, push, deploy, reset/revert, xóa dữ liệu production hoặc gửi thông tin tới khách hàng.

## 1. Root cause và xử lý

| FAIL gốc | Nguyên nhân đã xác minh | Xử lý và giới hạn |
|---|---|---|
| Thu xe legacy thiếu UUID | Public wrapper rơi về impl khi thiếu key; frame trống sinh GEN mới mỗi retry | Migration009 bắt buộc UUID; batch phải có envelope UUID/rows. Missing key trả CLIENT_UPGRADE_REQUIRED trước ghi. UUID giữ qua timeout/reload; receipt/result cùng transaction. Internal batch dùng private impl dưới receipt của batch, không tạo UUID mới từng retry. |
| Hạn nợ thiếu version | Overload hai tham số vẫn ghi, hai form cũ được chấp nhận | Overload cũ từ chối; overload ba tham số khóa sale, kiểm tra revision và monotonic updated_at. Một writer thắng; form thua nhận conflict, không tạo audit ghi đè. |
| Chi phí thiếu version | expected_updated_at là tùy chọn khi edit; client cũ bypass OCC | Migration009 bắt buộc revision cho cả chi phí xe và cửa hàng khi edit, kiểm tra sau locks/role/status. Tạo mới vẫn đúng nghiệp vụ; tổng giá vốn và sale snapshot được kiểm tra. |
| Một khoản thu hai mã độc lập | UUID chỉ định danh request, không định danh tiền thực nhận | Migration011 thêm proposal PENDING không có tác động tài chính. Chứng từ canonical theo loại/tài khoản hoặc sổ/mã dùng chung chống trùng giữa UUID, actor và sale. Quản lý xác minh tiền/chứng từ/toàn bộ ledger trước ghi. Approval và ledger/audit cùng transaction; receipt cố định payment UUID. Thiếu bằng chứng phải đối chiếu thủ công, không tự ghi. |
| Job kẹt PROCESSING | Claim chỉ QUEUED, thiếu expiry/token; finish/fail/skip không fenced; MOCK sinh ID random | Migration010 lease120s, token+actor, renew, bounded retries/total attempts và audit. MOCK kết quả cố định theo job UUID. Worker cũ từ chối; unknown legacy delivery FAILED/manual review, không blind resend. Giao diện có kiểm tra/khôi phục và lưu kết quả đối chiếu provider. Không có unattended scheduler/provider thật được chứng nhận. |

### Các lỗi bổ sung tìm được khi sửa

- `save_vehicle` tạo tồn kho cũng thiếu receipt: cùng payload/frame trống tạo hai vehicle/cost. Migration012 bắt buộc UUID cho **create**, giữ nghiệp vụ create không thêm acquisition/payment; UI dùng recovery hiện có. Edit giữ nguyên guards.
- Request thứ hai trùng chứng từ có thể trả canonical receipt ID khác request UUID. Thêm private actor/request alias + fingerprint cùng transaction và lookup `get_payment_receipt_request`; mất phản hồi/reload vẫn tìm đúng receipt, không lưu tài chính vào localStorage.
- Unique-index race khi binding chứng từ được chuyển thành conflict rõ ràng. Chặn loại BANK_TRANSACTION trái BANK_TRANSFER và CASH_VOUCHER trái CASH.
- Đề nghị nhập sai có thể được manager từ chối rồi lập mới với cùng chứng từ chưa ghi; proposal/audit cũ giữ nguyên, retry mã cũ không hồi sinh.
- New frontend đối soát UUID tài chính còn lưu từ client trước migration bằng ledger trước khi tạo proposal; pending controls bị khóa trong lúc lưu.
- Native Deno phát hiện JSON null gây framework500: validate body object/string/UUID, malformed400 không claim.

### Điều khoản nghiệp vụ của khoản thu

STAFF gửi đề nghị; chỉ OWNER/MANAGER xác minh và ghi tiền mới. Đây là thay đổi quyền ghi cần thiết để có bước xác minh khi chứng cứ không đủ; không thay quyền xem sổ công nợ, giá bán, payment balance, cancellation hay sale snapshot. Mọi actor hợp lệ có thể replay receipt đã ghi; không tạo khoản thu thứ hai.

Hai khoản thật cùng tiền/ngày với hai chứng từ khác nhau được chấp nhận. Không dùng uniqueness số tiền/ngày để đoán trùng. Không backfill, đổi hoặc vô hiệu lịch sử tài chính cũ.

**Chưa chứng minh tiền thực nhận:** account scope/reference do con người nhập; đổi scope hoặc lập hai biên bản khác nhau cho cùng tiền vẫn cần quản lý kiểm tra. Initial/historical payments chưa gắn global physical identity; phải đối chiếu ledger cũ. Một bank transfer phân bổ cho nhiều sale chưa có allocation contract, phải xử lý thủ công; không bịa reference để vượt guard. Quy trình này cần cửa hàng nghiệm thu trước GO.

## 2. Regression mới và bằng chứng

| Bộ mới | Kết quả local | Nội dung |
|---|---:|---|
| mandatory-write-protocol | 12 PASS | Legacy/no-key/no-version denied/no writes; acquisition lock wait + commit/lost reply; batch race/fault rollback; due/expense OCC races; totals/snapshots/ACL |
| inventory-creation-receipts | 5 PASS | Keyless inventory denied; keyed same-frame-less commit replay; changed payload conflict; no invented acquisition/payment; direct/private denial |
| payment-receipts | 10 PASS | Evidence/method guards, independent keys/actors, concurrent approvals, committed retry, legitimate equal payments, unknown evidence manual review, late trigger rollback |
| payment-receipt-security | 12 PASS | Cross-sale conflict, actual index waits, role revoked while blocked, overpay/cancel races, actor alias recovery, rejected correction, immutable history/ACL |
| message-leases | 12 PASS | Real claim lock waits; crash before/after send; finish committed/lost reply; stale token; bounded attempts; manual evidence and finance invariants |
| worker/provider unit | 9 PASS | Actual handler/provider via test VM; deterministic MOCK, failed finish, malformed input, fenced arguments |
| Native Deno worker | 5 PASS | Actual process kill after claim commit, HTTP concurrency, real SDK/native SQL, all finish replies lost, malformed input before claim |
| Upgrade/DDL rollback rehearsal | 17 PASS | Populated schema008 →009/010/011/012/014; fault before each COMMIT rolls back DDL/history; legacy/new signatures, roles and ledger |

Concurrent tests use independent native PostgreSQL sessions and observe real lock waits. Faults include SQL triggers after partial work, committed result with discarded/aborted HTTP response, 503 before mutation, process kill and stale lease/token. No unsafe result is accepted as PASS, and no scenario/test is skipped or removed.

## 3. Toàn bộ quality gates

Build mới nhất sau thay đổi CSS lúc 10:56 có entry `index-_lMFDL5p.js`, 62 precache entries. Đã xây dựng lại, chạy lại unit/PWA và full E2E trên stylesheet mới; không dùng kết quả artifact cũ làm chứng nhận cho artifact mới. Logs bền vững ở `C:/Users/Admin/AppData/Local/Temp/carem-audit-01a10c9a-20261006/`, không dùng test-results dễ bị Playwright dọn làm bằng chứng duy nhất.

| Gate | Kết quả |
|---|---|
| Lint | PASS, exit0 |
| Typecheck | PASS, exit0 |
| Production build | PASS, exit0; annotation warnings từ Zod không làm fail build |
| Unit | 360 PASS /35 files |
| Native database/integration/RLS | PASS214 behavioral check groups +9 migration/schema assertion groups, exit0; bao gồm30 integration và real concurrency |
| CORE reliability audit | 16 PASS /0 FAIL |
| EXT reliability audit | 22 PASS /0 FAIL |
| Knowledge | PASS, 186 sections; seed mới014; không sửa seed038/008 |
| Full E2E + compatibility bổ sung | Vòng artifact cũ111/111 PASS; bổ sung legacy ledger UUID1/1 PASS; đang chốt full112 trên artifact mới |
| Preview4173 PWA thực | PASS: manifest/icons/installability, SW control, static cache/no API response cache, mobile/desktop, offline shell→online, không runtime error |
| PWA hai artifact thật | PASS trên mobile Chromium: old index-CtqUJ7nL→latest index-_lMFDL5p, waiting giữ input, update có chủ động, offline/online/no API cache |
| PWA worker byte-upgrade harness | PASS; asset/schema coupling ngoài phạm vi riêng của harness này; actual asset upgrade kiểm tra bằng script riêng, hosted coupling vẫn NOT VERIFIED |
| Native strict Edge check | PASS4 module graphs +7 raw HTTP configurations |

E2E Auth transport giả đi vào PostgreSQL thật không được gọi là hosted JWT verification. Khi cập nhật tests cũ: fixtures thêm UUID/version/manager verification đúng protocol; accounting và audit assertions giữ. Staff collection được kiểm tra **không đổi số dư trước approval**, rồi owner approval mới đổi công nợ. Hai test recovery proposal vẫn kiểm tra đúng một đề nghị; có test riêng làm mất phản hồi của actual add_payment sau financial COMMIT. Workflow review chờ editor đóng trước điền label dùng chung, có assertion giá trị và button enabled; không thay validation để làm xanh test.

## 4. NOT VERIFIED và manual release gates

| Phần | Cách kiểm chứng còn cần |
|---|---|
| Hosted JWT/gateway/GoTrue, function parity | Staging Supabase riêng, JWT thật, named PostgREST overloads, auth refresh/revoke, mọi Edge function; native Deno không thay full stack |
| Thiết bị Android/iOS thật | Cài/update PWA; foreground/background, mất điện/tab kill, offline/reconnect và giữ operation key; Chromium mobile là môi trường tương đương có giới hạn |
| Evidence/manager workflow thực tế | Cửa hàng chốt mã account/register dùng chung, phiếu thu/biên bản, phân bổ đa-sale, đối soát initial/historical ledger và nghiệm thu STAFF proposal→manager approval |
| Provider thật | Chỉ bật sau có idempotency/delivery query/fencing contract và staging crash-after-send proof; hiện MOCK/DISABLED |
| Unattended worker recovery | Chưa có scheduler chạy nền được chứng nhận; hiện manager trigger recovery trên UI. Nếu muốn tự chạy, cấu hình runner được auth đúng và kiểm tra lease/manual-unknown paths |
| Production drift và data scale | Staging clone đã scrub, actual migration versions/overloads, normalized frame duplicates, constraints, lock time/statement timeout trên dữ liệu lớn |
| Backup restore/rollout/rollback | Backup mới theo release, restore rehearsal riêng, deployment smoke/CDN/SW cache parity và rollback tương thích backend mới. Không chạy destructive proof trên production |

## 5. Thứ tự triển khai và rollback

1. Xác nhận baseline/schema thực tế và backup có thể restore; xử lý duplicate chassis thủ công nếu migration004 còn chưa áp. Toàn bộ migrations trước009 là dependency của bản sửa mới, không chỉ copy009–014.
2. Maintenance window: chặn thao tác ghi mới bằng cách vận hành được kiểm soát, đợi giao dịch đang chạy, thông báo phiên bản cũ/PWA phải refresh. Cached legacy UI có thể hiện lỗi validation chung; server vẫn deny an toàn.
3. Áp các migration chưa áp theo thứ tự đến008, rồi009 →010 →011 →012 →014. Từng migration ACID; rehearsal failure trước COMMIT giữ nguyên dữ liệu. Giữ job delivery unknown ở manual review.
4. Deploy Edge worker tương thích token sau010 và frontend mới sau011/012; reload PostgREST schema cache theo quy trình staging đã kiểm tra. UI mới trên schema008 **không tương thích** proposal/lookup; không frontend-first.
5. Staging/hosted smoke bằng tài khoản test: current protocol và cached old clients, sale/receipt/due/expense conflicts, refresh/recovery, no-bypass ACL, financial/history invariants. Chốt bằng chứng NOT VERIFIED trước mở ghi lại.

Sau migration đã commit, **không rollback về frontend/worker cũ có write protocol yếu**, không DROP receipt/alias/lease tables, không khôi phục bypass. Roll back presentation chỉ tới build tương thích schema mới; còn lỗi cần forward-fix giữ toàn bộ receipt/finance/audit. Backup restore sau đã có giao dịch mới cần reconcile giao dịch phát sinh và kế hoạch downtime, không reset database để thử. Rollback deployed chưa được diễn tập trên staging nên NOT VERIFIED.

## 6. Git workspace và dependency giữa các phần

HEAD giữ `906ff67ba8ca6715f39999460ffcfbb3893eedf8`. Baseline trước vòng này: 39 modified/32 untracked; vòng này mở rộng code/tests/docs. Index vẫn trống; không stage/commit/push/deploy. Danh mục và SHA256 ở manifest companion và bản temp lưu trước chốt. Không xóa/revert thay đổi từ yêu cầu trước, không sửa verified snapshot files.

| Nhóm | Thay đổi / phụ thuộc |
|---|---|
| Yêu cầu UI trước | Thu/thanh toán inputs, shorthand parser, clipboard/date, toast staff, mobile vehicle actions, modal accessibility, showroom reduced-motion, docs UI; cùng UI/E2E/unit fixtures. Giữ toàn bộ; không tách file mixed chỉ bằng tên file. |
| Master audit trước | Auth/storage/privacy; durable operation/payment keys; due/expense revisions; canonical chassis/acquisition locks; migrations001–008 và diagnostics/recovery tests |
| Remediation hiện tại | Migrations009/010/011/012/014; manager receipt UI; worker lease/fencing; inventory durable-create; alias/old-key recovery; native Edge/PWA/rollout verification |
| File mixed | SaleDetailPage, VehicleFormPage, operationRecovery, errors, test-db, operational-features, business-flows/workflows và generated knowledge: review từng hunk, giữ source+RPC+migration+regression cùng contract |
| Provenance chưa độc lập chứng nhận | Các dirty hunks DocsPage/CopilotPage/Copilot shelf/stylesheet giữ từ workspace hiện tại; full regression chỉ chứng minh behavior đã chạy, không chứng minh tác giả hoặc approval của một partial commit |

Các file sửa/thêm hiện tại được liệt kê đầy đủ trong `CRM_RELIABILITY_WORKSPACE_MANIFEST.md`. Không gom toàn workspace thành commit production chỉ vì gate local xanh. Nếu sau này chia commits, mỗi snapshot chia phải được chạy gates tương ứng; không suy kết quả combined workspace cho subset commit.
