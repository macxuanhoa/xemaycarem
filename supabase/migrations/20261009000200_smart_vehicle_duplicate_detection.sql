-- Migration: 20261009000200_smart_vehicle_duplicate_detection.sql
-- Mô tả: Phát hiện trùng THÔNG MINH cho quy trình nhập/thu xe.
--   * Cho phép nhập nhanh 5 ký tự CUỐI số khung (kind = PARTIAL) nhưng vẫn giữ
--     danh tính cứng cho số khung ĐẦY ĐỦ (kind = FULL).
--   * KHÔNG có UNIQUE cứng cho biển số / 5 ký tự cuối / tổ hợp rút gọn. Đó là
--     "khóa nghi trùng", không phải khóa định danh.
--   * Ba mức GREEN/YELLOW/RED tính ở TẦNG SERVER, bắt buộc kiểm tra lại khi lưu,
--     và chống race bằng pg_advisory_xact_lock khi hai nhân viên gửi cùng giây.
--   * brand/model/variant KHÔNG quay lại; vehicle_type chỉ là gợi ý xếp hạng,
--     không phải thành phần khóa.
-- Forward-only. Không sửa migration đã áp. Chạy pre-flight để fail-closed nếu
-- dữ liệu cũ có số khung FULL trùng sau khi nén ký tự (tiền lệ 20261006000400).

BEGIN;

-- ============================================================
-- 0. Pre-flight: hai số khung ĐẦY ĐỦ khác nhau nhưng nén về cùng một chuỗi
--    chữ+số sẽ thành xung đột khi dựng index FULL. Fail-closed cho vận hành sửa.
-- ============================================================
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(x.frame_compact, ', ' ORDER BY x.frame_compact) INTO v_bad
  FROM (
    SELECT regexp_replace(upper(btrim(frame_number)), '[^A-Z0-9]', '', 'g') AS frame_compact,
           count(*) AS n
    FROM public.vehicles
    WHERE btrim(frame_number) <> '' AND frame_number NOT LIKE 'GEN-%'
      AND status <> 'CANCELLED'
      AND length(regexp_replace(upper(btrim(frame_number)), '[^A-Z0-9]', '', 'g')) >= 11
    GROUP BY 1
    HAVING count(*) > 1
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'DUPLICATE_DETECTION_PREFLIGHT_FAILED: số khung FULL trùng sau chuẩn hóa cần đối chiếu thủ công: %', v_bad
      USING errcode = 'P0001';
  END IF;
END $$;

-- ============================================================
-- 1. Cột phân loại + cột sinh sẵn cho khớp & index
-- ============================================================
ALTER TABLE public.vehicles
  ADD COLUMN frame_input_kind text NOT NULL DEFAULT 'FULL'
    CHECK (frame_input_kind IN ('FULL','PARTIAL'));

ALTER TABLE public.vehicles
  ADD COLUMN frame_compact text GENERATED ALWAYS AS (
    CASE
      WHEN btrim(frame_number) = '' OR frame_number LIKE 'GEN-%' THEN ''
      ELSE regexp_replace(upper(btrim(frame_number)), '[^A-Z0-9]', '', 'g')
    END
  ) STORED;

ALTER TABLE public.vehicles
  ADD COLUMN frame_last5 text GENERATED ALWAYS AS (
    CASE
      WHEN btrim(frame_number) = '' OR frame_number LIKE 'GEN-%' THEN NULL
      ELSE right(regexp_replace(upper(btrim(frame_number)), '[^A-Z0-9]', '', 'g'), 5)
    END
  ) STORED;

ALTER TABLE public.vehicles
  ADD COLUMN plate_compact text GENERATED ALWAYS AS (
    CASE
      WHEN btrim(license_plate) = '' THEN NULL
      ELSE regexp_replace(upper(btrim(license_plate)), '[^A-Z0-9]', '', 'g')
    END
  ) STORED;

-- Phân loại lại dữ liệu cũ: VIN đủ dài (>=11 ký tự chữ+số) là FULL; ngắn hơn là
-- PARTIAL (đúng bản chất "mảnh rút gọn", và tránh dựng index FULL chặn oan các số
-- khung tự chế ngắn). GEN-placeholder giữ FULL (frame_compact rỗng, tự loại khỏi index).
UPDATE public.vehicles
SET frame_input_kind = CASE
  WHEN frame_compact = '' THEN 'FULL'
  WHEN length(frame_compact) >= 11 THEN 'FULL'
  ELSE 'PARTIAL'
END;

COMMENT ON COLUMN public.vehicles.frame_input_kind IS
  'FULL = số khung đầy đủ (danh tính cứng, UNIQUE nén). PARTIAL = mảnh rút gọn (thường 5 ký tự cuối), KHÔNG chặn cứng, chỉ phục vụ phát hiện nghi trùng.';
COMMENT ON COLUMN public.vehicles.frame_compact IS
  'Số khung nén còn chữ+số (hoa, bỏ khoảng trắng/ký tự khác). Rỗng khi chưa có hoặc GEN-placeholder.';
COMMENT ON COLUMN public.vehicles.frame_last5 IS
  '5 ký tự cuối của frame_compact, giữ nguyên số 0 đầu (kiểu text). NULL khi frame_compact rỗng.';
COMMENT ON COLUMN public.vehicles.plate_compact IS
  'Biển số nén còn chữ+số (hoa). NULL khi chưa có biển.';

-- ============================================================
-- 2. hoán đổi ràng buộc duy nhất: chỉ ép cho số khung ĐẦY ĐỦ
-- ============================================================
-- Bỏ UNIQUE toàn cột + index chuẩn-hoa-thường cũ (chặn oan hai xe cùng 5 ký tự cuối).
ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_frame_number_unique;
DROP INDEX IF EXISTS public.vehicles_canonical_frame_unique;

-- Danh tính cứng cho FULL: nén chữ+số, chỉ khi đã xác nhận là VIN đầy đủ.
-- Loại xe CANCELLED ra khỏi index: nghiệp vụ cho phép nhập lại một xe đã hủy,
-- nên danh tính cứng chỉ binding với xe "đang quản lý" (khớp máy phát hiện ở mục 5).
CREATE UNIQUE INDEX vehicles_full_frame_unique
  ON public.vehicles (frame_compact)
  WHERE frame_input_kind = 'FULL' AND frame_compact <> '' AND status <> 'CANCELLED';

-- Index phục vụ phát hiện (không UNIQUE).
CREATE INDEX vehicles_dedup_plate_frame
  ON public.vehicles (plate_compact, frame_last5)
  WHERE plate_compact IS NOT NULL AND frame_last5 IS NOT NULL;
CREATE INDEX vehicles_dedup_frame_last5
  ON public.vehicles (frame_last5) WHERE frame_last5 IS NOT NULL;
CREATE INDEX vehicles_dedup_plate
  ON public.vehicles (plate_compact) WHERE plate_compact IS NOT NULL;

-- ============================================================
-- 3. Bảng lịch sử xác minh / ghi đè nghi trùng
-- ============================================================
CREATE TABLE public.vehicle_duplicate_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor uuid REFERENCES public.profiles(id),
  context text NOT NULL CHECK (context IN ('LIVE','ACQUIRE','SAVE','IMPORT')),
  level text NOT NULL CHECK (level IN ('GREEN','YELLOW','RED')),
  reason text NOT NULL DEFAULT '',
  plate_compact text,
  frame_last5 text,
  frame_input_kind text CHECK (frame_input_kind IN ('FULL','PARTIAL')),
  candidate_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  acknowledged boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT ''
);
CREATE INDEX vehicle_duplicate_checks_created ON public.vehicle_duplicate_checks(created_at DESC);
ALTER TABLE public.vehicle_duplicate_checks ENABLE ROW LEVEL SECURITY;
-- Client không đọc/ghi trực tiếp: mỗi lần kiểm tra/ghi đè do RPC SECURITY DEFINER ghi.
REVOKE ALL ON public.vehicle_duplicate_checks FROM public, anon, authenticated;

-- ============================================================
-- 4. Chữ ký nén & helper phân loại (IMMUTABLE, dùng chung mọi tầng)
-- ============================================================
CREATE OR REPLACE FUNCTION private.frame_kind(p_frame_compact text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN coalesce(p_frame_compact,'') = '' THEN 'FULL'
    WHEN length(p_frame_compact) >= 11 THEN 'FULL'
    ELSE 'PARTIAL'
  END;
$$;

CREATE OR REPLACE FUNCTION private.plate_compact_of(p_plate text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_plate,'')) = '' THEN NULL
    ELSE nullif(regexp_replace(upper(btrim(p_plate)), '[^A-Z0-9]', '', 'g'), '')
  END;
$$;

CREATE OR REPLACE FUNCTION private.frame_compact_of(p_frame text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_frame,'')) = '' OR p_frame LIKE 'GEN-%' THEN ''
    ELSE regexp_replace(upper(btrim(p_frame)), '[^A-Z0-9]', '', 'g')
  END;
$$;

CREATE OR REPLACE FUNCTION private.frame_last5_of(p_frame_compact text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN coalesce(p_frame_compact,'') = '' THEN NULL ELSE right(p_frame_compact, 5) END;
$$;

-- ============================================================
-- 5. Máy phát hiện 3 mức (dùng chung cho RPC xem trước và khi ghi)
--    p_kind NULL → tự suy từ độ dài số khung nén.
--    Trả {level, reason, candidates[]}. ứng viên KHÔNG lộ trường tài chính.
-- ============================================================
CREATE OR REPLACE FUNCTION private.detect_vehicle_duplicates(
  p_frame text, p_plate text, p_kind text, p_exclude uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_compact text := private.frame_compact_of(p_frame);
  v_last5   text := private.frame_last5_of(private.frame_compact_of(p_frame));
  v_plate   text := private.plate_compact_of(p_plate);
  v_kind    text := coalesce(nullif(p_kind,''), private.frame_kind(v_compact));
  v_ids     uuid[];
  v_cands   jsonb := '[]'::jsonb;
BEGIN
  -- RED 1: số khung ĐẦY ĐỦ trùng xe đang quản lý (khác chính nó).
  IF v_kind = 'FULL' AND v_compact <> '' THEN
    SELECT coalesce(array_agg(v.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.vehicles v
    WHERE v.frame_input_kind = 'FULL' AND v.frame_compact = v_compact
      AND v.status <> 'CANCELLED' AND (p_exclude IS NULL OR v.id <> p_exclude);
    IF cardinality(v_ids) > 0 THEN
      RETURN private.duplicate_result('RED','FULL_FRAME_MATCH', v_ids);
    END IF;
  END IF;

  -- RED 2: cùng biển số VÀ cùng 5 ký tự cuối (bất kể loại xe).
  IF v_plate IS NOT NULL AND v_last5 IS NOT NULL THEN
    SELECT coalesce(array_agg(v.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.vehicles v
    WHERE v.plate_compact = v_plate AND v.frame_last5 = v_last5
      AND v.status <> 'CANCELLED' AND (p_exclude IS NULL OR v.id <> p_exclude);
    IF cardinality(v_ids) > 0 THEN
      RETURN private.duplicate_result('RED','PLATE_AND_LAST5', v_ids);
    END IF;
  END IF;

  -- RED 3: va chạm RÚT GỌN <-> ĐẦY ĐỦ cùng 5 ký tự cuối → không tự kết luận khác nhau.
  IF v_last5 IS NOT NULL THEN
    SELECT coalesce(array_agg(v.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.vehicles v
    WHERE v.frame_last5 = v_last5 AND v.frame_input_kind <> v_kind
      AND v.status <> 'CANCELLED' AND (p_exclude IS NULL OR v.id <> p_exclude);
    IF cardinality(v_ids) > 0 THEN
      RETURN private.duplicate_result('RED','NEED_VERIFY_PARTIAL_FULL', v_ids);
    END IF;
  END IF;

  -- YELLOW: trùng MỘT TRONG HAI (chỉ biển, hoặc chỉ 5 ký tự cuối cùng kiểu).
  IF v_plate IS NOT NULL OR v_last5 IS NOT NULL THEN
    SELECT coalesce(array_agg(v.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.vehicles v
    WHERE v.status <> 'CANCELLED' AND (p_exclude IS NULL OR v.id <> p_exclude)
      AND (
        (v_plate IS NOT NULL AND v.plate_compact = v_plate AND (v_last5 IS NULL OR v.frame_last5 <> v_last5))
        OR (v_last5 IS NOT NULL AND v.frame_last5 = v_last5 AND v.frame_input_kind = v_kind)
      );
    IF cardinality(v_ids) > 0 THEN
      RETURN private.duplicate_result('YELLOW','PARTIAL_MATCH', v_ids);
    END IF;
  END IF;

  RETURN jsonb_build_object('level','GREEN','reason','','candidates','[]'::jsonb);
END $$;

-- Chiếu ứng viên (id/nội bộ/biển/khung/kiểu/trạng thái/tiêu đề) cho popup đối chiếu.
CREATE OR REPLACE FUNCTION private.duplicate_result(
  p_level text, p_reason text, p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_cands jsonb := '[]'::jsonb;
BEGIN
  IF cardinality(p_ids) > 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'internal_code', v.internal_code, 'license_plate', v.license_plate,
      'frame_number', v.frame_number, 'frame_input_kind', v.frame_input_kind,
      'status', v.status::text,
      'vehicle_title', private.vehicle_display(v) ->> 'vehicle_title',
      'vehicle_subtitle', private.vehicle_display(v) ->> 'vehicle_subtitle'
    ) ORDER BY (v.status = 'IN_STOCK') DESC, v.created_at DESC), '[]'::jsonb)
    INTO v_cands
    FROM public.vehicles v WHERE v.id = ANY(p_ids);
  END IF;
  RETURN jsonb_build_object(
    'level', p_level, 'reason', p_reason,
    'candidates', v_cands, 'candidate_ids', to_jsonb(p_ids));
END $$;

-- RPC xem trước cho giao diện (STAFF+).
CREATE OR REPLACE FUNCTION public.check_vehicle_duplicates(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  RETURN private.detect_vehicle_duplicates(
    p_data->>'frame_number', p_data->>'license_plate',
    p_data->>'frame_input_kind',
    NULLIF(p_data->>'exclude_vehicle_id','')::uuid);
END $$;

-- ============================================================
-- 6. Tái-kiểm tra khi ghi + chống race. CHỈ sửa lớp _impl để giữ
--    protocol request_id của public.save_vehicle / acquire_vehicle.
-- ============================================================
-- acquire_vehicle_impl: tạo xe + phiếu thu atomic, giờ thêm khóa & chặn trùng.
CREATE OR REPLACE FUNCTION private.acquire_vehicle_impl(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_frame text := btrim(coalesce(p_data->>'frame_number', ''));
  v_plate text := btrim(coalesce(p_data->>'license_plate', ''));
  v_kind text := coalesce(nullif(p_data->>'frame_input_kind',''), '');
  v_compact text;
  v_last5 text;
  v_plate_c text;
  v_lock text;
  v_detect jsonb;
  v_level text;
  v_reason text;
  v_vehicle_id uuid;
  v_vehicle public.vehicles;
  v_acquisition public.acquisitions;
  v_purchase bigint := private.money_input(p_data, 'purchase_price');
  v_type uuid;
  v_date date := coalesce((p_data->>'acquisition_date')::date, private.today());
  v_fin boolean := private.can_financials();
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  v_type := private.vehicle_type_input(p_data);

  IF p_data ? 'purchase_price' AND NOT v_fin THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
  END IF;

  IF v_frame = '' THEN
    v_frame := 'GEN-' || substr(gen_random_uuid()::text, 1, 12);
  END IF;

  IF v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
  END IF;

  -- Chốt loại dữ liệu khung (FULL/PARTIAL) trước khi ghi.
  v_compact := private.frame_compact_of(v_frame);
  IF v_kind NOT IN ('FULL','PARTIAL') THEN
    v_kind := private.frame_kind(v_compact);
  END IF;
  v_last5 := private.frame_last5_of(v_compact);
  v_plate_c := private.plate_compact_of(v_plate);

  -- Serialize hai nhân viên cùng nhập một xe trong cùng giây.
  v_lock := coalesce(v_plate_c,'~') || '#' || coalesce(v_last5,'~') || '#' ||
            coalesce(nullif(v_compact,''),'~');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock, 0));

  v_detect := private.detect_vehicle_duplicates(v_frame, v_plate, v_kind, NULL);
  v_level := v_detect->>'level';
  v_reason := v_detect->>'reason';

  IF v_level = 'RED' THEN
    IF v_reason = 'FULL_FRAME_MATCH' THEN
      SELECT id INTO v_vehicle_id FROM public.vehicles
      WHERE frame_input_kind='FULL' AND frame_compact = v_compact AND status <> 'CANCELLED';
      IF v_vehicle_id IS NOT NULL THEN
        PERFORM 1 FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
      END IF;
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_FRAME_NUMBER';
    END IF;
    RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_SUSPECTED';
  ELSIF v_level = 'YELLOW' THEN
    IF coalesce((p_data->>'duplicate_ack')::boolean, false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_NEEDS_CONFIRM';
    END IF;
    INSERT INTO public.vehicle_duplicate_checks
      (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
       candidate_ids, acknowledged)
    VALUES (v_actor, 'ACQUIRE', 'YELLOW', v_reason, v_plate_c, v_last5, v_kind,
      (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
      true);
  END IF;

  INSERT INTO public.vehicles (
    frame_number, license_plate, frame_input_kind,
    vehicle_type_id, year, color,
    purchase_date, status,
    supplier_name, supplier_phone, notes, created_by
  ) VALUES (
    v_frame,
    v_plate,
    v_kind,
    v_type,
    nullif(p_data->>'year', '')::integer,
    btrim(coalesce(p_data->>'color', '')),
    v_date,
    'IN_STOCK'::public.vehicle_status,
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'notes', ''),
    v_actor
  ) RETURNING * INTO v_vehicle;

  INSERT INTO public.vehicle_financials (vehicle_id, purchase_price, updated_by)
  VALUES (v_vehicle.id, v_purchase, v_actor);

  INSERT INTO public.acquisitions (
    vehicle_id, acquisition_date, purchase_price,
    seller_name, seller_phone, notes, status, created_by
  ) VALUES (
    v_vehicle.id,
    v_date,
    coalesce(v_purchase, 0),
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'acquisition_notes', ''),
    'COMPLETED'::public.acquisition_status,
    v_actor
  ) RETURNING * INTO v_acquisition;

  PERFORM private.audit(
    'CREATE_ACQUISITION', 'acquisitions', v_acquisition.id,
    null,
    to_jsonb(v_acquisition) || jsonb_build_object('vehicle', to_jsonb(v_vehicle)),
    v_vehicle.id
  );

  PERFORM private.audit(
    'CREATE_VEHICLE', 'vehicles', v_vehicle.id,
    null,
    to_jsonb(v_vehicle)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_vehicle.vehicle_type_id)),
    v_vehicle.id
  );

  RETURN v_vehicle.id;
END $$;


-- save_vehicle_impl: thêm phân loại khung + tái phát hiện (exclude chính nó) chỉ khi
-- danh tính (biển/khung/kiểu) thực sự đổi, giữ nguyên các guard cũ (DELETE_PENDING,
-- expected_updated_at, SOLD_VEHICLE_LOCKED...).
CREATE OR REPLACE FUNCTION private.save_vehicle_impl(p_data jsonb, p_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.vehicles; v_new public.vehicles; v_purchase bigint; v_old_purchase bigint;
  v_status public.vehicle_status; v_date date; v_old_json jsonb;
  v_frame text; v_type uuid;
  v_kind text; v_kind_in text; v_plate text;
  v_compact text; v_last5 text; v_plate_c text; v_lock text;
  v_detect jsonb; v_level text; v_reason text; v_changed boolean;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;
  IF p_data ? 'purchase_price' AND NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='FINANCIAL_ACCESS_DENIED'; END IF;
  IF p_id IS NULL THEN
    v_type := private.vehicle_type_input(p_data);
  ELSE
    v_type := private.vehicle_type_input_optional(p_data);
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.vehicles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='VEHICLE_NOT_FOUND'; END IF;
    IF EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
      RAISE EXCEPTION USING errcode='22023',message='DELETE_PENDING';
    END IF;
    IF p_data ? 'expected_updated_at' AND v_old.updated_at IS DISTINCT FROM (p_data->>'expected_updated_at')::timestamptz THEN
      RAISE EXCEPTION USING errcode='40001',message='VEHICLE_EDIT_CONFLICT';
    END IF;
    IF p_data ? 'purchase_price' AND NOT private.can_financials() THEN
      RAISE EXCEPTION USING errcode='42501',message='FINANCIAL_ACCESS_DENIED';
    END IF;
    SELECT purchase_price INTO v_old_purchase FROM public.vehicle_financials WHERE vehicle_id = p_id;
  END IF;
  v_status := COALESCE((p_data->>'status')::public.vehicle_status, v_old.status, 'IN_STOCK');
  IF v_status = 'SOLD' AND (p_id IS NULL OR v_old.status <> 'SOLD') THEN RAISE EXCEPTION USING errcode='22023',message='USE_SELL_VEHICLE'; END IF;
  v_purchase := private.money_input(p_data, 'purchase_price', v_old_purchase);
  v_date := COALESCE((p_data->>'purchase_date')::date, v_old.purchase_date, private.today());
  IF v_date > private.today() THEN RAISE EXCEPTION USING errcode='22023',message='FUTURE_DATE'; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = p_id AND status = 'ACTIVE' AND expense_date < v_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_AFTER_EXPENSE';
  END IF;
  IF v_old.status = 'SOLD' AND (v_status <> 'SOLD' OR v_purchase IS DISTINCT FROM v_old_purchase
      OR v_date <> v_old.purchase_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='SOLD_VEHICLE_LOCKED';
  END IF;

  v_kind_in := nullif(p_data->>'frame_input_kind','');

  IF p_id IS NULL THEN
    v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), 'GEN-' || substr(gen_random_uuid()::text, 1, 12));
    v_kind := coalesce(v_kind_in, private.frame_kind(private.frame_compact_of(v_frame)));
    v_plate := btrim(coalesce(p_data->>'license_plate',''));
    v_changed := true;
  ELSE
    v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), v_old.frame_number);
    v_plate := btrim(COALESCE(p_data->>'license_plate', v_old.license_plate));
    IF p_data ? 'frame_number' OR v_kind_in IS NOT NULL THEN
      v_kind := coalesce(v_kind_in, private.frame_kind(private.frame_compact_of(v_frame)));
    ELSE
      v_kind := v_old.frame_input_kind;
    END IF;
    v_compact := private.frame_compact_of(v_frame);
    v_plate_c := private.plate_compact_of(v_plate);
    v_changed := v_compact IS DISTINCT FROM v_old.frame_compact
      OR v_plate_c IS DISTINCT FROM v_old.plate_compact
      OR v_kind <> v_old.frame_input_kind;
  END IF;
  v_compact := private.frame_compact_of(v_frame);
  v_last5 := private.frame_last5_of(v_compact);
  v_plate_c := private.plate_compact_of(v_plate);

  -- Chỉ kiểm khi danh tính đổi (tránh YELLOW oan khi sửa giá/màu/ngày).
  IF v_changed AND (v_plate_c IS NOT NULL OR v_last5 IS NOT NULL) THEN
    v_lock := coalesce(v_plate_c,'~') || '#' || coalesce(v_last5,'~') || '#' ||
              coalesce(nullif(v_compact,''),'~');
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock, 0));
    v_detect := private.detect_vehicle_duplicates(v_frame, v_plate, v_kind, p_id);
    v_level := v_detect->>'level';
    v_reason := v_detect->>'reason';
    IF v_level = 'RED' THEN
      IF v_reason = 'FULL_FRAME_MATCH' THEN
        RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_FRAME_NUMBER';
      END IF;
      RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_VEHICLE_SUSPECTED';
    ELSIF v_level = 'YELLOW' THEN
      IF coalesce((p_data->>'duplicate_ack')::boolean, false) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_VEHICLE_NEEDS_CONFIRM';
      END IF;
      INSERT INTO public.vehicle_duplicate_checks
        (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
         candidate_ids, acknowledged)
      VALUES (v_actor, 'SAVE', 'YELLOW', v_reason, v_plate_c, v_last5, v_kind,
        (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
        true);
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.vehicles(
      license_plate, vehicle_type_id, year, color, frame_number, frame_input_kind,
      purchase_date, status, supplier_name, supplier_phone, notes, created_by
    ) VALUES (
      v_plate, v_type,
      NULLIF(p_data->>'year', '')::integer, btrim(COALESCE(p_data->>'color', '')), v_frame, v_kind,
      v_date, v_status,
      btrim(COALESCE(p_data->>'supplier_name', '')), btrim(COALESCE(p_data->>'supplier_phone', '')), COALESCE(p_data->>'notes', ''), v_actor
    ) RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by) VALUES (v_new.id, v_purchase, v_actor);
    PERFORM private.audit('CREATE_VEHICLE', 'vehicles', v_new.id, NULL,
      to_jsonb(v_new)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_new.vehicle_type_id)),
      v_new.id);
  ELSE
    v_old_json := to_jsonb(v_old)
      || jsonb_build_object('purchase_price', v_old_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_old.vehicle_type_id));
    UPDATE public.vehicles SET
      license_plate = v_plate,
      vehicle_type_id = COALESCE(v_type, vehicle_type_id),
      year = CASE WHEN p_data ? 'year' THEN NULLIF(p_data->>'year', '')::integer ELSE year END,
      color = btrim(COALESCE(p_data->>'color', color)),
      frame_number = v_frame,
      frame_input_kind = v_kind,
      purchase_date = v_date,
      status = v_status,
      supplier_name = btrim(COALESCE(p_data->>'supplier_name', supplier_name)),
      supplier_phone = btrim(COALESCE(p_data->>'supplier_phone', supplier_phone)),
      notes = COALESCE(p_data->>'notes', notes),
      updated_at = now()
    WHERE id = p_id RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by)
      VALUES (p_id, v_purchase, v_actor)
      ON CONFLICT (vehicle_id) DO UPDATE
        SET purchase_price = EXCLUDED.purchase_price, updated_by = EXCLUDED.updated_by, updated_at = now();

    PERFORM private.audit('UPDATE_VEHICLE', 'vehicles', v_new.id, v_old_json,
      to_jsonb(v_new)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_new.vehicle_type_id)),
      v_new.id);
  END IF;
  RETURN v_new.id;
END $$;

-- import_vehicles_impl: dòng nhập lô là hành động ĐÃ xác nhận toàn file, nên YELLOW
-- được auto-ack (vẫn ghi lịch sử), RED và trùng exact do validate chặn như cũ.
-- Giữ nguyên trùng exact trong validate_import_vehicles để không hồi quy kiểm thử hiện có.
CREATE OR REPLACE FUNCTION private.import_vehicles_impl(p_vehicles jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_validation jsonb;
  v_row jsonb;
  v_data jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;
  IF jsonb_array_length(p_vehicles) = 0 THEN RAISE EXCEPTION USING errcode = '22023', message = 'NO_DATA_TO_IMPORT'; END IF;
  IF jsonb_array_length(p_vehicles) > 500 THEN RAISE EXCEPTION USING errcode = '22023', message = 'IMPORT_BATCH_TOO_LARGE'; END IF;
  LOCK TABLE public.vehicles IN SHARE ROW EXCLUSIVE MODE;
  v_validation := public.validate_import_vehicles(p_vehicles);
  IF jsonb_array_length(v_validation->'duplicates') > 0 THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_IMPORT_VEHICLE';
  END IF;
  IF jsonb_array_length(v_validation->'errors') > 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_IMPORT_DATA', detail = (v_validation->'errors')::text;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_vehicles) LOOP
    v_data := v_row || jsonb_build_object(
      'vehicle_type_id', private.vehicle_type_input(v_row),
      'acquisition_date', coalesce(nullif(v_row->>'purchase_date', ''), private.today()::text),
      'seller_name', coalesce(v_row->>'supplier_name', ''),
      'seller_phone', coalesce(v_row->>'supplier_phone', ''),
      'acquisition_notes', coalesce(v_row->>'notes', '')
    );
    v_data := jsonb_set(v_data, '{frame_number}', to_jsonb(upper(btrim(coalesce(v_data->>'frame_number','')))));
    v_data := v_data || jsonb_build_object(
      'frame_input_kind', coalesce(nullif(v_row->>'frame_input_kind',''),
        private.frame_kind(private.frame_compact_of(v_data->>'frame_number'))),
      'duplicate_ack', true
    );
    v_ids := array_append(v_ids, private.acquire_vehicle_impl(v_data));
  END LOOP;
  RETURN jsonb_build_object('imported_count', cardinality(v_ids), 'vehicle_ids', to_jsonb(v_ids));
END $$;

-- ============================================================
-- 7. Quyền: hàm xem trước mở cho authenticated; helper nội bộ đóng.
-- ============================================================
REVOKE ALL ON FUNCTION
  private.detect_vehicle_duplicates(text, text, text, uuid),
  private.duplicate_result(text, text, uuid[]),
  private.frame_kind(text), private.plate_compact_of(text),
  private.frame_compact_of(text), private.frame_last5_of(text)
  FROM public, anon, authenticated;

REVOKE ALL ON FUNCTION public.check_vehicle_duplicates(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.check_vehicle_duplicates(jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
