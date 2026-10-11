-- 11/10/2026: Xe chưa có số khung phải hiển thị "chưa có khung", KHÔNG lộ mã
-- placeholder `GEN-<uuid>` mà server tự sinh khi lưu (save_vehicle/acquire_vehicle).
-- Placeholder vẫn nằm nguyên trong cột frame_number (giữ UNIQUE và dấu vết kỹ thuật);
-- chỉ lớp định danh hiển thị — tiêu đề danh sách, chi tiết, phiếu in, thông báo,
-- tìm kiếm, copilot — mới ẩn nó, khớp đúng quy ước client src/lib/vehicleDisplay.ts.
--
-- vehicle_label_text trước đây chỉ coi frame_number là trống khi chuỗi rỗng,
-- nên xe GEN hiển thị "Biển · GEN-a1b2c3d4e5f6" như thể đó là số khung thật.

CREATE OR REPLACE FUNCTION private.vehicle_label_text(
  p_license_plate text, p_frame_number text, p_internal_code text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN f.plate <> '' AND f.frame <> ''
      THEN f.plate || ' · ' || f.frame
    WHEN f.plate <> ''
      THEN f.plate || ' · chưa có khung'
    WHEN f.frame <> ''
      THEN 'chưa có biển · ' || f.frame
    ELSE coalesce(nullif(btrim(coalesce(p_internal_code, '')), ''), 'xe không rõ danh tính')
  END
  FROM (
    SELECT
      btrim(coalesce(p_license_plate, '')) AS plate,
      -- Mã placeholder GEN-… (kể cả biến thể hoa/thường/dấu cách đầu chuỗi)
      -- không phải số khung thật → coi như chưa có khung.
      CASE
        WHEN btrim(coalesce(p_frame_number, '')) = ''
          OR upper(btrim(p_frame_number)) LIKE 'GEN-%'
        THEN ''
        ELSE btrim(p_frame_number)
      END AS frame
  ) f;
$$;
