-- Migration: 20261009000100_plate_display_format.sql
-- Description: Đổi QUY ƯỚC TRÌNH BÀY biển số sang dạng gạch nối liền dãy đầu:
--   `92-D1 746.75` → `92D1-746.75` (đọc đúng như biển dập — cụm tỉnh + series
--   dính liền, một gạch nối tách dãy số cuối). Đây là thay đổi SEPARATOR thuần
--   hiển thị: dạng nén chỉ chữ+số dùng để chống trùng KHÔNG đổi, nên suy trùng,
--   tra soát, phiếu và nhật ký vẫn khớp như cũ.
--   `src/lib/plate.ts` là nguồn định dạng duy nhất cho dữ liệu mới; migration
--   này chỉ viết lại các hàng đã lưu theo kiểu cũ để mọi màn hình thống nhất.
--   Không đụng `updated_at` (đây không phải một lần sửa nghiệp vụ của nhân viên)
--   và không sinh bản ghi audit/notification vì audit ghi ở tầng RPC.
-- Forward-only. Không xoá dữ liệu, không sửa migration đã áp.

BEGIN;

-- Chỉ khớp đúng canonical cũ: tỉnh(2) - chữ(1-2)+số series(1) [khoảng trắng] serial,
-- với serial 3–6 chữ số (đã nhóm `###.##` khi 5 chữ số). Mọi giá trị khác — biển
-- tự gõ, mã nội bộ, số khung, biển ô tô dạng `51H-123.45` — giữ nguyên.
UPDATE public.vehicles
SET license_plate = regexp_replace(
  license_plate,
  '^([0-9]{2})-([A-Z]{1,2}[0-9]) ([0-9]{3,6}(?:\.[0-9]{2})?)$',
  '\1\2-\3'
)
WHERE license_plate ~ '^([0-9]{2})-([A-Z]{1,2}[0-9]) ([0-9]{3,6}(\.[0-9]{2})?)$';

COMMENT ON COLUMN public.vehicles.license_plate IS
  'Bien so hien thi theo dang canonical moi: tinh+series liet, gach noi tach day so cuoi (92D1-746.75). Rong = chua co bien. Nguon dinh dang: src/lib/plate.ts.';

COMMIT;
