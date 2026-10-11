-- Migration: 20261011000300_frame_kind_auto_only.sql
-- Description: Số khung chỉ còn MỘT nguồn phân loại — máy chủ tự suy theo độ dài.
--   * `private.frame_kind(frame_compact)` là quyết định duy nhất: rỗng hoặc ≥ 11 ký tự
--     chữ+số → FULL (danh tính cứng, có UNIQUE nén chặn trùng), ngắn hơn → PARTIAL
--     (mảnh rút gọn, chỉ phục vụ phát hiện nghi trùng).
--   * Bỏ hẳn quyền chọn tay: không đường nào đọc `frame_input_kind` từ payload nữa —
--     form Thu xe / Nhập·Sửa xe, `import_vehicles` (CSV + tốc ký), `check_vehicle_duplicates`
--     (xem trước) và cả lời gọi API trực tiếp/service_role đều bị ghi đè theo số khung.
--     Một client cũ còn gửi key này thì giá trị cũng vô nghĩa.
--   * Ma trận nghi trùng theo yêu cầu chủ quán:
--       - Dài–Dài khớp TOÀN BỘ số khung  → RED  (chặn cứng,DUPLICATE_FRAME_NUMBER)
--       - Ngắn–Ngắn trùng 5 ký tự cuối    → YELLOW (đối chiếu + tích xác nhận thì lưu được)
--       - Dài–Ngắn trùng 5 ký tự cuối     → YELLOW (trước đây RED `NEED_VERIFY_PARTIAL_FULL`)
--       - Không khớp gì                   → GREEN
--       - So sánh hai chiều: máy phát hiện luôn lấy đúng số khung vừa nhập suy ra loại,
--         rồi đối chiếu với loại ĐÃ LƯU của từng xe trong kho, nên cả hai chiều
--         (kho FULL / nhập PARTIAL và kho PARTIAL / nhập FULL) cùng một mức.
--     RIêng "cùng biển số VÀ cùng 5 ký tự cuối" vẫn giữ RED như cũ: chủ quán chưa chốt
--     quy tắc này nên không tự ý hạ xuống YELLOW.
--   * Sửa hồ sơ cũ: chỉ phân loại lại khi số khung THỰC đổi (so theo `frame_compact`),
--     không đổi số khung thì giữ nguyên `frame_input_kind` đã lưu — tránh viết lại lịch sử
--     và tránh mất chặn UNIQUE của những hồ sơ đời trước.
--   * Forward-only: không sửa migration đã áp, không xóa dữ liệu, không đổi cột/index.
--     UNIQUE nén partial `vehicles_full_frame_unique` và advisory lock giữ nguyên.

BEGIN;

-- ============================================================
-- 1. Máy phát hiện ba mức: tự suy loại từ số khung, bỏ quyền chọn tay.
--    Giữ nguyên chữ ký 4 tham số (GRANT/REVOKE và mọi lời gọi đang trỏ vào đây);
--    p_kind chỉ còn là tham số tương thích ngược và ĐÃ BỊ BỎ QUA.
-- ============================================================
CREATE OR REPLACE FUNCTION private.detect_vehicle_duplicates(
  p_frame text, p_plate text, p_kind text, p_exclude uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_compact text := private.frame_compact_of(p_frame);
  v_last5   text := private.frame_last5_of(v_compact);
  v_plate   text := private.plate_compact_of(p_plate);
  v_kind    text := private.frame_kind(v_compact);
  v_ids     uuid[];
BEGIN
  -- RED 1: số khung ĐẦY ĐỦ trùng toàn bộ một xe đang quản lý (khác chính nó).
  -- Đây là danh tính cứng nên chặn tuyệt đối; index UNIQUE partial cũng chặn ở tầng DB.
  IF v_kind = 'FULL' AND v_compact <> '' THEN
    SELECT coalesce(array_agg(v.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.vehicles v
    WHERE v.frame_input_kind = 'FULL' AND v.frame_compact = v_compact
      AND v.status <> 'CANCELLED' AND (p_exclude IS NULL OR v.id <> p_exclude);
    IF cardinality(v_ids) > 0 THEN
      RETURN private.duplicate_result('RED','FULL_FRAME_MATCH', v_ids);
    END IF;
  END IF;

  -- RED 2: cùng biển số VÀ cùng 5 ký tự cuối (mọi kiểu khung).
  -- GIỮ NGUYÊN RED theo chốt của chủ quán 11/10/2026 — cặp tín hiệu này chưa được
  -- phép hạ xuống YELLOW.
  IF v_plate IS NOT NULL AND v_last5 IS NOT NULL THEN
    SELECT coalesce(array_agg(v.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.vehicles v
    WHERE v.plate_compact = v_plate AND v.frame_last5 = v_last5
      AND v.status <> 'CANCELLED' AND (p_exclude IS NULL OR v.id <> p_exclude);
    IF cardinality(v_ids) > 0 THEN
      RETURN private.duplicate_result('RED','PLATE_AND_LAST5', v_ids);
    END IF;
  END IF;

  -- YELLOW 1: một bên lưu số khung đầy đủ, một bên chỉ có mảnh rút gọn nhưng khớp
  -- 5 ký tự cuối → KHÔNG chặn tuyệt đối chỉ vì trùng 5 ký tự cuối. Danh sách ứng viên
  -- vẫn hiện đầy đủ và việc xác nhận được ghi lịch sử.
  IF v_last5 IS NOT NULL THEN
    SELECT coalesce(array_agg(v.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.vehicles v
    WHERE v.frame_last5 = v_last5 AND v.frame_input_kind <> v_kind
      AND v.status <> 'CANCELLED' AND (p_exclude IS NULL OR v.id <> p_exclude);
    IF cardinality(v_ids) > 0 THEN
      RETURN private.duplicate_result('YELLOW','NEED_VERIFY_PARTIAL_FULL', v_ids);
    END IF;
  END IF;

  -- YELLOW 2: trùng MỘT TRONG HAI (chỉ biển, hoặc chỉ 5 ký tự cuối cùng kiểu).
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
END $fn$;

-- RPC xem trước cho giao diện: không truyền loại khung do client chọn nữa.
CREATE OR REPLACE FUNCTION public.check_vehicle_duplicates(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  RETURN private.detect_vehicle_duplicates(
    p_data->>'frame_number', p_data->>'license_plate',
    NULL,
    NULLIF(p_data->>'exclude_vehicle_id','')::uuid);
END $fn$;

-- ============================================================
-- 2. Đường ghi xe mới (Thu xe, import từng dòng): luôn tự phân loại.
-- ============================================================
CREATE OR REPLACE FUNCTION private.acquire_vehicle_impl(p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_frame text := btrim(coalesce(p_data->>'frame_number', ''));
  v_plate text := btrim(coalesce(p_data->>'license_plate', ''));
  v_kind text;
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
  v_vis public.money_visibility := private.price_visibility_for(private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]));
  v_type uuid;
  v_date date := coalesce((p_data->>'acquisition_date')::date, private.today());
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  -- Every vehicle entering stock must carry a purchase price.
  IF v_purchase IS NULL OR v_purchase <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_PRICE_REQUIRED';
  END IF;

  v_type := private.vehicle_type_input(p_data);

  IF v_frame = '' THEN
    v_frame := 'GEN-' || substr(gen_random_uuid()::text, 1, 12);
  END IF;

  IF v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
  END IF;

  v_compact := private.frame_compact_of(v_frame);
  -- 11/10/2026: phân loại DUY NHẤT theo độ dài số khung; payload không còn quyền này.
  v_kind := private.frame_kind(v_compact);
  v_last5 := private.frame_last5_of(v_compact);
  v_plate_c := private.plate_compact_of(v_plate);

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

  INSERT INTO public.vehicle_financials (vehicle_id, purchase_price, updated_by, purchase_price_visibility)
  VALUES (v_vehicle.id, v_purchase, v_actor, v_vis);

  INSERT INTO public.acquisitions (
    vehicle_id, acquisition_date, purchase_price, purchase_price_visibility,
    seller_name, seller_phone, notes, status, created_by
  ) VALUES (
    v_vehicle.id,
    v_date,
    v_purchase,
    v_vis,
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
END $fn$;

-- ============================================================
-- 3. Đường ghi xe tồn kho: tạo mới thì tự suy; sửa thì chỉ phân loại lại
--    khi số khung thực đổi, ngược lại giữ nguyên phân loại đã lưu.
-- ============================================================
CREATE OR REPLACE FUNCTION private.save_vehicle_impl(p_data jsonb, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.vehicles; v_new public.vehicles; v_purchase bigint; v_old_purchase bigint;
  v_status public.vehicle_status; v_date date; v_old_json jsonb;
  v_frame text; v_type uuid;
  v_kind text; v_plate text;
  v_compact text; v_last5 text; v_plate_c text; v_lock text;
  v_detect jsonb; v_level text; v_reason text; v_changed boolean;
  v_vis public.money_visibility := private.price_visibility_for(private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]));
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;
  IF p_id IS NULL THEN
    v_type := private.vehicle_type_input(p_data);
  ELSE
    v_type := private.vehicle_type_input_optional(p_data);
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.vehicles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='VEHICLE_NOT_FOUND'; END IF;
    PERFORM private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
    IF EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
      RAISE EXCEPTION USING errcode='22023',message='DELETE_PENDING';
    END IF;
    IF p_data ? 'expected_updated_at' AND v_old.updated_at IS DISTINCT FROM (p_data->>'expected_updated_at')::timestamptz THEN
      RAISE EXCEPTION USING errcode='40001',message='VEHICLE_EDIT_CONFLICT';
    END IF;
    SELECT purchase_price INTO v_old_purchase FROM public.vehicle_financials WHERE vehicle_id = p_id;
  END IF;
  v_status := COALESCE((p_data->>'status')::public.vehicle_status, v_old.status, 'IN_STOCK');
  IF v_status = 'SOLD' AND (p_id IS NULL OR v_old.status <> 'SOLD') THEN RAISE EXCEPTION USING errcode='22023',message='USE_SELL_VEHICLE'; END IF;
  v_purchase := private.money_input(p_data, 'purchase_price', v_old_purchase);
  IF p_id IS NULL AND (v_purchase IS NULL OR v_purchase <= 0) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_PRICE_REQUIRED';
  END IF;
  IF p_id IS NOT NULL AND p_data ? 'purchase_price' AND (v_purchase IS NULL OR v_purchase <= 0) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_PRICE_REQUIRED';
  END IF;
  v_date := COALESCE((p_data->>'purchase_date')::date, v_old.purchase_date, private.today());
  IF v_date > private.today() THEN RAISE EXCEPTION USING errcode='22023',message='FUTURE_DATE'; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = p_id AND status = 'ACTIVE' AND expense_date < v_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_AFTER_EXPENSE';
  END IF;
  IF v_old.status = 'SOLD' AND (v_status <> 'SOLD' OR v_purchase IS DISTINCT FROM v_old_purchase
      OR v_date <> v_old.purchase_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='SOLD_VEHICLE_LOCKED';
  END IF;

  IF p_id IS NULL THEN
    v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), 'GEN-' || substr(gen_random_uuid()::text, 1, 12));
    v_kind := private.frame_kind(private.frame_compact_of(v_frame));
    v_plate := btrim(coalesce(p_data->>'license_plate',''));
    v_changed := true;
  ELSE
    v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), v_old.frame_number);
    v_plate := btrim(COALESCE(p_data->>'license_plate', v_old.license_plate));
    v_compact := private.frame_compact_of(v_frame);
    -- Số khung thực đổi (so theo chuỗi nén, không so theo cách viết) → tự phân loại lại.
    -- Không đổi số khung → giữ phân loại đã lưu, kể cả hồ sơ đời trước từng được chọn
    -- tay "Đầy đủ", để không viết lại lịch sử và không mất chặn UNIQUE đang có.
    v_kind := CASE
      WHEN v_compact IS DISTINCT FROM v_old.frame_compact
        THEN private.frame_kind(v_compact)
      ELSE v_old.frame_input_kind
    END;
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

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by, purchase_price_visibility) VALUES (v_new.id, v_purchase, v_actor, v_vis);
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

    -- Re-stamp provenance ONLY when the price value actually changed; editing other
    -- fields must not reclassify (and thus re-expose or hide) the OWNER's price.
    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by, purchase_price_visibility)
      VALUES (p_id, v_purchase, v_actor, v_vis)
      ON CONFLICT (vehicle_id) DO UPDATE
        SET purchase_price = EXCLUDED.purchase_price,
            updated_by = EXCLUDED.updated_by,
            purchase_price_visibility = CASE
              WHEN public.vehicle_financials.purchase_price IS DISTINCT FROM EXCLUDED.purchase_price
                THEN EXCLUDED.purchase_price_visibility
              ELSE public.vehicle_financials.purchase_price_visibility END,
            updated_at = now();

    PERFORM private.audit('UPDATE_VEHICLE', 'vehicles', v_new.id, v_old_json,
      to_jsonb(v_new)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_new.vehicle_type_id)),
      v_new.id);
  END IF;
  RETURN v_new.id;
END $fn$;

-- ============================================================
-- 4. Nhập lô (CSV + tốc ký): không nhét loại khung của dòng nhập vào pipeline,
--    và gỡ hẳn key ra khỏi payload trước khi gọi acquire để server luôn tự suy.
--    YELLOW vẫn auto-ack (hành động nhập cả lô là hành động ĐÃ xác nhận), RED
--    và trùng exact vẫn do validate chặn như cũ.
-- ============================================================
CREATE OR REPLACE FUNCTION private.import_vehicles_impl(p_vehicles jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
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
    -- `- 'frame_input_kind'`: mọi cách viết loại khung từ file/CSV/API đều bị bỏ.
    v_data := (v_row - 'frame_input_kind') || jsonb_build_object(
      'vehicle_type_id', private.vehicle_type_input(v_row),
      'acquisition_date', coalesce(nullif(v_row->>'purchase_date', ''), private.today()::text),
      'seller_name', coalesce(v_row->>'supplier_name', ''),
      'seller_phone', coalesce(v_row->>'supplier_phone', ''),
      'acquisition_notes', coalesce(v_row->>'notes', '')
    );
    v_data := jsonb_set(v_data, '{frame_number}', to_jsonb(upper(btrim(coalesce(v_data->>'frame_number','')))));
    v_data := v_data || jsonb_build_object('duplicate_ack', true);
    v_ids := array_append(v_ids, private.acquire_vehicle_impl(v_data));
  END LOOP;
  RETURN jsonb_build_object('imported_count', cardinality(v_ids), 'vehicle_ids', to_jsonb(v_ids));
END $fn$;

-- ============================================================
-- 5. Anti-"xanh giả": máy chủ KHÔNG được đọc loại khung từ input ở bất kỳ đường nào.
-- ============================================================
DO $assert$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE pronamespace = 'private'::regnamespace
     AND proname = 'detect_vehicle_duplicates'
   LIMIT 1;
  IF v_src IS NULL OR v_src NOT LIKE '%private.frame_kind(v_compact)%' THEN
    RAISE EXCEPTION 'detect_vehicle_duplicates chưa tự suy loại từ số khung';
  END IF;

  FOR v_src IN
    SELECT prosrc FROM pg_proc
     WHERE pronamespace = 'private'::regnamespace
       AND proname IN ('acquire_vehicle_impl','save_vehicle_impl','import_vehicles_impl')
    UNION ALL
    SELECT prosrc FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'check_vehicle_duplicates'
  LOOP
    IF v_src LIKE '%>''frame_input_kind''%' THEN
      RAISE EXCEPTION 'Vẫn còn đường đọc frame_input_kind từ payload client';
    END IF;
  END LOOP;
END $assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
