# BÁO CÁO KIỂM TOÁN VÀ PHỤC HỒI HỆ THỐNG XÁC THỰC (AUTH RECOVERY AUDIT)
*Dự án: Xe CRM — Quản lý Cửa hàng Xe máy Cà Rém*  
*Thời gian kiểm toán: 2026-09-30*  
*Môi trường: Supabase Production (`atsgqtarxhmxrsugulva`)*

---

## 1. TỔNG QUAN HIỆN TRẠNG KIẾN TRÚC XÁC THỰC

Hệ thống đã trải qua chuỗi các bản vá di chuyển tự phát từ `20260930000600_username_auth.sql` đến `20260930002100_reset_owner_password_service_role.sql` nhằm hỗ trợ đăng nhập bằng tên người dùng (username). Quá trình này đã tích tụ nhiều xung đột kiến trúc nghiêm trọng:

1. **Ghi đè trực tiếp Auth Email của Chủ cửa hàng (OWNER)**:
   - Bản di chuyển `20260930001700_force_sync_all_emails.sql` đã duyệt qua tất cả tài khoản trong `public.profiles` và cưỡng bức cập nhật `auth.users.email = username || '@internal.xecrm.app'`.
   - Kết quả: Email thật ban đầu của Owner (`macxuanhoa211002@gmail.com`) trong `auth.users` bị đổi thành `macxuanhoa21100211@internal.xecrm.app`, trong khi danh tính ban đầu trong `auth.identities` vẫn là `macxuanhoa211002@gmail.com`.
   - Màn hình đăng nhập `LoginPage.tsx` ép mọi chuỗi nhập liệu gắn đuôi `@internal.xecrm.app`, khiến việc đăng nhập bằng email thật của Owner hoặc khôi phục mật khẩu qua Supabase Auth native bị tê liệt hoàn toàn.

2. **Lưu trữ mật khẩu dạng Plaintext và can thiệp trực tiếp vào `auth.users` bằng SQL**:
   - `private.password_reset_requests` được tạo ra để lưu `username` và `new_password` (dạng văn bản thô plaintext!). Hiện tồn tại một bản ghi chứa mật khẩu chưa mã hóa.
   - Hàm `private.reset_password_direct` và `private.process_password_reset` can thiệp trực tiếp vào cột `auth.users.encrypted_password = crypt(..., gen_salt('bf'))`. Điều này vi phạm nghiêm trọng nguyên tắc an ninh dữ liệu và chuẩn vận hành của Supabase Auth.

3. **Lỗ hổng phân quyền RLS trên bảng `public.profiles`**:
   - `20260930001000_fix_rls_and_sync_auth.sql` tạo policy `profiles_update` với điều kiện `id = auth.uid() OR private.current_role() = 'OWNER'` mà **không có WITH CHECK**, đồng thời `GRANT DELETE` cho `authenticated`.
   - Người dùng đăng nhập có thể gửi trực tiếp câu lệnh SQL UPDATE để đổi `role = 'OWNER'`, `active = true`, tự leo thang đặc quyền.

4. **Xung đột khóa ngoại khi xóa tài khoản**:
   - Khóa ngoại `profiles.id REFERENCES auth.users(id) ON DELETE RESTRICT` ngăn chặn việc xóa tài khoản trực tiếp từ `auth.users`.
   - Edge Function `manage-users` cố gắng gọi `admin.auth.admin.deleteUser(userId)` với giả định rằng profile sẽ tự cascade delete, dẫn đến lỗi thất bại khi xóa người dùng.

5. **Kiểm tra thời gian và lịch làm việc thiếu Timezone chuẩn**:
   - `AuthProvider.tsx` kiểm tra giờ làm việc dựa trên đồng hồ cục bộ của trình duyệt khách.
   - Hàm `private.can_user_login()` trong CSDL dùng `now()::time` và `EXTRACT(ISODOW FROM now())` mà không chỉ định múi giờ kinh doanh `Asia/Ho_Chi_Minh`.
   - OWNER không được miễn trừ tường minh trong các ràng buộc lịch làm việc, có nguy cơ bị khóa ngoài do cấu hình mặc định.

---

## 2. DỮ LIỆU ĐANG TỒN TẠI (PRODUCTION SNAPSHOT)

### 2.1. Dữ liệu bảng kinh doanh
- `vehicles`: 0 bản ghi
- `acquisitions`: 0 bản ghi
- `sales`: 0 bản ghi
- `payments`: 0 bản ghi
- `vehicle_expenses`: 0 bản ghi
- `business_expenses`: 0 bản ghi
- `audit_logs`: 2 bản ghi (Lưu vết thay đổi cập nhật thông tin người dùng ban đầu)

### 2.2. Danh sách tài khoản hiện hữu trong Production (Đã khử thông tin nhạy cảm)
| Auth User ID | Auth Email hiện tại | Identity Email gốc | Profile Username | Họ và tên | Vai trò | Active | Lịch làm việc |
|---|---|---|---|---|---|---|---|
| `f5028720-6110-41e7-ad2f-1c3f24af8e69` | `macxuanhoa21100211@internal.xecrm.app` | `macxuanhoa211002@gmail.com` | `macxuanhoa21100211` | Ông chủ Cà rem | **OWNER** | **true** | Không giới hạn |
| `854aae82-a2b8-445b-b4a9-967b0b0252dc` | `nguyenb11@internal.xecrm.app` | `nguyenb11@internal.xecrm.app` | `nguyenb11` | Người dùng mới | VIEWER | false | Mặc định |
| `1dfc523a-b4d5-4458-b339-82c4ee5ca601` | `phoang.le2409@internal.xecrm.app` | `phoang.le2409@internal.xecrm.app` | `phoang.le2409` | Người dùng mới | VIEWER | false | Mặc định |

---

## 3. CHI TIẾT CÁC CƠ CHẾ SAI LỆCH VÀ BẢN VÁ CẦN LOẠI BỎ

| Cơ chế bị lỗi / Nguy hiểm | Vị trí định nghĩa | Rủi ro / Nguyên nhân lỗi | Biện pháp sửa chữa |
|---|---|---|---|
| Bảng `private.password_reset_requests` | `20260930002100_...sql` | Chứa cột `new_password TEXT` lưu mật khẩu thô. | Xóa bảng / Drop table, xóa sạch dữ liệu nhạy cảm. |
| Hàm `private.reset_password_direct` | `20260930001900_...sql` | Ghi trực tiếp vào `auth.users.encrypted_password`. | Thu hồi quyền, Drop function. Dùng Supabase Admin API. |
| Hàm `private.process_password_reset` | `20260930002100_...sql` | Quét bảng và ghi trực tiếp `encrypted_password`. | Drop function. |
| Hàm `private.sync_auth_email` | `20260930001700_...sql` | Ghi trực tiếp `auth.users.email = username || '@internal...'`. | Drop function. Không dùng SQL sửa auth email. |
| Trigger `private.new_auth_user` | `20260930001700_...sql` | Cố ý tự động cập nhật `auth.users.email` trong trigger. | Viết lại trigger: Chỉ khởi tạo `public.profiles`, tuyệt đối không mutate `auth.users`. |
| Policy `profiles_update` trên `profiles` | `20260930001000_...sql` | Cho phép `authenticated` UPDATE profile mà không kiểm tra trường nhạy cảm (`role`, `active`). | Thu hồi `GRANT UPDATE, DELETE`, xóa policy sai, trả lại nguyên tắc: Mọi cập nhật profile qua RPC `update_profile` hoặc Edge Function OWNER. |
| Policy `profiles_delete` trên `profiles` | `20260930001000_...sql` | `GRANT DELETE` cho `authenticated`. | Thu hồi quyền DELETE từ client. |
| Hard delete trong Edge Function `manage-users` | `manage-users/index.ts` | Gọi `admin.auth.admin.deleteUser` khi còn ràng buộc RESTRICT tại `profiles`. | Kiểm tra ràng buộc kinh doanh trước khi hard delete tài khoản chưa dùng; ưu tiên Soft Deactivate. |
| Ép email ảo tại `LoginPage.tsx` | `LoginPage.tsx` | `username` được ghép cứng `@internal.xecrm.app` bất kể có `@` hay không. | Hỗ trợ đăng nhập kép: Nếu có `@` -> Email thật; Nếu không có `@` -> Resolve hoặc dùng alias nội bộ. |

---

## 4. KẾ HOẠCH HÀNH ĐỘNG PHỤC HỒI (RECOVERY ROADMAP)

1. **Bảo vệ và phục hồi tài khoản OWNER**:
   - Sử dụng Admin API / Forward migration để khôi phục `auth.users.email` của OWNER về `macxuanhoa211002@gmail.com`, đồng bộ với `auth.identities`.
   - Giữ nguyên `profile.username = 'macxuanhoa21100211'` (hoặc rút gọn nếu hợp lệ) nhưng tách rời khỏi Auth email.
   - Đảm bảo tài khoản OWNER luôn có `active = true`, không bị khóa bởi lịch trình hay giờ giấc.

2. **Dọn dẹp bảng và hàm độc hại**:
   - Tạo migration mới `20260930002200_auth_recovery_and_account_control.sql` (Forward-only, tuyệt đối không sửa migration cũ).
   - Xóa bảng `private.password_reset_requests` và hủy các hàm SQL can thiệp `auth.users`.
   - Siết chặt RLS trên `public.profiles`: Thu hồi `UPDATE`, `DELETE` trực tiếp từ phía client.

3. **Củng cố kiểm soát lịch truy cập và Múi giờ**:
   - Chuẩn hóa múi giờ kinh doanh: `Asia/Ho_Chi_Minh`.
   - Cập nhật hàm `private.is_active()` và `private.current_role()` để kiểm tra trạng thái hoạt động thực tế (`active`, `disabled_until`, `allowed_from`, `allowed_until`, `working_days`, `deleted_at`).
   - Miễn trừ tường minh vai trò `OWNER` khỏi các giới hạn giờ giấc làm việc của nhân viên.

4. **Tái cấu trúc Edge Function `manage-users`**:
   - Chỉ cho phép OWNER thao tác.
   - Tạo người dùng: Atomic & Rollback an toàn (nếu tạo profile thất bại thì rollback Auth user).
   - Đặt lại mật khẩu: Sử dụng `admin.auth.admin.updateUserById(userId, { password })` và đánh dấu `must_change_password = true`.
   - Xóa người dùng: Mặc định Deactivate (`active = false`, `deleted_at = now()`). Chỉ cho phép Hard Delete nếu tài khoản **hoàn toàn chưa từng phát sinh dữ liệu nghiệp vụ** (kiểm tra `acquisitions`, `vehicles`, `sales`, `payments`, `expenses`, `audit_logs`).

5. **Cải tiến UI & AuthProvider**:
   - `LoginPage.tsx`: Nhập email (chứa `@`) hoặc username (không chứa `@`).
   - `AuthProvider.tsx`: Luồng xác thực gọn gàng, tính toán múi giờ Việt Nam, xử lý thông báo tiếng Việt thân thiện khi tài khoản bị khóa/hết giờ làm việc.
   - `UsersPage.tsx`: Loại bỏ các nút vá lỗi (như nút "Đồng bộ email"), hoàn thiện giao diện quản lý phân quyền, lịch làm việc, đổi mật khẩu tạm.
