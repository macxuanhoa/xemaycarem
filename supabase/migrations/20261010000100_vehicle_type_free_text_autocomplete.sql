-- Migration: 20261010000100_vehicle_type_free_text_autocomplete.sql
-- Description: "Loại xe" chuyển từ danh mục chọn-cố-định sang tên nhập tự do
--   có autocomplete. Nhân viên (STAFF/MANAGER/OWNER) gõ thẳng tên mẫu xe
--   ("Honda Vision", "SH 125i", …); khi lưu server tự chuẩn hoá và get-or-create
--   vào public.vehicle_types (giữ nguyên FK vehicles.vehicle_type_id, yêu cầu #9).
--   Nguồn GỢI Ý cho ô nhập là DISTINCT vehicle_type suy từ xe đã lưu trong Kho,
--   không phải danh mục seed — xem src/lib/vehicleSuggestions.ts phía client.
-- * Không xoá/sửa dữ liệu xe hiện hữu: không map lại, không đụng vehicle_type_id
--   cũ. 6 dòng seed rỗng (không có xe) chỉ đơn giản không còn xuất hiện trong
--   list_vehicle_types (nay lọc theo "đang có xe"), nên Kho/bộ lọc gọn lại.
-- * vehicle_type_input trở thành VOLATILE (có ghi): vì vậy validate_import_vehicles
--   (STABLE) không còn gọi nó; kiểm loại xe bằng chuẩn hoá + độ dài thuần tuý,
--   tên mới luôn hợp lệ vì sẽ được tạo khi import.
-- Forward-only. NOTIFY pgrst để PostgREST nạp lại signature hàm.

BEGIN;

-- ============================================================
-- 1. get-or-create tên loại xe đã chuẩn hoá (chống race, giữ casing lần đầu)
-- ============================================================

CREATE OR REPLACE FUNCTION private.ensure_vehicle_type(p_name text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_norm text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_id uuid;
BEGIN
  -- Rỗng qui về hàng đợi an toàn 'Chưa phân loại' (giữ NOT NULL cho xe tạo mới).
  IF v_norm = '' THEN
    v_norm := 'Chưa phân loại';
  END IF;
  IF char_length(v_norm) < 2 OR char_length(v_norm) > 60 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_TYPE_NAME';
  END IF;
  -- Tái sử dụng loại đã có: khớp không phân biệt hoa/thường sau chuẩn hoá,
  -- giữ nguyên cách viết người nhập đầu tiên (không đổi hoa thường).
  SELECT id INTO v_id FROM public.vehicle_types
  WHERE lower(btrim(name)) = lower(v_norm);
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  BEGIN
    INSERT INTO public.vehicle_types(name) VALUES (v_norm) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- Hai request tạo cùng tên song song: kẻ thua đọc lại dòng kẻ thắng đã cam kết.
    SELECT id INTO v_id FROM public.vehicle_types
    WHERE lower(btrim(name)) = lower(v_norm);
  END;
  RETURN v_id;
END $$;

-- ============================================================
-- 2. Chuẩn hoá loại xe khi ghi: ưu tiên id hợp lệ, còn lại get-or-create theo tên
-- ============================================================

-- VOLATILE (không còn STABLE) vì nhánh tạo tên mới có INSERT. Mọi lời gọi nằm
-- trong đường GHI (acquire_vehicle / save_vehicle / import_vehicles), không có
-- caller STABLE nào còn dùng hàm này.
CREATE OR REPLACE FUNCTION private.vehicle_type_input(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id_raw text := btrim(coalesce(p_data->>'vehicle_type_id', ''));
  v_name_raw text := btrim(coalesce(p_data->>'vehicle_type', ''));
  v_id uuid;
  v_id_is_uuid boolean := false;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  -- Ưu tiên id trực tiếp (đường sửa hồ sơ gửi vehicle_type_id cũ đang tồn tại).
  IF v_id_raw <> '' THEN
    BEGIN
      v_id := v_id_raw::uuid;
      v_id_is_uuid := true;
    EXCEPTION WHEN invalid_text_representation THEN
      v_id := NULL;
    END;
    IF v_id_is_uuid THEN
      IF EXISTS (SELECT 1 FROM public.vehicle_types WHERE id = v_id) THEN
        RETURN v_id;
      END IF;
      RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_TYPE';
    END IF;
    -- ô id chứa chuỗi không phải uuid (CSV ghi tên vào đây): dùng làm tên dự phòng.
    IF v_name_raw = '' THEN
      v_name_raw := v_id_raw;
    END IF;
  END IF;
  -- Tên tự do: chuẩn hoá + get-or-create. STAFF tạo được, không cần OWNER thêm trước.
  RETURN private.ensure_vehicle_type(v_name_raw);
END $$;

-- Bản tùy chọn cho CẬP NHẬT từng phần: thiếu cả hai key thì giữ loại đang có
-- (trả NULL), nhưng key đã gửi mà không hợp lệ vẫn bị từ chối — không âm thầm bỏ.
CREATE OR REPLACE FUNCTION private.vehicle_type_input_optional(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  IF btrim(coalesce(p_data->>'vehicle_type_id', '')) = ''
     AND btrim(coalesce(p_data->>'vehicle_type', '')) = '' THEN
    RETURN NULL;
  END IF;
  RETURN private.vehicle_type_input(p_data);
END $$;

-- ============================================================
-- 3. validate_import_vehicles (STABLE): thôi gọi vehicle_type_input VOLATILE,
--    chỉ yêu cầu tên có sau chuẩn hoá và đúng độ dài (mọi tên mới đều hợp lệ).
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_import_vehicles(p_vehicles jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_row jsonb;
  v_index integer;
  v_field text;
  v_value text;
  v_seen_frames text[] := ARRAY[]::text[];
  v_seen_plates text[] := ARRAY[]::text[];
  v_duplicates jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_date date;
  v_number integer;
BEGIN
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;
  IF jsonb_array_length(p_vehicles) > 500 THEN RAISE EXCEPTION USING errcode = '22023', message = 'IMPORT_BATCH_TOO_LARGE'; END IF;
  FOR v_row, v_index IN SELECT value, (ordinality - 1)::integer FROM jsonb_array_elements(p_vehicles) WITH ORDINALITY LOOP
    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', '', 'message', 'INVALID_INPUT');
      CONTINUE;
    END IF;
    FOREACH v_field IN ARRAY ARRAY['frame_number','license_plate'] LOOP
      v_value := upper(btrim(coalesce(v_row->>v_field, '')));
      IF length(v_value) > (CASE WHEN v_field = 'license_plate' THEN 30 ELSE 100 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
      IF v_field = 'license_plate' THEN
        v_value := regexp_replace(v_value, '[^A-Z0-9]', '', 'g');
      END IF;
      IF v_value <> '' THEN
        IF (v_field = 'frame_number' AND (v_value = ANY(v_seen_frames) OR EXISTS (SELECT 1 FROM public.vehicles WHERE upper(btrim(frame_number)) = v_value)))
          OR (v_field = 'license_plate' AND (v_value = ANY(v_seen_plates) OR EXISTS (SELECT 1 FROM public.vehicles WHERE regexp_replace(upper(license_plate), '[^A-Z0-9]', '', 'g') = v_value))) THEN
          v_duplicates := v_duplicates || jsonb_build_object('index', v_index, 'field', v_field, 'value', v_value, 'message',
            CASE v_field WHEN 'frame_number' THEN 'Số khung đã tồn tại hoặc trùng trong file' ELSE 'Biển số đã tồn tại hoặc trùng trong file' END);
        END IF;
        IF v_field = 'frame_number' THEN v_seen_frames := array_append(v_seen_frames, v_value);
        ELSE v_seen_plates := array_append(v_seen_plates, v_value); END IF;
      END IF;
    END LOOP;
    -- Loại xe là tên tự do, sẽ được server tạo mới khi import; chỉ cần có sau
    -- chuẩn hoá và đúng độ dài 2..60. Không còn chặn "không có trong danh mục".
    v_value := btrim(regexp_replace(coalesce(v_row->>'vehicle_type', v_row->>'vehicle_type_id', ''), '\s+', ' ', 'g'));
    IF v_value = '' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'vehicle_type', 'message', 'VEHICLE_TYPE_REQUIRED');
    ELSIF char_length(v_value) < 2 OR char_length(v_value) > 60 THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'vehicle_type', 'message', 'INVALID_VEHICLE_TYPE_NAME');
    END IF;
    FOREACH v_field IN ARRAY ARRAY['color','supplier_name','supplier_phone','notes'] LOOP
      IF length(coalesce(v_row->>v_field, '')) > (CASE v_field
        WHEN 'color' THEN 80 WHEN 'supplier_name' THEN 200
        WHEN 'supplier_phone' THEN 40 ELSE 10000 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
    END LOOP;
    BEGIN
      PERFORM private.money_input(v_row, 'purchase_price', 0);
      IF NOT private.can_financials() AND v_row ? 'purchase_price' THEN
        RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
      END IF;
    EXCEPTION WHEN invalid_parameter_value OR insufficient_privilege THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'purchase_price', 'message', SQLERRM);
    END;
    BEGIN
      IF nullif(v_row->>'purchase_date', '') IS NOT NULL AND v_row->>'purchase_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PURCHASE_DATE';
      END IF;
      v_date := coalesce(nullif(v_row->>'purchase_date', '')::date, private.today());
      IF v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_DATE_IN_FUTURE'; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'purchase_date', 'message', 'INVALID_PURCHASE_DATE');
    END;
    v_value := nullif(v_row->>'year', '');
    IF v_value IS NOT NULL THEN
      BEGIN
        IF v_value !~ '^[0-9]+$' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER'; END IF;
        v_number := v_value::integer;
        IF v_number NOT BETWEEN 1900 AND 2100 THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER'; END IF;
      EXCEPTION WHEN invalid_parameter_value OR numeric_value_out_of_range OR invalid_text_representation THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'year', 'message', 'INVALID_YEAR');
      END;
    END IF;
    IF v_row ? 'status' AND v_row->>'status' IS DISTINCT FROM 'IN_STOCK' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'status', 'message', 'INVALID_VEHICLE_STATUS');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('duplicates', v_duplicates, 'errors', v_errors);
END $$;

-- ============================================================
-- 4. Tự kiểm chứng: hàm mới phải tồn tại và signature VOLATILE đúng.
--    (list_vehicle_types GIỮ nguyên hành vi cũ: mọi loại + count, vì bộ lọc Kho,
--    trang Cài đặt OWNER và 3 suite DB đang dựa vào bề mặt danh mục đầy đủ. Gợi ý
--    cho Ô NHẬP "Loại xe" lấy từ vehicleSuggestions(list_vehicles) phía client,
--    không phụ thuộc list_vehicle_types — nên không cần sửa hàm này ở đợt này.)
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'private' AND p.proname = 'vehicle_type_input' AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: vehicle_type_input phải là VOLATILE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'private' AND p.proname = 'ensure_vehicle_type') THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: thiếu private.ensure_vehicle_type';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
