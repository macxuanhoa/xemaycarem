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

Tất cả đi qua cùng Edge Function `manage-users` với các hành động: `reset_password` (cấp mật khẩu tạm mới, kèm buộc đổi lần đầu), `disable` (vô hiệu có thời hạn `disabled_until` kèm lý do — tài khoản bị chặn đăng nhập ngay), `enable_user` (mở lại trước hạn cấm), `delete` (xóa tài khoản — xem mục dưới), `change_role` (chỉ OWNER đổi vai trò tài khoản không phải Chủ; MANAGER chỉ đổi được Nhân viên), `promote_to_owner` (chuyển giao quyền Chủ, hệ thống luôn đúng một Chủ). Chủ cửa hàng **không thể vô hiệu hoặc hạ cấp OWNER đang hoạt động cuối cùng** — luôn có ít nhất một chủ tài khoản điều hành được.

## Xóa tài khoản nhân sự (chỉ OWNER)

Bấm **Xóa tài khoản** trong popup nhân sự là tài khoản rời khỏi hệ thống **ngay lập tức**: không có thùng rác 30 ngày, không có nút khôi phục, và `enable_user` cũng không mở lại được.

1. Mở **Nhân sự** (`/users`) → chọn nhân viên → tab **Xóa tài khoản** → điền **Lý do xóa (tùy chọn)** → bấm **Xóa tài khoản** → xác nhận.
2. Hệ thống kiểm tra người đó đã ghi nhận nghiệp vụ chưa (RPC `check_user_can_hard_delete`, quét toàn bộ bảng tham chiếu hồ sơ: xe thu vào, tồn kho, chi phí, ảnh, nhật ký hoạt động, phiếu bán, thu tiền, chứng từ, liên lạc khách, CCCD, cài đặt, nhật ký thao tác...):
   - **Chưa ghi nhận gì**: xóa sạch hồ sơ và tài khoản đăng nhập. Tài khoản biến mất hoàn toàn.
   - **Đã có nghiệp vụ**: giữ lại hồ sơ như một "mộ" và hủy khả năng đăng nhập (mật khẩu đổi sang chuỗi ngẫu nhiên, `check_user_access` chặn `ACCOUNT_DELETED`). **Toàn bộ công việc người đó đã làm vẫn còn nguyên** — xe, phiếu bán, chi phí, chứng từ, nhật ký vẫn đúng tên người đã ghi để đối soát; riêng tài khoản thì biến mất khỏi danh sách Nhân sự.
3. Vì vậy khi tuyển lại người cũ hoặc tạo tài khoản mới, **không dùng lại tên đăng nhập của người đã xóa** (tên vẫn bị giữ để lịch sử không bị nhả lẫn sang người khác); hãy chọn tên khác.
4. Mọi lần xóa đều ghi vào lịch sử thao tác (`/audit`) với lý do và cho biết nghiệp vụ cũ được giữ hay đã xóa sạch.

Tài khoản **Chủ cửa hàng không xóa được** bằng nút này (hệ thống báo `CANNOT_DELETE_OWNER`); muốn gỡ quyền Chủ thì dùng chuyển giao quyền Chủ cho người khác trước.

Lưu ý: xóa tài khoản **không** xóa xe/bán/chi phí mà người đó đã ghi. Muốn dọn nghiệp vụ sai thì hủy phiếu bán hoặc xóa xe/chi phí theo đúng luồng có lý do, không phải bằng cách xóa người.

## Ghi nhận xe thu vào (STAFF trở lên, trong lịch làm việc)

1. Mở **Thu vào** (`/acquisitions`) để xem danh sách; bấm tạo mới để vào form (`/acquisitions/new`).
2. Điền thông tin xe: **loại xe** là bắt buộc — chọn từ danh mục cửa hàng (không gõ tay), chưa xác định được thì chọn `Chưa phân loại` rồi sửa lại sau. Số khung, biển số, đời xe, màu sơn, giá mua, chi phí linh tinh, ngày thu, người bán có thể để trống nếu chưa có ngay lúc thu. Hồ sơ xe **không còn** hãng, dòng xe, phiên bản, số máy, số km và giá bán dự kiến; màn hình nào cũng định danh xe bằng **biển số · số khung**, dòng phụ ghi **loại xe · đời xe · màu sắc**.
3. Ảnh CCCD của người bán (khi thu xe) chụp và tải trực tiếp trong form: ảnh chỉ lưu ở bucket riêng tư `identity-documents`, liên kết theo hồ sơ thu qua `save_identity_document` + `register_identity_document_image`; người có quyền chỉ xem được bằng liên kết tạm 120 giây. Không lưu ảnh CCCD vào nơi khác.
4. Bấm Lưu. Giao dịch được ghi bằng RPC `acquire_vehicle` — một transaction duy nhất tạo xe + chi phí + hồ sơ; hoặc có thể thêm xe bằng form Tồn kho (`save_vehicle`) rồi bổ sung chi phí sau.
5. Giá mua chưa xác định được thì để trống: xe ở trạng thái "chờ giá vốn" (`cost_pending`), **chưa bán được** cho tới khi người có quyền tài chính nhập giá mua thật.
6. Số khung để trống: hệ thống tự sinh mã nội bộ `GEN-<uuid>` để xe vẫn lưu được mà không phá chỉ số UNIQUE. Khi có giấy tờ, mở lại form Tồn kho → điền số khung thật → hệ thống kiểm tra trùng như bình thường.
7. Chưa đọc được số khung đầy đủ ngoài hiện trường (tem khung mờ, bị sơn phủ, giấy tờ chủ xe giữ): chọn nút gạt **"5 ký tự cuối"** ngay dưới ô Số khung và chỉ gõ **5 ký tự cuối** — hệ thống hiểu đây là dữ liệu **rút gọn** (`PARTIAL`), vẫn giữ đủ 5 ký tự (kể cả số `0` đầu) và **không** bắt phải nhập cả VIN. Chi tiết ở mục **Kiểm tra trùng xe** bên dưới.

## Kiểm tra trùng xe khi nhập hoặc thu (ba mức GREEN/YELLOW/RED)

Mỗi form **Thu vào**, **Nhập/Sửa xe** đều tự chạy một RPC máy chủ (`check_vehicle_duplicates`) ngay khi bạn ngừng gõ số khung/biển số, và **bắt buộc chạy lại đúng bộ máy đó khi bấm Lưu** — nên không có chuyện "lúc gõ thì xanh, lúc lưu lại đỏ". Ba mức:

- **Xanh (GREEN)** — không có tín hiệu trùng. Lưu bình thường, **không** bắt nhập đủ số khung.
- **Vàng (YELLOW)** — có **một** dấu hiệu giống một xe đang quản lý: **hoặc** trùng biển số, **hoặc** trùng 5 ký tự cuối số khung (kiểu dữ liệu giống nhau). Form hiện **danh sách xe tương tự**; bạn **đối chiếu** rồi tích **"Đã kiểm tra danh sách trên, vẫn lưu xe này"** để mở khóa nút Lưu. Đây là "khóa nghi trùng", không chặn cứng — việc xác nhận được ghi lại để Chủ/Quản lý đối soát sau.
- **Đỏ (RED)** — chắc chắn nghi cùng một xe, **chặn lưu** tới khi xử lý: (1) **trùng cả biển số lẫn 5 ký tự cuối**; (2) số khung **đầy đủ** đã có trên một xe khác đang quản lý (kể cả xe **đã bán** — hãy mở hồ sơ cũ, đừng tạo mới); (3) một bên lưu số khung đầy đủ, một bên chỉ lưu rút gọn nhưng **khớp 5 ký tự cuối** — máy chủ **không tự cho là hai xe khác nhau**. Cách gỡ: nhập **đủ số khung** để hệ thống phân định, hoặc bấm **Mở hồ sơ** để coi xe đang có.

Quy tắc cần nhớ: **được phép** nhập đúng 5 ký tự cuối khi dữ liệu hiện trường không đọc được VIN đầy đủ; hai xe chỉ trùng 5 ký tự cuối **không** bị chặn cứng như trước (chuyển sang Vàng để người tự xác nhận). Xe **đã hủy** (CANCELLED) **được phép thu/nhập lại** bình thường. Loại xe **không** là căn cứ chống trùng — đừng mong nó tách hai xe cùng biển/cùng khung.

## Thu xe tốc ký — nhập nhiều xe cùng lúc từ tin nhắn viết tắt (STAFF trở lên)

Khi có một danh sách nhiều xe cần thu (tin nhắn Notes/Zalo), dùng trang **Thu xe tốc ký** (`/intake`, nằm trong mục Thu vào) thay vì nhập từng xe:

1. Dán tin nhắn vào ô ghi chú, **mỗi dòng là một xe**, rồi bấm **Tách thành danh sách**. Ví dụ: `ga den bs 29b1-123.45 nam 22 gia 18tr5` → loại xe Xe tay ga, màu Đen, biển số, năm 2022, giá thu 18.500.000₫.
2. Từ viết tắt nhận diện được hiện nay chỉ còn **loại xe** và **màu**: `so`/`xeso`/`cub` → Xe số, `ga`/`tayga`/`xega`/`auto` → Xe tay ga, `contay`/`con`/`pk`/`sport` → Xe côn tay, `dien`/`ev`/`accu` → Xe điện, `ga50`/`50cc` → Ga 50cc; màu `den`, `trang`, `do`, `xanh`… Từ loại xe chỉ được **gợi ý**: bộ khớp đối chiếu với danh mục thật đang dùng, token không khớp danh mục sẽ không bao giờ được tự chọn (nhân viên phải bấm chọn trên thẻ). Tra cứu không dấu nên `Xe Số`, `xe so`, `Đen`, `den` đều khớp.
3. Từ khóa đứng trước giá trị cần lấy: `fk`/`khung`/`chassi` (số khung), `bs`/`bien`/`bienso` (biển số), `loai`/`loaixe`/`type` (loại xe), `sdt`/`dt`/`phone`/`tel` (SĐT người bán), `gia`/`giathu`/`thu` (giá thu), `nam`/`yr` (năm), `ngay`/`date` (ngày thu), `ten`/`chu`/`anh`/`chi` (tên người bán), `ghichu`/`ghcn` (ghi chú — nhận hết phần còn lại của dòng). **Không còn** khóa cho số máy, số km, giá bán dự kiến hay hãng/dòng xe.
4. Tiền viết tắt: `18tr5` = 18.500.000, `1.2ty` = 1.200.000.000, `450k` = 450.000, hoặc số đầy đủ `18.000.000`.
5. Từ không nhận diện được **không bao giờ bị đoán vào trường tiền và cũng không còn được đổ vào "Dòng xe"** (quy tắc đó đã bị xoá cùng các trường cũ): chúng hiện ở mục "từ chưa nhận diện" để bạn gán vào Ghi chú hoặc dạy cho máy.
6. **Dạy viết tắt**: sửa một giá trị (loại xe, màu, tên người bán) khác token gốc sẽ hiện nút dạy; xác nhận là lần sau dán lại tự đúng. Bộ nhớ viết tắt lưu **theo tài khoản ngay trên máy đó** (localStorage), không đồng bộ sang máy khác; xem và xóa từng quy tắc trong bảng "Bộ nhớ viết tắt" cuối trang.
7. Trước khi lưu, mỗi thẻ xe tự kiểm tra: **bắt buộc có loại xe nằm trong danh mục** (`Chọn loại xe từ danh mục.`); nếu bạn có quyền tài chính thì **bắt buộc giá thu**; số khung và biển số được phép để trống (khung trống → server tự sinh `GEN-<uuid>`, biển có gõ thì phải đúng format xe máy Việt Nam); năm 1900–2100; ngày thu không ở tương lai. Nhân viên không có quyền tài chính không ghi giá thu (chủ/nhân viên quản lý có quyền sẽ nhập sau; xe chờ giá vốn không bán được).
8. Bấm **Xác nhận thu xe**: hệ thống gửi cả lô cho `validate_import_vehicles` kiểm tra trùng lặp và tính hợp lệ phía server. Nếu có bất kỳ lỗi/trùng nào → báo ngay trên từng thẻ, **không lưu gì cả** để bạn sửa. Khi sạch lỗi → `import_vehicles` lưu toàn bộ xe + phiếu thu trong một giao dịch rồi chuyển về danh sách Thu vào.

## Cập nhật xe trong tồn kho

Mở **Tồn kho** (`/vehicles`), bấm vào xe để xem chi tiết (`/vehicles/:id`), bấm **Sửa** (`/vehicles/:id/edit`). Form dùng RPC `save_vehicle`; các trường số tiền là VND nguyên (không dấu phẩy). Ảnh xe tải lên bucket riêng tư `vehicle-images` (JPG/PNG/WebP, tối đa 5 MB mỗi ảnh trong app), đăng ký qua `register_vehicle_image`; xóa ảnh chỉ gỡ tham chiếu (soft delete), ảnh gốc giữ cho kiểm kê/sao lưu và quản trị viên dọn sau. Ảnh chưa đăng ký không ai đọc được.

## Quản lý danh mục **Loại xe** (chỉ OWNER)

Form **Thu vào** (`/acquisitions/new`), **Nhập xe mới** (`/vehicles/new`, `/vehicles/:id/edit`) và **Thu xe tốc ký** đều bắt buộc chọn **loại xe** — và chỉ được chọn từ danh mục, không gõ tự do. Danh mục do OWNER bảo trì:

- Mở **Cài đặt → Loại xe**: mỗi loại một dòng, bấm **Thêm loại xe**, sửa ngay tại dòng để **đổi tên**, hoặc **Xóa**. Cột đếm cho biết đang có bao nhiêu xe mang loại đó.
- Tên được chuẩn hóa trước khi lưu (cắt khoảng trắng thừa, so khớp **không phân biệt hoa/thường**). Trùng tên được báo **ngay khi gõ** — dòng đó hiện cảnh báo đỏ và nút **Lưu tên** bị khóa; nếu vẫn gửi đi thì server trả `DUPLICATE_VEHICLE_TYPE`. Tên dưới 2 ký tự không được gửi, ô nhập giới hạn 60 ký tự; vi phạm khác hiển thị trong khối lỗi cuối card.
- Loại `Chưa phân loại` là **hàng đợi mặc định** của toàn bộ xe cũ sau đợt tẩy trường và **không đổi được tên, không xóa được** (`VEHICLE_TYPE_PROTECTED`). Muốn dọn: mở từng hồ sơ xe, chọn loại thật.
- **Không xóa được loại đang có xe tham chiếu** — nút **Xóa** bị xám khi cột đếm > 0, và server chặn `VEHICLE_TYPE_IN_USE` nếu hai máy cùng sửa. Trước hết phải chuyển những xe đó sang loại khác.
- Thêm loại mới **không cần migration**, có ngay trên mọi máy sau khi React Query refresh (query key `vehicle-types`); tab **Loại xe** chỉ hiện với OWNER nên STAFF/MANAGER không có đường ghi.
- Bộ gõ tốc ký chỉ **gợi ý** loại xe từ danh mục này (`matchVehicleType`), nên đặt tên kiểu `Xe tay ga`, `Ga 50cc` sẽ được nhận ra từ `ga`, `tay ga`, `50cc`; tên tự đặt kiểu `Ga 50cc thể thao` vẫn khớp nhờ so khớp con.
- Danh mục gốc seed theo migration `20261008000300`: `Xe số`, `Xe tay ga`, `Xe côn tay`, `Xe điện`, `Ga 50cc`, `Chưa phân loại`.

## Chọn màu xe bằng ô màu (thay cho chip "Chọn màu nhanh")

Form **Thu vào**, **Nhập xe mới**, và **Thu tốc ký** hiển thị một **ô tròn nhỏ (swatch)** ngay cạnh nhãn **Màu sắc**. Bấm vào swatch mở bảng màu hệ điều hành; màu chọn được **khớp về từ tiếng Việt gần nhất** (`Đen`, `Đen nhám`, `Trắng`, `Trắng ngà`, `Bạc`, `Xám`, `Xám khói`, `Đỏ`, `Đỏ đô`, `Cam`, `Vàng`, `Kem`, `Nâu`, `Hồng`, `Tím`, `Xanh lá`, `Xanh mint`, `Xanh ngọc`, `Xanh dương`, `Xanh navy` — xem `src/lib/colorWords.ts`) rồi **điền vào ô text** để nhân viên có thể tiếp tục gõ chữ (`"Đen nhám bóng"`, `"Trắng ngọc trai"`, v.v.). Thuật toán khớp: khoảng cách Euclid có trọng số `2·ΔR² + 4·ΔG² + 3·ΔB²` (xấp xỉ cảm nhận thị giác, ưu tiên phân biệt sáng/tối).

- Swatch luôn hiển thị lại màu của từ đang lưu (tra `COLOR_ANCHORS`); nếu ô đang chứa từ tự do không có trong bảng, swatch hiện xám `#808080` — chỉ là gợi ý trực quan, không ghi đè text.
- Không dùng chip hàng loạt nữa. `COLOR_CHIPS` đã gỡ khỏi `QuickChips.tsx`; mọi form chỉ render `ColorSwatchAction` (component mới, nằm cạnh `Field` label qua prop `labelAction`).
- Giá trị cuối vẫn là **text tiếng Việt thuần**, không phải hex — giữ báo cáo/in phiếu dễ đọc, không cần bảng tra.
- Nhân viên có thể bỏ qua swatch và gõ thẳng tên màu như trước; `AutocompleteInput` vẫn suggestion từ `recentVehicles`.

## Bán xe (STAFF trở lên, trong lịch làm việc)

1. Từ xe trong kho bấm **Bán** (`/vehicles/:id/sell`) — xe phải đã chốt giá mua (không còn `cost_pending`).
2. Form bán (`sell_vehicle`) gồm: tên khách, số điện thoại khách, giá bán, ngày bán, số tiền đặt cọc/trả trước, phương thức thanh toán, ghi chú. **Giá bán và khoản trả trước luôn mở trống** — nhân viên phải tự gõ; hệ thống không còn lưu giá bán dự kiến trên xe nên không có gì để điền sẵn, và bản nháp AI, tốc ký hay handoff từ màn hình khác cũng không được prefill giá. Toàn bộ là SĐT và số tiền VND nguyên; tổng thanh toán không được vượt giá bán.
3. Lưu tạo bản ghi bán và chuyển xe sang trạng thái SOLD; hóa đơn cho khách in từ trang chi tiết bán (`/sales/:id`).
4. Muốn xóa bán sai: chủ/nhân viên được quyền bấm **Hủy bán** trên trang chi tiết, **bắt buộc nhập lý do** (`cancel_sale`). Các khoản đã thu bị đánh dấu `VOIDED` và loại khỏi công nợ đang hiệu lực nhưng vẫn giữ lịch sử; việc **hoàn tiền thật thực hiện bằng tiền mặt/chuyển khoản ngoài app** và phải tự đối chiếu.

## Thu tiền công nợ

Mở **Sổ công nợ** (`/receivables`) — thấy với mọi tài khoản hoạt động trong lịch. Mỗi dòng là một thương vụ còn phải thu, kèm hạn trả (dời hạn có kiểm tra phiên bản và ghi vết). Bấm **Thu tiền** để gửi đề nghị với số tiền dương (VND nguyên, tối đa 1.000.000.000.000 mỗi lần), phương thức, ngày thu, tham chiếu/ghi chú. Đề nghị chưa tính vào công nợ; quản lý làm theo mục **Xác minh khoản thu trước khi ghi nhận**. Khoản thu đã ghi nhận **không sửa được** — ghi sai thì quản lý xử lý bằng nghiệp vụ hủy/đối chiếu, không xóa lịch sử. Tổng đã thu + còn phải thu luôn khớp `get_sale`.

## Ghi chi phí

Mở **Chi phí** (`/expenses`) — cần MANAGER/OWNER để xem danh sách; STAFF thêm chi phí nhanh của một xe (QuickExpenseModal) hoặc chi phí hoạt động chung. RPC `save_expense` với `p_kind` là `vehicle` (gắn xe) hoặc `business` (chung). Muốn xóa: `cancel_expense` kèm lý do — bản ghi giữ lịch sử, chỉ bị loại khỏi tổng đang hiệu lực.

## Quyền nghiệp vụ xe của Nhân viên (parity với Quản lý mặc định)

Nhân viên (STAFF) hoạt động trên xe **ngang tầm một Quản lý mặc định không xem được tài chính**: thêm/sửa xe, **hủy và khôi phục trạng thái** xe, **thêm–sửa–hủy chi phí gắn theo xe** (`save_expense`/`cancel_expense` với `p_kind='vehicle'`), và **bán xe**. STAFF **không** được: xem danh sách chi phí chung/số liệu lãi–giá vốn (khi chưa bật *Xem số tài chính*), ghi **chi phí hoạt động chung** (`p_kind='business'` vẫn yêu cầu MANAGER/OWNER), và quản lý tài khoản/quản trị hệ thống. Mọi giới hạn này do RPC `private.require_role` + `private.can_financials` buộc, không phụ thuộc giao diện.

## Gửi yêu cầu xóa xe (chỉ STAFF) — chờ Chủ duyệt

Khác Quản lý/Chủ được **xóa xe ngay** (`delete_vehicle`), Nhân viên bấm **Gửi yêu cầu xóa** trên menu **Thao tác trên xe** (hoặc tấm thao tác trên điện thoại). Quy trình:

1. STAFF mở xe trong **Tồn kho** → menu ••• → **Gửi yêu cầu xóa**, nhập **lý do** (3–1000 ký tự, bắt buộc) → xác nhận. Xe **lập tức ẩn khỏi danh sách tồn kho** và mang cờ *đang chờ duyệt xóa* (`pending_deletion`); khi đó **không** sửa, bán, thêm chi phí hay xóa trực tiếp được nữa (RPC trả `DELETE_PENDING`).
2. Hệ thống ghi nhật ký `REQUEST_DELETE_VEHICLE` và **báo cho Chủ cửa hàng** (chuông thông báo, bấm mở trang **Chờ duyệt** `/approvals`).
3. **Chỉ OWNER** vào **Chờ duyệt** (`/approvals`, mục dành riêng cho Chủ) và quyết định từng yêu cầu:
   - **Duyệt xóa** → xe bị **xóa cứng** khỏi hệ thống (`private.purge_vehicle`; vẫn chặn nếu xe từng có lịch sử bán → `SALE_HISTORY_EXISTS`).
   - **Khôi phục** → yêu cầu bị từ chối và **xe trở lại tồn kho** như cũ.
4. Không gửi được **hai yêu cầu cùng lúc** cho một xe (`ALREADY_PENDING`); xe **đã từng bán** thì không gửi được (`SALE_HISTORY_EXISTS`); lý do quá ngắn bị chặn (`DELETION_REASON_REQUIRED`).

Xe chờ duyệt chỉ còn truy cập được qua trang **Chờ duyệt** của Chủ (và liên kết trực tiếp tới trang chi tiết, nơi hiện dải “Đang chờ chủ cửa hàng duyệt xóa”). Toàn bộ quyết định duyệt/khôi phục đều vào lịch sử thao tác (`/audit`).

## Showroom công khai và khách vãng lai

Trang `/showroom` hiển thị xe đang có thật cho người ngoài xem (chỉ những xe chủ/showroom bật công khai). Thẻ xe và modal chi tiết chỉ nói **biển số · số khung**, **loại xe · đời xe · màu sơn**, tình trạng và ảnh — **không bao giờ hiện giá** (không có "Giá bán", không có "đã lăn bánh"), vì giá nằm sau form Bán xe và chỉ người có quyền mới thấy. Bộ lọc công khai theo **loại xe**, không theo hãng. Khách chỉ cần chọn loại xe đang bày bán, nên danh mục gửi ra anon chỉ gồm các loại còn xe IN_STOCK và không kèm số lượng. Khi khách để lại liên hệ, hệ thống tạo **lead** qua `create_showroom_lead`. Lead và khách mua được quản lý ở **Khách hàng** (`/customers`): đổi trạng thái lead (`update_showroom_lead_status`), xem lịch sử của khách (`get_customer_history`), tin nhắn đã gửi/đến (`list_customer_communications`, xử lý qua Edge Function `process-message`). Việc nhắn tin cho khách luôn do người thật xác nhận, AI không tự gửi. Form "Định giá xe cần bán" của khách vẫn giữ nguyên: `expected_price` là số **khách tự khai** cho nhu cầu thu mua, không phải giá hệ thống gán cho xe.

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

## Chuyển đổi danh tính xe ngày 08/10/2026 — nhân viên cần biết

- Hồ sơ xe **bỏ vĩnh viễn** Hãng, Dòng xe, Phiên bản, Số máy, Số km và Giá bán dự kiến. Danh tính duy nhất là **biển số · số khung**; dòng phụ là **loại xe · đời xe · màu sơn**. Đừng tìm các ô cũ trong form và đừng báo "thiếu thông tin hãng xe" — đó là thiết kế mới, không phải lỗi.
- **Toàn bộ xe cũ rơi vào loại `Chưa phân loại`** (không tự đoán từ tên xe cũ: `SH 160i` không suy ra `Xe tay ga`). Khi mở một hồ sơ để sửa nghiệp vụ, chọn luôn loại xe thật; chưa có màn hình phân loại hàng loạt.
- **Nhật ký cũ đã bị tẩy rỗng** theo quyết định chủ quán: lịch sử thao tác, hoạt động xe, chuông thông báo, liên lạc khách và hàng đợi tin nhắn trước 08/10/2026 đều còn 0 dòng. Khi đối chiếu nghiệp vụ cũ, dựa trên **xe, phiếu bán, chi phí, chứng từ, giá vốn–lãi** (các bảng này giữ nguyên), không dựa vào nhật ký.
- Giá bán **không có sẵn ở đâu để điền**: mở form Bán xe là hai ô giá và khoản trả trước trống, nhân viên phải tự gõ từ hợp đồng thật.
- Máy chưa cập nhật PWA sẽ bị **từ chối khi ghi** xe/thu xe (`VEHICLE_TYPE_REQUIRED`) và file CSV/tốc ký lưu theo khuôn cũ (cột Hãng, Dòng, Số máy, Km, Giá bán) bị báo lỗi tiếng Việt chứ không tự dịch. Cách xử lý: tải lại tab / cập nhật ứng dụng rồi nhập lại theo khuôn mới.
- Bản nháp cũ trên máy bị **loại có chủ đích** (khóa lưu đổi thành `xe_crm_draft_v2`, danh sách xe gần đây thành `xe_crm_ux_v3`) vì chúng chứa trường không còn tồn tại; dữ liệu đã lưu trên server không mất.

## Xác minh khoản thu trước khi ghi nhận

Nhân viên nhập **Thu tiền → Lưu thanh toán** để gửi đề nghị; bước này chưa thay đổi tiền đã thu hoặc công nợ. Nhập mã giao dịch ngân hàng cùng tài khoản nhận, hoặc mã phiếu thu cùng sổ chứng từ nếu có. Dùng cùng mã khi nhiều nhân viên cùng xử lý một khoản tiền; không tạo mã mới để thử lại sau mất mạng.

Chủ cửa hàng hoặc quản lý mở chi tiết bán xe, xem **Khoản thu chờ xác minh**, đối chiếu tiền thực nhận và mọi khoản trong lịch sử, kể cả lần thu đầu khi bán. Ghi mã chứng từ dùng chung và nguồn bằng chứng, tích xác nhận đã kiểm tra rồi chọn **Xác minh và ghi nhận**. Đề nghị trùng phải **Từ chối khoản thu**, ghi rõ lý do; không xóa lịch sử. Đề nghị nhập sai số tiền/ngày phải được quản lý từ chối trước khi gửi đề nghị đã sửa với mã thao tác mới; cùng chứng từ chưa ghi nhận có thể dùng lại, lịch sử từ chối vẫn giữ. Nếu thiếu chứng từ, lập biên bản đối chiếu được cửa hàng lưu và đánh mã dùng chung trước khi ghi nhận. Hai khoản thật cùng số tiền vẫn dùng hai chứng từ riêng. Một chuyển khoản trả cho nhiều giao dịch cần quản lý đối chiếu phân bổ; chưa hỗ trợ tự chia.

Khi mất phản hồi, kiểm tra đề nghị và lịch sử trước khi gửi lại. Phiên bản cũ thiếu mã thao tác/phiên bản sửa sẽ bị từ chối; tải lại tab hoặc cập nhật PWA. Khi báo xung đột hạn nợ hoặc chi phí, tải lại và đối chiếu giá trị mới, không thử ép lưu dữ liệu cũ.

Nếu tin cảm ơn giữ trạng thái **Đang gửi**, quản lý chọn **Kiểm tra và khôi phục xử lý**. Server chỉ nhận lại khi lease hết hạn và chế độ gửi cho phép phục hồi an toàn. Nếu kết quả chưa xác định, kiểm tra nhật ký nhà cung cấp, nhập mã bằng chứng và chọn đã gửi/chưa gửi; chỉ thử gửi lại sau khi xác nhận chưa gửi. Không có scheduler chạy nền tự động được chứng nhận trong bản này.

## Nhật ký câu hỏi chưa có tài liệu (OWNER)

Khi copilot trả lời "Chưa tìm thấy dữ liệu hoặc tài liệu phù hợp", câu hỏi được ghi vào `public.copilot_question_gaps` (nội dung chuẩn hóa, số lần gặp, người hỏi gần nhất). OWNER mở **Tài liệu cửa hàng** (`/docs`) để xem khối "Câu hỏi chưa có tài liệu"; mỗi câu xuất hiện nhiều lần là tín hiệu cần viết ngay một SOP cho nó vào `docs/INTERNAL_SOPS.md` rồi chạy lại bước ở mục trên.
