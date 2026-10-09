# Báo cáo tác động: xoá trường xe, đổi "Dòng xe" sang "Loại xe", tẩy lịch sử

Ngày lập: 08/10/2026 (Asia/Ho_Chi_Minh). Phạm vi: migration `20261008000300` và toàn bộ
frontend/Edge/tests đi kèm. Tài liệu này là bước G0 của kế hoạch: mọi con số dưới đây lấy
bằng truy vấn **chỉ đọc** trên database linked và bằng truy vấn `pg_proc`/`pg_constraint`
trên engine disposable đã replay đủ chuỗi migration — không suy đoán từ grep.

## 1. Trạng thái nền tại thời điểm lập báo cáo

- Nhánh: `release/xe-crm-v1`, HEAD `41d433e`.
- Ledger production (read-only `supabase migration list --linked`): áp dụng tới `20261006001400`.
  **Pending local: `20261008000100`, `20261008000200`** (feature xoá vĩnh viễn nhân sự +
  phê duyệt xoá xe của writer khác, chưa push). Migration này xếp sau thành `20261008000300`.
  Kiểm lại cùng ngày: **57 applied / 3 pending / 0 divergent** trên tổng số 60 file local.
- Chuỗi migration local tại thời điểm lập báo cáo replay sạch trên PostgreSQL disposable
  (PGLite/native), exit 0. Chuỗi hiện tại (60 file, chốt ở `20261008000300`) phải được replay
  lại toàn bộ ở giai đoạn G6 trước khi đụng production — kết quả ghi vào `docs/VERIFICATION.md`.

## 2. Đối tượng database phải dựng lại (trích từ `pg_proc.prosrc ~ \m(brand|model|variant|engine_number|odometer|asking_price)\M`)

| # | Hàm | Vai trò | Thay đổi chính |
| - | --- | --- | --- |
| 1 | `private.save_vehicle_impl(p_data, p_id)` | ghi xe | bỏ 6 key, bắt buộc `vehicle_type_id`, bỏ khoá `SOLD_VEHICLE_LOCKED` nhánh asking_price |
| 2 | `private.acquire_vehicle_impl(p_data)` | thu xe → tạo xe | bỏ 6 key, nhận `vehicle_type_id` |
| 3 | `private.import_vehicles_impl(p_vehicles)` | nhập lô | cột CSV mới, thiếu loại xe → `VEHICLE_TYPE_REQUIRED` |
| 4 | `public.validate_import_vehicles(p_vehicles)` | soát lô | bỏ check `asking_price`, thêm check `vehicle_type_id` |
| 5 | `public.list_vehicles(p_filters)` | danh sách kho | bỏ filter `brand/min_price/max_price`, bỏ sort `highest_price`, thêm filter loại xe |
| 6 | `public.list_acquisitions(p_filters)` | danh sách thu vào | projection + haystack theo biển·khung·loại xe |
| 7 | `public.list_sales(p_filters)` | danh sách bán | `vehicle_name` → `vehicle_title` + `vehicle_subtitle` |
| 8 | `public.list_receivables(p_filters)` | công nợ | bỏ `brand/model` khỏi haystack và projection |
| 9 | `public.list_expenses(p_filters)` | chi phí | bỏ `brand/model` khỏi nhãn xe |
| 10 | `public.daily_reconciliation(p_date)` | đối soát ngày | nhãn xe mới trong `vehicle_name`/`vehicle_title` |
| 11 | `public.global_search(p_query, p_limit)` | lệnh `/` toàn hệ thống | haystack = mã · biển · khung · màu · loại xe; projection không còn giá |
| 12 | `public.list_showroom_vehicles(p_filters)` | showroom công khai | **bỏ hẳn `asking_price`, `odometer`, `variant`, `brand`**, bỏ filter hãng, thêm filter loại xe |
| 13 | `public.list_pending_approvals(p_filters)` | hàng đợi phê duyệt xoá xe | dùng nhãn biển·khung mới |
| 14 | `public.save_settings(p_data)` | cài đặt | bỏ hoàn toàn nhánh `quickpick_brands`/`quickpick_models` |
| 15 | `private.sale_json(p_sale)` | JSON bản bán | `vehicle_name` → `vehicle_title`/`vehicle_subtitle` |
| 16 | `private.notify_from_audit()` | ghi thông báo nghiệp vụ | copy tiếng Việt dựng theo nhãn mới, không hãng xe, không giá dự kiến |

Hàm tiện ích đổi chữ ký: `private.vehicle_label_text(p_brand, p_model, p_internal_code,
p_license_plate)` → `private.vehicle_label_text(p_license_plate, p_frame_number,
p_internal_code)`. Các hàm `get_vehicle`, `get_settings`, `dashboard` chỉ dùng `to_jsonb(...)`
nên tự thích ứng, không cần viết lại (đã kiểm chứng bằng `pg_proc`, không có chuỗi cột cũ).

Ràng buộc/index đi theo cột bị bỏ: `vehicles_brand_check`, `vehicles_brand_not_null`,
`vehicles_model_check`, `vehicles_model_not_null`, `vehicles_variant_check`,
`vehicles_variant_not_null`, `vehicles_engine_number_check`, `vehicles_engine_number_not_null`,
`vehicles_odometer_check`, `vehicles_odometer_not_null`, `vehicles_asking_price_check`,
`vehicles_asking_price_not_null`, index `vehicles_engine_number`.
Cột `quickpick_brands`, `quickpick_models` trên `system_settings` bị DROP.
Không có view/vật liệu hoá nào tham chiếu các cột này (chỉ có `public.user_performance_summary`,
không liên quan); không có cột sinh tự động trên `vehicles`; 7 FK tới `vehicles(id)` giữ nguyên.

## 3. Số liệu production bị ảnh hưởng (đọc ngày 08/10/2026)

| Chỉ số | Giá trị | Số phận |
| --- | --- | --- |
| xe tổng / đang nhập / đã bán | 8 / 3 / 5 | **giữ nguyên dòng** |
| xe có hãng xe | 7 | **giá trị bị xoá** |
| xe có dòng xe (tên thương mại) | 8 | **giá trị bị xoá**, không map sang loại xe |
| xe có phiên bản | 0 | cột bị xoá, không mất dữ liệu |
| xe có số máy | 0 | cột bị xoá, không mất dữ liệu |
| xe có số km > 0 | 0 | cột bị xoá, không mất dữ liệu |
| xe có giá bán dự kiến > 0 | 6 | **giá trị bị xoá** |
| acquisitions | 8 | giữ nguyên |
| sales COMPLETED | 5 | giữ nguyên |
| doanh thu theo sales COMPLETED | 126.000.000 ₫ | giữ nguyên, không đổi công thức |
| tổng lợi nhuận `sale_financials` | 48.800.000 ₫ | giữ nguyên (snapshot bất biến) |
| payments ACTIVE | 0 | giữ nguyên |
| vehicle_expenses ACTIVE | 0 | giữ nguyên |
| identity_documents | 1 | giữ nguyên |
| showroom_leads | 0 | giữ nguyên |
| system_announcements | 0 | **không xoá** (không tham chiếu trường bị loại) |
| audit_logs | 111 | **xoá hết dòng** |
| vehicle_activity | 56 | **xoá hết dòng** |
| notifications | 77 | **xoá hết dòng** |
| customer_communications | 5 | **xoá hết dòng** |
| message_outbox | 5 | **xoá hết dòng** |
| `private.operation_receipts` | 13 | giữ nguyên (chỉ lưu sha256 payload, không chứa giá trị trường nào) |

## 4. Mất dữ liệu và hệ quả chức năng (đọc kỹ trước khi uỷ quyền)

1. **Mất vĩnh viễn giá trị thương mại của xe**: 7 hãng xe, 8 tên dòng xe, 6 giá bán dự kiến.
   Không có bản mapping tự động: `SH 160i` không suy ra được `Xe tay ga`. Cả 8 xe rơi vào
   loại `Chưa phân loại` cho tới khi nhân viên mở từng hồ sơ chọn lại.
2. **Mất toàn bộ trail truy vết**: 111 dòng audit, 56 dòng hoạt động xe, 77 thông báo,
   5 liên lạc khách, 5 tin trong hàng đợi gửi. Không có tombstone, không khôi phục được.
   Chủ quán không còn xem được "ai sửa gì trước 08/10".
   Các cơ chế chống trùng giao dịch vẫn còn nguyên; `IMMUTABLE_HISTORY` được **tạm vô hiệu
   trong phạm vi một transaction của migration** rồi bật lại — đây là lần duy nhất và phải
   được ghi vào `DECISIONS.md`.
3. **Khách hàng không còn thấy giá ở bất kỳ đâu**: showroom công khai bỏ khối giá; xe chưa
   bán thì hệ thống không có giá nào; giá bán thực tế chỉ tồn tại sau khi form **Bán xe** được
   hoàn thành. Trang bán xe không prefill giá, nhân viên phải gõ.
4. **Client cũ sẽ bị chặn ghi, không âm thầm hỏng**: PWA chưa cập nhật gửi payload thiếu
   `vehicle_type_id` → RPC trả `VEHICLE_TYPE_REQUIRED` (fail closed). File CSV/tốc ký lưu
   theo khuôn cũ bị từ chối kèm thông báo tiếng Việt, không tự dịch.
5. **Replay idempotency cũ thành xung đột**: `payload_hash` của request cũ tính trên payload
   có 6 field; nếu một request còn treo được gửi lại sau migration sẽ trả
   `OPERATION_REQUEST_CONFLICT`. Phải drain hàng đợi tin nhắn trước khi áp (5 dòng).
6. **Không có đường lùi thực tế**: production là gói FREE, không PITR, không scheduled
   backup (xác minh 03/10/2026). Recovery duy nhất là restore một dump cũ, và_dump đó dựng
   lại đúng các cột/dữ liệu vừa bị yêu cầu tiêu huỷ. Vì vậy dump sạch ngay sau migration là
   bắt buộc, còn dump cũ phải bị xoá trong cùng phiên.

## 5. Bản sao nằm ngoài khả năng xoá của chúng ta (kèm thời hạn)

| Bản sao | Xử lý | Thời hạn / giới hạn |
| --- | --- | --- |
| `backups/` (local, Git-ignored): data/schema dump, MANIFEST, migration-history, verify JSON, log, snapshot storage, zip baseline | **xoá hết** sau khi có dump sạch | trong tầm kiểm soát |
| Gương offsite Google Drive (`backups/offsite.txt`) | đang **tắt** (dòng `G:\CaremBackups` bị comment) → không có bản gương để xoá; vẫn phải kiểm tra `G:`/`D:` nếu chủ quán từng bật | nếu bật: xoá tay theo thư mục |
| Lịch sử Git của repo | migration đã áp dụng giữ **DDL** cũ (tên cột, hàm), không giữ giá trị nghiệp vụ thật vì `backups/` và `.env` không bao giờ được commit | bất khả xâm phạm theo chính sách forward-only |
| Snapshot nội bộ nền tảng Supabase (Free) | không truy xuất/không xoá được từ phía dự án | theo chính sách lưu trữ của Supabase |
| Ảnh đã gửi cho nhà cung cấp AI (`store:false`) | không gửi lại các task đã bỏ; huỷ khoá provider nếu cần | retained cho giám sát lạm dụng, tự hết theo chính sách provider |
| Log build/preview Vercel | không chứa dữ liệu nghiệp vụ, chỉ URL và cảnh báo build | tự hết hạn theo chu kỳ dự án |
| Draft còn trên thiết bị nhân viên (localStorage) | bump key `carem_form_draft_v2` / `carem_recent_vehicles_v2` / từ điển tốc ký → bản nháp chứa field cũ bị loại | biến mất khi app mở lại sau bản phát hành |

## 6. Điều kiện để bắt đầu ghi production

1. `npm run check` và `npm run test:e2e`, `test:pwa`, `check-pwa-upgrade`, `check-edge-native`
   xanh trên đúng cây cuối.
2. Replay đủ chuỗi migration (gồm migration mới) lên database disposable sạch: PASS.
3. Dump production cùng ngày (`npm run backup:prod`) **trước** `db push`.
4. `db push --dry-run` chỉ liệt kê `20261008000100`, `20261008000200`, `20261008000300`.
5. Chữ ký uỷ quyền tường minh của OWNER cho bước ghi production, theo `docs/AGENT_HANDOFF.md`.
6. Hàng đợi `message_outbox` = 0 (drain hoặc chấp nhận xoá 5 dòng theo mục 3).
7. Sau áp dụng: `npm run backup:prod` bản sạch → `backup:verify` → `backup:status` → xoá mọi set cũ.

Tài liệu này được cập nhật sau mỗi giai đoạn; mục 5 là phần chủ quán cần đọc để biết
 điều gì còn sót lại ở phía nhà cung cấp.

## Bổ sung 10/10/2026 — "Loại xe" đổi từ danh mục chọn sang tên nhập tự do

- Mục 4 ở trên ("thiếu `vehicle_type_id` → `VEHICLE_TYPE_REQUIRED`") **vẫn đúng cho ô tên**
  (`vehicle_type`) và ô id: đường ghi vẫn yêu cầu **một trong hai** có giá trị hợp lệ sau
  chuẩn hoá; nhưng **không còn** bắt tên phải đã có trong danh mục. `20261010000100_
  vehicle_type_free_text_autocomplete.sql` cho server **tự get-or-create** tên chuẩn hoá
  (`private.ensure_vehicle_type`), nên nhân viên gõ "Honda Vision" mới là lưu được, không
  cần OWNER thêm loại trước.
- **Không đổi tác động purge**: 6 cột `brand`/`model`/`variant`/`engine_number`/`odometer`/
  `asking_price` vẫn đã DROP, vẫn **không khôi phục**; vẫn **MỘT** trường `vehicle_type`.
  Bảng `public.vehicle_types` + FK `vehicles.vehicle_type_id` **giữ nguyên** để bảo toàn dữ
  liệu; `list_vehicle_types` **giữ nguyên** hành vi (mọi loại + count) vì bộ lọc Kho/Showroom,
  màn Cài đặt OWNER và 3 suite DB vẫn dựa vào bề mặt danh mục đầy đủ.
- Xe hiện hữu **không bị map lại hay xoá**: vẫn mang `vehicle_type_id` cũ (`Chưa phân loại`
  còn nguyên). Tên mới chỉ được tạo thêm dòng `vehicle_types` khi có xe lưu với tên đó.

