# Quy trình nội bộ Cà Rem CRM

Tài liệu nghiệp vụ chính thức, mô tả đúng 100% hành vi hệ thống đang chạy (UI, Edge Function và RPC đã kiểm tra trong mã nguồn). Mỗi mục `##` là một đơn vị tra cứu độc lập cho Trợ lý AI và trang Tài liệu cửa hàng.

## Tạo tài khoản nhân viên mới (chỉ OWNER)

Chỉ tài khoản OWNER còn hoạt động làm được việc này, và hệ thống **không tự gửi email** cho nhân viên.

1. OWNER đăng nhập, mở mục **Nhân sự** (`/users`) — trang này chỉ OWNER thấy và mở được.
2. Bấm **Tạo tài khoản** để mở hộp thoại "Tạo tài khoản nhân viên mới" và điền:
   - **Họ và tên**: bắt buộc, tối đa 120 ký tự.
   - **Tên đăng nhập**: 3–30 ký tự, chỉ chữ thường, số, `_` hoặc `.` (bấm `.` cũng bị xóa khoảng trắng tự động). Nhân viên sẽ đăng nhập bằng tên này, không phải email.
   - **Mật khẩu ban đầu**: tối thiểu 6 ký tự (toàn bộ mật khẩu cấp cho user trong dự án dùng chung ngưỡng này). Nhân viên dùng mật khẩu này đăng nhập và vào thẳng hệ thống; muốn thì tự đổi trong Cài đặt.
   - **Vai trò**: mặc định STAFF; chọn MANAGER nếu cần xem quản lý.
   - **Xem số tài chính** (tùy chọn): bật nếu nhân viên được thấy giá vốn, doanh thu, lợi nhuận.
   - **Giờ làm việc và ngày làm việc**: mặc định 07:00–20:00, thứ Hai đến thứ Bảy. Ngoài lịch này tài khoản bị chặn đăng nhập.
3. Xác nhận. Yêu cầu đi qua Edge Function `manage-users` chạy phía server: kiểm tra OWNER còn hoạt động, chưa đổi mật khẩu lần đầu (`check_user_access`), rồi mới tạo tài khoản. Nếu khởi tạo hồ sơ thất bại, hệ thống tự hoàn tất một phần và báo lỗi để làm lại — không có trạng thái "nửa tài khoản" đăng nhập được.
4. Gửi tên đăng nhập + mật khẩu ban đầu cho nhân viên qua kênh an toàn. Nhân viên đăng nhập là vào thẳng app — **không** còn màn hình cưỡng chế đổi mật khẩu lần đầu. Khi muốn, nhân viên tự đổi tại Cài đặt → **Đổi mật khẩu**. (Màn hình **Đổi mật khẩu** `/change-password` chỉ xuất hiện khi OWNER chủ động cấp lại mật khẩu tạm hoặc bật buộc đổi cho tài khoản.)

Lưu ý: Function chỉ tạo tài khoản bằng mật khẩu, không tự gửi email. Mọi thao tác của OWNER đều vào lịch sử thao tác (`/audit`).

## Quản lý tài khoản sau khi tạo (chỉ OWNER)

Tất cả đi qua cùng Edge Function `manage-users` với các hành động: `reset_password` (cấp mật khẩu tạm mới, kèm buộc đổi lần đầu), `force_password_change` (chặn màn hình cho tới khi người dùng tự đổi mật khẩu), `disable` (vô hiệu có thời hạn `disabled_until` kèm lý do — tài khoản bị chặn đăng nhập ngay), `enable_user` / `restore` (mở lại trước hạn), `delete` (xóa mềm, giữ lịch sử), `hard_delete` (xóa vĩnh viễn, chỉ khi được kiểm tra quyền `check_user_can_hard_delete`), `update_schedule` (giờ/ngày làm việc), `change_role`, `promote_to_owner` / `demote_owner`. Chủ cửa hàng **không thể vô hiệu hoặc hạ cấp OWNER đang hoạt động cuối cùng** — luôn có ít nhất một chủ tài khoản điều hành được.

## Ghi nhận xe thu vào (STAFF trở lên, trong lịch làm việc)

1. Mở **Thu vào** (`/acquisitions`) để xem danh sách; bấm tạo mới để vào form (`/acquisitions/new`).
2. Điền thông tin xe: **dòng xe** là bắt buộc; hãng, số khung, biển số, số máy, đời, màu, km, giá mua, chi phí linh tinh, ngày thu, người bán có thể để trống nếu chưa có ngay lúc thu.
3. Ảnh CCCD của người bán (khi thu xe) chụp và tải trực tiếp trong form: ảnh chỉ lưu ở bucket riêng tư `identity-documents`, liên kết theo hồ sơ thu qua `save_identity_document` + `register_identity_document_image`; người có quyền chỉ xem được bằng liên kết tạm 120 giây. Không lưu ảnh CCCD vào nơi khác.
4. Bấm Lưu. Giao dịch được ghi bằng RPC `acquire_vehicle` — một transaction duy nhất tạo xe + chi phí + hồ sơ; hoặc có thể thêm xe bằng form Tồn kho (`save_vehicle`) rồi bổ sung chi phí sau.
5. Giá mua chưa xác định được thì để trống: xe ở trạng thái "chờ giá vốn" (`cost_pending`), **chưa bán được** cho tới khi người có quyền tài chính nhập giá mua thật.
6. Số khung để trống: hệ thống tự sinh mã nội bộ `GEN-<uuid>` để xe vẫn lưu được mà không phá chỉ số UNIQUE. Khi có giấy tờ, mở lại form Tồn kho → điền số khung thật → hệ thống kiểm tra trùng như bình thường.

## Thu xe tốc ký — nhập nhiều xe cùng lúc từ tin nhắn viết tắt (STAFF trở lên)

Khi có một danh sách nhiều xe cần thu (tin nhắn Notes/Zalo), dùng trang **Thu xe tốc ký** (`/intake`, nằm trong mục Thu vào) thay vì nhập từng xe:

1. Dán tin nhắn vào ô ghi chú, **mỗi dòng là một xe**, rồi bấm **Tách thành danh sách**. Ví dụ: `sh den bs 29b1-123.45 nam 22 2v gia 18tr5`.
2. Từ viết tắt có sẵn nhận diện được: hãng (`hd`=Honda, `yam`/`ym`=Yamaha, `sz`=Suzuki, `vb`=Vinfast, `vespa`=Piaggio…), dòng xe (`sh`, `ex`=Exciter, `vis`=Vision, `ab`=Air Blade, `rsx`=Wave RSX, `janus`, `nvx`…), màu (`den`, `trang`, `do`, `xanh`…), phiên bản (`abs`, `cbs`, `phunxe`, `lazang`/`mamduc`=Mâm đúc). Tra cứu không dấu nên `SH`, `sh`, `Đen`, `den` đều khớp.
3. Từ khóa đứng trước giá trị cần lấy: `fk`/`khung`/`chassi` (số khung), `gm`/`may` (số máy), `bs`/`bien`/`bienso` (biển số), `sdt`/`dt`/`phone`/`tel` (SĐT người bán), `gia`/`thu` (giá thu), `niemyet`/`giasale`/`giabannoi`/`banra` (giá niêm yết), `km`/`van` (số km), `nam`/`yr` (năm), `ngay`/`date` (ngày thu), `ten`/`chu`/`anh`/`chi` (tên người bán), `ghichu`/`ghcn` (ghi chú — nhận hết phần còn lại của dòng).
4. Tiền viết tắt: `18tr5` = 18.500.000, `1.2ty` = 1.200.000.000, `450k` = 450.000, hoặc số đầy đủ `18.000.000`.
5. Từ không nhận diện được **không bao giờ bị đoán vào trường tiền**; chúng hiện ở mục "từ chưa nhận diện" để bạn gán vào Ghi chú hoặc dạy cho máy.
6. **Dạy viết tắt**: sửa một giá trị (hãng, dòng, phiên bản, màu, tên người bán) khác token gốc sẽ hiện nút dạy; xác nhận là lần sau dán lại tự đúng. Bộ nhớ viết tắt lưu **theo tài khoản ngay trên máy đó** (localStorage), không đồng bộ sang máy khác; xem và xóa từng quy tắc trong bảng "Bộ nhớ viết tắt" cuối trang.
7. Trước khi lưu, mỗi thẻ xe tự kiểm tra: bắt buộc có **dòng xe**; nếu bạn có quyền tài chính thì **bắt buộc giá thu**; số khung/hãng xe được phép để trống (khung trống → server tự sinh `GEN-<uuid>`); năm 1900–2100; km 0–10.000.000; biển số ≤ 30 ký tự; ngày thu không ở tương lai. Nhân viên không có quyền tài chính không ghi giá thu (chủ/nhân viên quản lý có quyền sẽ nhập sau; xe chờ giá vốn không bán được).
8. Bấm **Xác nhận thu xe**: hệ thống gửi cả lô cho `validate_import_vehicles` kiểm tra trùng lặp và tính hợp lệ phía server. Nếu có bất kỳ lỗi/trùng nào → báo ngay trên từng thẻ, **không lưu gì cả** để bạn sửa. Khi sạch lỗi → `import_vehicles` lưu toàn bộ xe + phiếu thu trong một giao dịch rồi chuyển về danh sách Thu vào.

## Cập nhật xe trong tồn kho

Mở **Tồn kho** (`/vehicles`), bấm vào xe để xem chi tiết (`/vehicles/:id`), bấm **Sửa** (`/vehicles/:id/edit`). Form dùng RPC `save_vehicle`; các trường số tiền là VND nguyên (không dấu phẩy). Ảnh xe tải lên bucket riêng tư `vehicle-images` (JPG/PNG/WebP, tối đa 5 MB mỗi ảnh trong app), đăng ký qua `register_vehicle_image`; xóa ảnh chỉ gỡ tham chiếu (soft delete), ảnh gốc giữ cho kiểm kê/sao lưu và quản trị viên dọn sau. Ảnh chưa đăng ký không ai đọc được.

## Tùy chỉnh chip "Chọn nhanh hãng & dòng xe"

Form **Thu vào** (`/acquisitions/new`) và **Nhập xe mới** (`/vehicles/new`, `/vehicles/:id/edit`) hiển thị hai hàng chip: **Chọn nhanh hãng xe** và **Chọn nhanh dòng xe** (chỉ hiện sau khi đã chọn hãng). Chip giúp nhân viên một chạm điền đúng tên hãng/dòng, giảm sai chính tả (`honda`/`Hoong da`) trong autocomplete.

- Mặc định mở hàng: Honda (SH 125i, SH 150i, SH 160i, SH Mode, Vision, Air Blade, Lead, Wave, Future, Dax ST125), Piaggio (Vespa Sprint, Vespa Primavera), Suzuki (Satria, Raider), Yamaha (Exciter).
- OWNER chỉnh trong **Cài đặt → Chọn nhanh xe**: mỗi hãng một dòng theo khuôn `Honda: SH 125i, Vision`. Dòng trống bị bỏ qua; mỗi tên tự cắt khoảng trắng và khử trùng lặp không phân biệt hoa/thường. Bấm **Khôi phục mặc định** để quay về danh sách mở hàng, rồi **Lưu danh mục**.
- Danh mục lưu ở `system_settings.quickpick_brands` (mảng text) và `quickpick_models` (JSONB `{ "honda": [...] }`, key là hãng đã lowercase). Ghi qua `save_settings` — **chỉ OWNER**, các vai trò khác nhận `ACCESS_DENIED`. Sai định dạng trả `INVALID_INPUT` (quá 30 hãng, quá 60 mẫu/hãng, tên rỗng, tên quá dài).
- `get_settings` trả nguyên hàng `system_settings`, nên STAFF/MANAGER đọc được chip mà không cần quyền ghi. Cache dùng chung query key `["settings"]` — khi OWNER lưu từ Cài đặt, chip ở form đang mở sẽ đổi ngay sau khi React Query refresh.
- Autocomplete vẫn hoạt động song song với chip: nhân viên có thể gõ tay hoặc bấm lịch sử xe gần nhất (`recentVehicles`) nếu mẫu chưa nằm trong danh mục.

## Chọn màu xe bằng ô màu (thay cho chip "Chọn màu nhanh")

Form **Thu vào**, **Nhập xe mới**, và **Thu tốc ký** hiển thị một **ô tròn nhỏ (swatch)** ngay cạnh nhãn **Màu sắc**. Bấm vào swatch mở bảng màu hệ điều hành; màu chọn được **khớp về từ tiếng Việt gần nhất** (`Đen`, `Đen nhám`, `Trắng`, `Trắng ngà`, `Bạc`, `Xám`, `Xám khói`, `Đỏ`, `Đỏ đô`, `Cam`, `Vàng`, `Kem`, `Nâu`, `Hồng`, `Tím`, `Xanh lá`, `Xanh mint`, `Xanh ngọc`, `Xanh dương`, `Xanh navy` — xem `src/lib/colorWords.ts`) rồi **điền vào ô text** để nhân viên có thể tiếp tục gõ chữ (`"Đen nhám bóng"`, `"Trắng ngọc trai"`, v.v.). Thuật toán khớp: khoảng cách Euclid có trọng số `2·ΔR² + 4·ΔG² + 3·ΔB²` (xấp xỉ cảm nhận thị giác, ưu tiên phân biệt sáng/tối).

- Swatch luôn hiển thị lại màu của từ đang lưu (tra `COLOR_ANCHORS`); nếu ô đang chứa từ tự do không có trong bảng, swatch hiện xám `#808080` — chỉ là gợi ý trực quan, không ghi đè text.
- Không dùng chip hàng loạt nữa. `COLOR_CHIPS` đã gỡ khỏi `QuickChips.tsx`; mọi form chỉ render `ColorSwatchAction` (component mới, nằm cạnh `Field` label qua prop `labelAction`).
- Giá trị cuối vẫn là **text tiếng Việt thuần**, không phải hex — giữ báo cáo/in phiếu dễ đọc, không cần bảng tra.
- Nhân viên có thể bỏ qua swatch và gõ thẳng tên màu như trước; `AutocompleteInput` vẫn suggestion từ `recentVehicles`.

## Bán xe (STAFF trở lên, trong lịch làm việc)

1. Từ xe trong kho bấm **Bán** (`/vehicles/:id/sell`) — xe phải đã chốt giá mua (không còn `cost_pending`).
2. Form bán (`sell_vehicle`) gồm: tên khách, số điện thoại khách, giá bán, ngày bán, số tiền đặt cọc/trả trước, phương thức thanh toán, ghi chú. Toàn bộ là SĐT và số tiền VND nguyên; tổng thanh toán không được vượt giá bán.
3. Lưu tạo bản ghi bán và chuyển xe sang trạng thái SOLD; hóa đơn cho khách in từ trang chi tiết bán (`/sales/:id`).
4. Muốn xóa bán sai: chủ/nhân viên được quyền bấm **Hủy bán** trên trang chi tiết, **bắt buộc nhập lý do** (`cancel_sale`). Các khoản đã thu bị đánh dấu `VOIDED` và loại khỏi công nợ đang hiệu lực nhưng vẫn giữ lịch sử; việc **hoàn tiền thật thực hiện bằng tiền mặt/chuyển khoản ngoài app** và phải tự đối chiếu.

## Thu tiền công nợ

Mở **Sổ công nợ** (`/receivables`) — thấy với mọi tài khoản hoạt động trong lịch. Mỗi dòng là một thương vụ còn phải thu, kèm hạn trả (dời hạn có kiểm tra phiên bản và ghi vết). Bấm **Thu tiền** để gửi đề nghị với số tiền dương (VND nguyên, tối đa 1.000.000.000.000 mỗi lần), phương thức, ngày thu, tham chiếu/ghi chú. Đề nghị chưa tính vào công nợ; quản lý làm theo mục **Xác minh khoản thu trước khi ghi nhận**. Khoản thu đã ghi nhận **không sửa được** — ghi sai thì quản lý xử lý bằng nghiệp vụ hủy/đối chiếu, không xóa lịch sử. Tổng đã thu + còn phải thu luôn khớp `get_sale`.

## Ghi chi phí

Mở **Chi phí** (`/expenses`) — cần MANAGER/OWNER để xem danh sách; STAFF thêm chi phí nhanh của một xe (QuickExpenseModal) hoặc chi phí hoạt động chung. RPC `save_expense` với `p_kind` là `vehicle` (gắn xe) hoặc `business` (chung). Muốn xóa: `cancel_expense` kèm lý do — bản ghi giữ lịch sử, chỉ bị loại khỏi tổng đang hiệu lực.

## Showroom công khai và khách vãng lai

Trang `/showroom` hiển thị xe đang có thật cho người ngoài xem (chỉ những xe chủ/showroom bật công khai). Khi khách để lại liên hệ, hệ thống tạo **lead** qua `create_showroom_lead`. Lead và khách mua được quản lý ở **Khách hàng** (`/customers`): đổi trạng thái lead (`update_showroom_lead_status`), xem lịch sử của khách (`get_customer_history`), tin nhắn đã gửi/đến (`list_customer_communications`, xử lý qua Edge Function `process-message`). Việc nhắn tin cho khách luôn do người thật xác nhận, AI không tự gửi.

## Tìm kiếm nhanh và bảng điều khiển

Ô tìm kiếm tổng (`global_search`) trên đầu mọi trang gộp kết quả xe, khách, thương vụ theo đúng quyền người xem. **Tổng quan** (`/dashboard`) dùng RPC `dashboard` (mặc định kỳ từ ngày 1 tháng này, múi giờ Asia/Ho_Chi_Minh) và **đối chiếu ngày** `daily_reconciliation` chỉ hiện cho MANAGER/OWNER. Cờ hiệu tồn kho (`inventory_indicator`) đếm xe **tại cửa hàng** (IN_STOCK + RESERVED) so với ngưỡng thấp/cao đã lưu: LOW khi số xe thấp hơn hẳn ngưỡng dưới, HIGH khi cao hơn hẳn ngưỡng trên — chỉ để nhìn, hệ thống không tự gửi thông báo.

## Thông báo nội bộ

OWNER/MANAGER soạn tin trên **Cài đặt** → tab Thông báo (`save_announcement`, bật/tắt `set_announcement_active`, xóa `delete_announcement`). Tin đang bật hiện trên thanh dọc của **mọi** người dùng (`list_active_announcements`) cho tới khi tắt. Cài đặt chung của cửa hàng (tên, SĐT, ngưỡng tồn kho) lưu qua `save_settings`.

Chuông **thông báo nghiệp vụ** (góc phải trên) liệt kê thu/bán/thanh toán theo quyền người xem. Trên điện thoại, panel mở lên thành **tấm trượt từ đáy (bottom sheet)**: bấm vào một dòng để mở giao dịch liên quan (đồng thời đánh dấu đã đọc), bấm "Đánh dấu tất cả đã đọc" để xóa huy hiệu, và đóng bằng nút ✕, phím Esc, hoặc **chạm vùng nền mờ phía trên tấm**. Không cần kéo thả; vùng nền mờ luôn còn trống nên luôn bấm ra ngoài được kể cả khi danh sách dài.

## Dùng Trợ lý AI đúng cách

- `/copilot` chỉ **đọc**: không tạo, không sửa, không lưu giao dịch nào. Mọi số liệu và tài liệu lấy theo đúng quyền của người đang hỏi (JWT/RLS).
- Mặc định là tra cứu chắc chắn — mỗi con số có mã bằng chứng `[m1]`, mỗi đoạn tài liệu `[d1]`; **bấm vào mã để mở đúng màn hình chứa bằng chứng và kiểm tra trước khi hành động**.
- Chế độ "AI viết câu tóm tắt" chỉ OWNER bật được; AI chỉ được diễn đạt lại bằng chứng đã truy xuất, nội dung bịa bị loại và tự rơi về tra cứu thường.
- Câu hỏi chưa có tài liệu/số liệu, trợ lý trả lời "Chưa tìm thấy..." và **ghi lại vào nhật ký câu hỏi hụt** — OWNER xem danh sách đó ở trang Tài liệu để biết cần bổ sung quy trình gì.

## Bổ sung và sửa tài liệu cho Trợ lý AI

Tài liệu copilot đọc được sinh tự động từ markdown trong repo — **không sửa tay** migration seed. Quy trình:

1. Sửa file gốc (`README.md`, `docs/*.md` kể cả file này, `supabase/API.md`, `supabase/SECURITY.md`).
2. Chạy `npm run knowledge:seed` để sinh lại `supabase/migrations/*_knowledge_seed.sql`, rồi chạy `npm run knowledge:check` để xác nhận khớp.
3. Áp migration lên database (forward-only). Mỗi mục `##` thành một phần tra cứu riêng; tier quyền theo nguồn: `docs/INTERNAL_SOPS.md` = STAFF, OPERATIONS/DECISIONS = MANAGER, PRODUCTION_RELEASE/SECURITY = OWNER.
4. CI báo lỗi nếu sửa `.md` mà quên sinh seed — luôn chạy `npm run check` trước khi commit.

## Xác minh khoản thu trước khi ghi nhận

Nhân viên nhập **Thu tiền → Lưu thanh toán** để gửi đề nghị; bước này chưa thay đổi tiền đã thu hoặc công nợ. Nhập mã giao dịch ngân hàng cùng tài khoản nhận, hoặc mã phiếu thu cùng sổ chứng từ nếu có. Dùng cùng mã khi nhiều nhân viên cùng xử lý một khoản tiền; không tạo mã mới để thử lại sau mất mạng.

Chủ cửa hàng hoặc quản lý mở chi tiết bán xe, xem **Khoản thu chờ xác minh**, đối chiếu tiền thực nhận và mọi khoản trong lịch sử, kể cả lần thu đầu khi bán. Ghi mã chứng từ dùng chung và nguồn bằng chứng, tích xác nhận đã kiểm tra rồi chọn **Xác minh và ghi nhận**. Đề nghị trùng phải **Từ chối khoản thu**, ghi rõ lý do; không xóa lịch sử. Đề nghị nhập sai số tiền/ngày phải được quản lý từ chối trước khi gửi đề nghị đã sửa với mã thao tác mới; cùng chứng từ chưa ghi nhận có thể dùng lại, lịch sử từ chối vẫn giữ. Nếu thiếu chứng từ, lập biên bản đối chiếu được cửa hàng lưu và đánh mã dùng chung trước khi ghi nhận. Hai khoản thật cùng số tiền vẫn dùng hai chứng từ riêng. Một chuyển khoản trả cho nhiều giao dịch cần quản lý đối chiếu phân bổ; chưa hỗ trợ tự chia.

Khi mất phản hồi, kiểm tra đề nghị và lịch sử trước khi gửi lại. Phiên bản cũ thiếu mã thao tác/phiên bản sửa sẽ bị từ chối; tải lại tab hoặc cập nhật PWA. Khi báo xung đột hạn nợ hoặc chi phí, tải lại và đối chiếu giá trị mới, không thử ép lưu dữ liệu cũ.

Nếu tin cảm ơn giữ trạng thái **Đang gửi**, quản lý chọn **Kiểm tra và khôi phục xử lý**. Server chỉ nhận lại khi lease hết hạn và chế độ gửi cho phép phục hồi an toàn. Nếu kết quả chưa xác định, kiểm tra nhật ký nhà cung cấp, nhập mã bằng chứng và chọn đã gửi/chưa gửi; chỉ thử gửi lại sau khi xác nhận chưa gửi. Không có scheduler chạy nền tự động được chứng nhận trong bản này.

## Nhật ký câu hỏi chưa có tài liệu (OWNER)

Khi copilot trả lời "Chưa tìm thấy dữ liệu hoặc tài liệu phù hợp", câu hỏi được ghi vào `public.copilot_question_gaps` (nội dung chuẩn hóa, số lần gặp, người hỏi gần nhất). OWNER mở **Tài liệu cửa hàng** (`/docs`) để xem khối "Câu hỏi chưa có tài liệu"; mỗi câu xuất hiện nhiều lần là tín hiệu cần viết ngay một SOP cho nó vào `docs/INTERNAL_SOPS.md` rồi chạy lại bước ở mục trên.
