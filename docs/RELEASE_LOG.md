# Release log 2026-10-17 — production write + backup overhaul

Tài liệu này KHÔNG nằm trong `SOURCES` của `scripts/build-knowledge-seed.mjs`, nên sửa nó
KHÔNG đòi hỏi reseed `knowledge_base` và KHÔNG sinh thêm migration đang chờ áp production.
 Muốn trợ lý AI đọc được nó thì phải thêm vào `SOURCES` rồi chạy `npm run knowledge:seed`
 (tức là tạo một migration mới — chỉ làm khi chủ cửa hàng đồng ý đợt áp production kế tiếp).

## 1. Ghi vào production (đã áp, đã xác minh)

| Việc | Kết quả |
|---|---|
| Điểm lùi trước khi ghi | `backups/carem-prod-2026-10-17-210048` (53 file SHA-256, 49 ảnh Storage) |
| `db push --dry-run --include-all` | Liệt kê đúng 7 migration chờ, không thừa cái nào |
| `db push --include-all` | Áp 7/7, exit 0 |
| Ledger sau áp | `Remote database is up to date` |
| Edge Function | `bank-webhook` deploy lại (thêm CORS + xử lý `OPTIONS`), exit 0 |
| Vercel | Build 44s, alias `https://xemaycarem.vercel.app`, exit 0 |
| Smoke production | `node scripts/smoke-production.mjs` → 13/13 PASS |

7 migration đã áp: `20261016000300` memo gọn · `20261017000000` phát lại mã ngay khi đổi
thông tin · `20261017000100` nhóm bộ lọc đối soát · `20261017000300` cổng bằng chứng xác nhận
thủ công · `20261017000400` khóa + duyệt theo chủ · `20261017000500` công khai chi phí nhân
viên · `20261017000600` thông báo chi phí xe.

Bằng chứng đo trực tiếp trên database production sau khi áp:

```
list_bank_transactions     -> has_attention=true has_history=true has_received=true
create_vietqr_payment_req  -> has VIETQR_REPLACE_REQUIRED + exemption (v_replace IS NOT NULL)
record_vietqr_bank_credit  -> has PENDING_OWNER_APPROVAL
OPTIONS /functions/v1/bank-webhook -> 204, allow-origin *
GET   /functions/v1/bank-webhook    -> 200 {"status":"CONFIGURED"}, allow-origin *
POST  không chữ ký                  -> 401 UNAUTHORIZED (ranh giới tiền còn nguyên)
```

Ba lỗi người dùng báo đã hết: trang Đối soát mở được; đổi số tiền trên mã QR không còn kẹt
60 giây; nút "Kiểm tra kết nối" không còn kích màn "mất WiFi" (thủ phạm là thiếu CORS
header cho trình duyệt, không phải hỏng kết nối).

## 2. Thay đổi nghiệp vụ cần chủ cửa hàng biết

`confirm_bank_transaction` sau cổng mới **chỉ** nhận `REFERENCE_AMOUNT_MATCH` và
`PENDING_OWNER_APPROVAL`. Khoản gán tay (`MANUAL_LINK`) trước đây bấm "Xác nhận thu tiền"
là ghi được, **nay bị từ chối** và phải đi đường "Thu tiền" trên đơn bán, có chủ/quản lý
đối chiếu sao kê rồi mới ghi sổ.

## 3. Sao lưu: worker trước đó chết âm thầm

Task `Carem CRM - daily production backup` đã đăng ký và chạy đều 21:30, nhưng **luôn trả
kết quả 1** và **không tạo ZIP nào từ 09/10**. Nguyên nhân không nằm ở sao lưu: PowerShell
5.1 giải mã stdout của node theo bảng mã console, làm vỡ tên thư mục tiếng Việt
`Nội dung bản sao lưu` → `Test-Path` thất bại → `backup-export` chết.

Đã sửa và đo lại:

| | Trước | Sau |
|---|---|---|
| Kết quả chạy thật của worker | `1` | `0`, ZIP 58 entry, 13.5 MB |
| Giờ chạy | 21:30 | 01:00 hằng ngày + `StartWhenAvailable` |
| Tên ZIP trên đĩa | không có | `Cà Rem - Sao lưu dữ liệu và ảnh xe - 17-10-2026 lúc 22h04m31s.zip` (có dấu, kiểm bằng so khớp chuỗi, không đọc console) |

### Lỗi ẩn thứ hai: `docker info` treo làm worker chết lặng

Sau khi sửa bảng mã, công nhân vẫn có thể chạy mà **không ghi nổi một dòng log**. Nguyên
nhân: `backup-daily.ps1` gọi `docker info` để probe Docker **không có thời gian chờ tối
đa**. Khi Docker Desktop "sống giữa chừng" (engine liệt nhưng named pipe còn chấp nhận kết
nối), lệnh đó treo vô hạn → script dừng ngay trước dòng log đầu tiên → Task Scheduler báo
`Running` cho tới hạn 2 giờ rồi chết lặng → **đêm đó không có bản sao lưu nào, và không ai
biết**. Mã lỗi `0xC00002E2` xuất hiện khi một lần đá tiếp theo va phải instance đang treo.

`Test-DockerEngine` nay chạy `docker` qua `System.Diagnostics.Process` với
`WaitForExit(25000)` và `Kill()` khi quá giờ. Không dùng `Start-Job`: bằng chứng thật là
`Start-Job` bị chặn ở một số môi trường ("Access is denied"), mà dùng nó thì lỗi biến thành
"probe trả false" — tức là làm hỏng worker theo cách im lặng hơn cả lỗi đang sửa.
Kết quả đo trên máy này: `EXITED=True EXITCODE=0 ELAPSED_SEC=0.5`; chạy lại công nhân
toàn trình → `RESULT=0x00000000`, log dày thêm 310 dòng, ZIP `23h48m57s` tạo lúc 23:52.

Mỗi bản sao lưu từ nay kèm `requiredSecretNames` (24 biến, rút thẳng từ `Deno.env.get`
trong mã nguồn Edge Function, nên không bao giờ chứa giá trị): `BANK_WEBHOOK_SEPAY_SECRET`,
`BANK_WEBHOOK_SEPAY_API_KEY`, `BANK_WEBHOOK_CASSO_TOKEN`, `BANK_WEBHOOK_CASSO_SECRET`,
`BANK_WEBHOOK_TOKEN`, `BANK_WEBHOOK_HMAC_SECRET`, `PUSH_SWEEP_TOKEN`, `VAPID_PRIVATE_JWK`,
`AI_PROVIDER_API_KEY`, `GEMINI_API_KEY`… — tức là dựng project mới mà không phải đoán thiếu gì.

## 4. Khôi phục giờ mới được kiểm chứng thật

Bước chạy thử khôi phục từng FAIL vì `pg_cron`: công cụ dò schema mà extension được cài
vào (`WITH SCHEMA "pg_catalog"`), nhưng `pg_catalog` là schema lõi mà **mọi** dump đều tham
chiếu → luôn kết luận "không an toàn để bỏ qua". Nay dò theo schema thật chứa đối tượng
của extension (`pg_cron`→`cron`, `pg_net`→`net`, `supabase_vault`→`vault`).

Kết quả đo: **PASS** — schema replay vào PostgreSQL tạm, 31 INSERT doanh nghiệp, **14 bảng
khớp số dòng với MANIFEST**, 218 hàm, RLS bật, và kê rõ extension đã bỏ qua.

Cũng kiểm lại luôn một nghi oan: `backup-verify` **có** trả exit code 1 khi FAIL (thử bằng
`--set` trỏ vào bản hỏng → exit 1). Kết luận "cổng báo láo" nêu trước đó là **sai**, do đọc
nhầm JSON của bản khác.

## 5. Bộ dựng lại (rebuild kit) mới trong mỗi bản sao lưu

- `00 - ĐỌC TRƯỚC - Cách dựng lại web từ bản sao lưu.md` — 7 bước dựng project mới.
- `06 - Bộ dựng lại hệ thống (cấu hình, cron, tên secret).json` — `system_settings` (số tài
  khoản nhận, cờ webhook), extension, publication Realtime, lịch pg_cron, function đã deploy,
  `requiredSecretNames` (rút từ `Deno.env.get` trong mã nguồn, không đọc giá trị), tên env frontend.

Quy tắc đặt tên: **không đổi tên bộ gốc** `carem-prod-*` vì đó là hợp đồng để script khôi
phục tìm file và vì 18 điểm lùi cũ đang sống nhờ nó. Việc "tên dễ hiểu" nằm ở ZIP và ở
`docs/BACKUP_FILES_GUIDE.md` (mục lục mọi loại file trong `backups/`).

## 6. An toàn: token nằm sẵn trong data.sql (PHÁT HIỆN, chưa xử lý xong)

`PUSH_SWEEP_TOKEN` được nhúng trong câu lệnh của hàng mục `cron.job`. `pg_dump --data-only`
sao lưu cả schema `cron`, nên **mọi bản backup từ khi bật pg_cron (sau 15/10) chứa token đó
dưới dạng văn bản thuần**, gồm các ZIP ngày 17/10.

Đã làm: `rebuild-kit.json` nay tẩy mọi `Bearer/Password/Key/Token` và chuỗi opaque ≥ 40 ký
tự; thêm cổng tự hủy bản backup nếu còn sót; xóa bản kit nhiễm đầu tiên (`215214`) và thư mục
staging sót lại; cách ly bản `215214` bằng cách xóa MANIFEST để không công cụ nào coi nó là
điểm khôi phục. Đã xác nhận token **không** nằm trong git.

**Còn nợ chủ cửa hàng**: đổi `PUSH_SWEEP_TOKEN` (và cập nhật câu lệnh cron tương ứng), vì nó
đã bị sao lưu nhiều lần. Sửa hướng dẫn ở mục 5 của `HUONG-DAN-KHOI-PHUC.md` để nhắc điều này
khi dựng project mới.

## 7. Quyết định: KHÔNG làm bản sao lưu "gọn"

Ý định "bỏ dữ liệu không cần thiết cho nhẹ" đã cân nhắc và **bác** lần này: bản ZIP đầy đủ chỉ
13.5 MB (≈ 400 MB/tháng, nằm gọn trong hạn mức Drive miễn phí), trong khi cắt bớt `data.sql`
sẽ tạo ra một ZIP **không khôi phục được đầy đủ** mà vẫn mang tên trông như bản sao lưu hoàn
chỉnh — đánh đổi nhiều rủi ro hơn lợi ích. Nếu sau này cần bản gọn, phải là file riêng biệt,
tên khác hẳn, và nội dung nêu rõ "không dùng để khôi phục".

## 8. Việc còn mở

- Đổi `PUSH_SWEEP_TOKEN` (mục 6) — nó đã bị sao lưu vào `data.sql` nhiều lần từ 15/10.
- Xác minh lần chạy 01:00 **đầu tiên tự động** sáng mai có ghi đủ log và tạo ZIP
  (mọi lần hôm nay đều do tôi đá tay; lịch 01:00 đã đăng ký lại từ đầu nên không còn
  cấu hình hỏng do sửa tại chỗ).
- Khai đường Google Drive vào `backups/offsite.txt` để ZIP tự chép ra nơi thứ hai — hiện chỉ
  có dòng chú thích nên hệ thống không tự chép được.
- `verify-prod-replay.mjs` đã **hỏng thời hiệu**: hardcode bộ migration `026–031` và baseline
  ngày 02/10, chạy hôm nay chỉ khẳng định quá khứ. Cần viết lại hoặc xóa khỏi tài liệu cổng.
- Bản `20261017000200` và việc bật `pg_cron` đã được áp trên production **trước** phiên này,
  không qua các bước ở tài liệu này → nên thống nhất một đầu mối ghi production.
- Quyết định **không** làm bản sao lưu "gọn" (mục 7) — cần bản gọn thật thì phải là file riêng,
  tên khác hẳn, ghi rõ "không dùng để khôi phục".
