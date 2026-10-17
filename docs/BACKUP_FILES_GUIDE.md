# Thư mục này chứa gì — đọc từ trên xuống

Có hai loại file trong đây. Đừng nhầm, vì loại A là để **khôi phục thật**, còn loại B là
để **con người đọc và đem cất**.

## A. Bản gốc máy dùng để khôi phục (KHÔNG ĐỔI TÊN — đổi là mất đường lùi)

Tên luôn dạng: `carem-prod-<ngày>-<giờ>-<giây> - <loại>.<đuôi>`

| Đuôi / hậu tố | Bên trong là gì | Quan trọng mức nào |
|---|---|---|
| `-schema.sql` | Toàn bộ khung database: bảng, quyền xem (RLS), hàm, trigger, kiểu dữ liệu | ⭐⭐⭐ bắt buộc |
| `-data.sql` | Toàn bộ dữ liệu: xe, thu xe, **lịch sử bán**, **thanh toán**, công nợ, chi phí, **giao dịch ngân hàng**, audit, hồ sơ nhân viên, tài khoản đăng nhập | ⭐⭐⭐ bắt buộc |
| `-storage/` (thư mục) | **Ảnh xe** và **ảnh CCCD/giấy tờ** — pg_dump KHÔNG chứa ảnh, nên ảnh lưu riêng ở đây | ⭐⭐⭐ bắt buộc |
| `-storage-inventory.json` | Danh sách từng ảnh + mã băm SHA-256 + cấu hình bucket (private/public, giới hạn dung lượng) | ⭐⭐ |
| `-migration-history.txt` | Database đang ở phiên bản nào, đã nâng cấp những bước nào | ⭐⭐ |
| `-rebuild-kit.json` | Cấu hình nền để dựng project MỚI: số tài khoản nhận tiền, cờ webhook, extension, lịch cron, danh sách function đã deploy, **tên** các biến bí mật (không chứa giá trị) | ⭐⭐⭐ |
| `-HUONG-DAN-KHOI-PHUC.md` | Hướng dẫn từng bước dựng lại web + dữ liệu + ảnh trên một project mới | ⭐⭐⭐ đọc file này trước |
| `-MANIFEST.md` | Danh sách mọi file của bản + mã băm từng file + số dòng từng bảng | ⭐⭐ |

Mỗi bộ có đủ 8 mục trên mới được coi là **điểm khôi phục hoàn chỉnh**. Bộ nào thiếu
`-MANIFEST.md` nghĩa là đang dở dang (script hỏng giữa chừng) — **không tin dùng**.

## B. Bản ZIP tên tiếng Việt — dành cho chủ cửa hàng cất ra ngoài máy

Tên dạng: `Cà Rem - Sao lưu dữ liệu và ảnh xe - 17-10-2026 lúc 21h30m08s.zip`

Bên trong là y hệt bộ gốc, nhưng đổi tên thân thiện và sắp xếp dễ hiểu:

```
00 - ĐỌC TRƯỚC - Cách dựng lại web từ bản sao lưu.md
01 - Cấu trúc cơ sở dữ liệu.sql
02 - Dữ liệu cửa hàng.sql
03 - Lịch sử cập nhật hệ thống.txt
04 - Danh mục ảnh và đường dẫn khôi phục.json
05 - Thông tin và mã kiểm tra bản sao lưu gốc.md
06 - Bộ dựng lại hệ thống (cấu hình, cron, tên secret).json
Ảnh xe/Xe 01 - <nhãn hiệu> - <biển số>/Ảnh 01 - <...>.jpg
Ảnh giấy tờ/Hồ sơ 01 - CCCD <tên>/Ảnh 01 - Mặt trước CCCD.jpg
```

Chính ZIP này là thứ **phải được chép sang Google Drive (hoặc nơi thứ ba)**. Nó chứa mật
khẩu khách hàng và hash mật khẩu nhân viên: chỉ cất ở nơi riêng tư, không gửi chat,
không upload công khai.

## File trạng thái / log

| File | Ý nghĩa |
|---|---|
| `LATEST.json` | Bản gần nhất thành công hay thất bại, bao nhiêu file, bao nhiêu ảnh. **Xem cái này khi nghi backup không chạy.** |
| `verify-<bản>.json` | Kết quả **thử khôi phục thật** (nạp lại database tạm rồi đối chiếu số dòng). `ok: true` nghĩa là dựng lại được. |
| `integrity-<bản>.json` | Kết quả kiểm mã băm + giải mã ảnh (nhanh, không dựng lại). |
| `scheduler.log` | Nhật chạy hằng đêm của worker. |
| `backup.log`, `retention.log` | Diễn biến từng lần backup và lần xoá bản cũ theo giữ-lại 7 ngày/4 tuần/12 tháng. |
| `offsite.txt` | Khai báo nơi cất thứ hai (Google Drive). **Chỉ có dòng chú thích `#` nghĩa là chưa khai báo → không tự copy ra Drive.** |
| `cloud-target.json` | ZIP mới nhất, SHA-256, đã sang Drive chưa. |

## Ba câu hỏi hay gặp

**"Backup có tự chạy không?"** — Có, Windows Task Scheduler tên `Carem CRM - daily
production backup`, hằng ngày lúc **01:00**, tự bật Docker nếu đang tắt. Mở
`scheduler.log` mà không có dòng hôm nay nghĩa là nó chết.

**"Mất web / đổi database thì làm sao?"** — Mở `00 - ĐỌC TRƯỚC - Cách dựng lại web từ
bản sao lưu.md` trong ZIP, làm theo 7 bước. Ảnh nằm riêng trong thư mục `Ảnh xe` /
`Ảnh giấy tờ` vì pg_dump không chứa ảnh.

**"Nhẹ bớt được không?"** — Bản ZIP luôn gồm đủ để khôi phục không mất dữ liệu. Phần
chỉ để tham khảo (bảng đồng hồ xe, nhật ký thao tác, tài liệu trợ lý có thể tái tạo từ
mã nguồn) vẫn nằm trong `-data.sql` vì tách ra là mất dấu vết kiểm toán; chủ cửa hàng
quyết, còn mặc định là **thà thừa còn hơn thiếu**.
