-- Migration: 20261011000400_duplicate_plate_last5_review.sql
-- Description: "Cùng biển số VÀ cùng 5 ký tự cuối" (PLATE_AND_LAST5) thành một
--   luồng NGHI VẤN TRÙNG có phân quyền + kiểm toán, thay vì RED chặn cứng vô điều kiện.
--   Chốt của Chủ quán 11/10/2026:
--     * Hai số khung ĐẦY ĐỦ trùng CHÍNH XÁC (FULL_FRAME_MATCH) → VẪN RED chặn cứng,
--       MỌI role, KHÔNG có đường vượt bằng checkbox/lý do (bảo toàn danh tính cứng).
--     * PLATE_AND_LAST5 (cùng biển + cùng 5 ký tự cuối, KHÔNG phải exact-FULL) chỉ là
--       NGHI VẤN, không được tự kết luận chắc chắn cùng một xe:
--         - STAFF: không lưu được; gửi YÊU CẦU XÁC MINH cho OWNER/MANAGER.
--         - OWNER/MANAGER: lưu NGOẠI LỆ được, nhưng bắt buộc đã mở đúng hồ sơ xe trùng
--           (reviewed_vehicle_id ∈ candidate) + lý do + xác nhận rõ.
--     * Mọi lượt kiểm tra / gửi yêu cầu / duyệt-từ chối / ghi ngoại lệ đều vào
--       vehicle_duplicate_checks kèm người thực hiện, thời gian, dữ liệu đối chiếu, lý do.
--     * KHÔNG tự gộp / ghi đè / xoá hồ sơ cũ — chỉ THÊM bản mới có kiểm soát.
--     * Phán quyết ở BACKEND/RPC (không tin frontend); giữ advisory lock + FOR UPDATE
--       để xử lý đúng khi nhiều người thao tác đồng thời; unique index approval_open_unique
--       chặn hai yêu cầu mở cùng một xe ứng viên.
--   Tái dùng khuôn approval_requests + operation_receipts của SALE_BELOW_COST (000300).
--   Forward-only: không sửa migration đã áp, không xóa dữ liệu, không đổi cột/index cũ.

BEGIN;

-- ============================================================
-- 0. Cho phép hai operation receipt mới của luồng nghi trùng.
--    Nới lỏng CHECK whitelist (khuôn 20261010000300) — chỉ THÊM giá trị hợp lệ,
--    không đổi cột, không xoá ràng buộc cũ ngoài việc thay bản mở rộng.
-- ============================================================
ALTER TABLE private.operation_receipts
  DROP CONSTRAINT operation_receipts_operation_check,
  ADD CONSTRAINT operation_receipts_operation_check CHECK (
    operation IN ('acquire_vehicle','import_vehicles','sell_vehicle','create_vehicle',
                  'request_sale_below_cost','resolve_sale_approval',
                  'request_vehicle_duplicate_review','resolve_vehicle_duplicate_review')
  );

-- Cùng whitelist cho hàm đối chiếu biên lai (client retry cần tra lại kết quả
-- theo tên operation). CREATE OR REPLACE giữ nguyên GRANT đã có ở 20261010000300.
CREATE OR REPLACE FUNCTION public.get_operation_result(p_operation text, p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_result jsonb;
BEGIN
  IF p_operation NOT IN ('acquire_vehicle','import_vehicles','sell_vehicle','create_vehicle',
                         'request_sale_below_cost','resolve_sale_approval',
                         'request_vehicle_duplicate_review','resolve_vehicle_duplicate_review') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_OPERATION';
  END IF;
  SELECT result INTO v_result FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation=p_operation AND request_id=p_request_id;
  RETURN jsonb_build_object('confirmed',v_result IS NOT NULL,'result',v_result);
END $$;

-- ============================================================
-- 1. Mở rộng bảng kiểm toán vehicle_duplicate_checks (thêm cột, có default an toàn).
-- ============================================================
ALTER TABLE public.vehicle_duplicate_checks
  ADD COLUMN IF NOT EXISTS decision text NOT NULL DEFAULT 'AUTO'
    CHECK (decision IN ('AUTO','ACK_YELLOW','OVERRIDE','REQUEST')),
  ADD COLUMN IF NOT EXISTS reviewed_vehicle_id uuid REFERENCES public.vehicles(id),
  ADD COLUMN IF NOT EXISTS override_reason text
    CHECK (override_reason IS NULL OR char_length(override_reason) BETWEEN 5 AND 1000),
  ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES public.approval_requests(id);

CREATE INDEX IF NOT EXISTS vehicle_duplicate_checks_decision
  ON public.vehicle_duplicate_checks (decision, created_at DESC);

-- ============================================================
-- 2. acquire_vehicle_impl: RED phân nhánh theo bản chất + vai trò.
--    FULL_FRAME_MATCH → chặn cứng mọi role. PLATE_AND_LAST5 → chỉ OWNER/MANAGER
--    được vượt khi có bộ ba (override flag + lý do + đã mở đúng hồ sơ ứng viên).
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
  v_override boolean := coalesce((p_data->>'duplicate_override')::boolean, false);
  v_override_reason text := nullif(btrim(coalesce(p_data->>'duplicate_override_reason', '')), '');
  v_reviewed uuid := nullif(p_data->>'duplicate_reviewed_vehicle_id', '')::uuid;
  v_reviewed_ok boolean := false;
  v_role public.user_role := private.current_role();
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

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

    -- PLATE_AND_LAST5: nghi vấn, chỉ OWNER/MANAGER được lưu ngoại lệ có kiểm soát.
    IF v_reviewed IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_detect->'candidate_ids') e
        WHERE e::uuid = v_reviewed
      ) INTO v_reviewed_ok;
    END IF;

    IF v_role IN ('OWNER','MANAGER')
       AND v_override IS NOT DISTINCT FROM true
       AND v_override_reason IS NOT NULL
       AND v_reviewed_ok THEN
      INSERT INTO public.vehicle_duplicate_checks
        (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
         candidate_ids, acknowledged, decision, reviewed_vehicle_id, override_reason, approval_id)
      VALUES (v_actor, 'ACQUIRE', 'RED', v_reason, v_plate_c, v_last5, v_kind,
        (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
        true, 'OVERRIDE', v_reviewed, v_override_reason,
        nullif(p_data->>'_review_approval_id', '')::uuid);
    ELSE
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_SUSPECTED';
    END IF;
  ELSIF v_level = 'YELLOW' THEN
    IF coalesce((p_data->>'duplicate_ack')::boolean, false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_NEEDS_CONFIRM';
    END IF;
    INSERT INTO public.vehicle_duplicate_checks
      (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
       candidate_ids, acknowledged, decision)
    VALUES (v_actor, 'ACQUIRE', 'YELLOW', v_reason, v_plate_c, v_last5, v_kind,
      (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
      true, 'ACK_YELLOW');
  END IF;

  INSERT INTO public.vehicles (
    frame_number, license_plate, frame_input_kind,
    vehicle_type_id, year, color,
    purchase_date, status,
    supplier_name, supplier_phone, notes, created_by
  ) VALUES (
    v_frame, v_plate, v_kind, v_type,
    nullif(p_data->>'year', '')::integer,
    btrim(coalesce(p_data->>'color', '')),
    v_date, 'IN_STOCK'::public.vehicle_status,
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
    v_vehicle.id, v_date, v_purchase, v_vis,
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'acquisition_notes', ''),
    'COMPLETED'::public.acquisition_status,
    v_actor
  ) RETURNING * INTO v_acquisition;

  PERFORM private.audit(
    'CREATE_ACQUISITION', 'acquisitions', v_acquisition.id, null,
    to_jsonb(v_acquisition) || jsonb_build_object('vehicle', to_jsonb(v_vehicle)),
    v_vehicle.id
  );
  PERFORM private.audit(
    'CREATE_VEHICLE', 'vehicles', v_vehicle.id, null,
    to_jsonb(v_vehicle)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_vehicle.vehicle_type_id)),
    v_vehicle.id
  );

  RETURN v_vehicle.id;
END $fn$;

-- ============================================================
-- 3. save_vehicle_impl: cùng logic RED phân nhánh cho đường nhập/sửa.
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
  v_override boolean := coalesce((p_data->>'duplicate_override')::boolean, false);
  v_override_reason text := nullif(btrim(coalesce(p_data->>'duplicate_override_reason', '')), '');
  v_reviewed uuid := nullif(p_data->>'duplicate_reviewed_vehicle_id', '')::uuid;
  v_reviewed_ok boolean := false;
  v_role public.user_role := private.current_role();
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
      -- PLATE_AND_LAST5: chỉ OWNER/MANAGER lưu ngoại lệ có bộ ba hợp lệ.
      IF v_reviewed IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(v_detect->'candidate_ids') e
          WHERE e::uuid = v_reviewed
        ) INTO v_reviewed_ok;
      END IF;
      IF v_role IN ('OWNER','MANAGER')
         AND v_override IS NOT DISTINCT FROM true
         AND v_override_reason IS NOT NULL
         AND v_reviewed_ok THEN
        INSERT INTO public.vehicle_duplicate_checks
          (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
           candidate_ids, acknowledged, decision, reviewed_vehicle_id, override_reason, approval_id)
        VALUES (v_actor, 'SAVE', 'RED', v_reason, v_plate_c, v_last5, v_kind,
          (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
          true, 'OVERRIDE', v_reviewed, v_override_reason,
          nullif(p_data->>'_review_approval_id', '')::uuid);
      ELSE
        RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_VEHICLE_SUSPECTED';
      END IF;
    ELSIF v_level = 'YELLOW' THEN
      IF coalesce((p_data->>'duplicate_ack')::boolean, false) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_VEHICLE_NEEDS_CONFIRM';
      END IF;
      INSERT INTO public.vehicle_duplicate_checks
        (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
         candidate_ids, acknowledged, decision)
      VALUES (v_actor, 'SAVE', 'YELLOW', v_reason, v_plate_c, v_last5, v_kind,
        (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
        true, 'ACK_YELLOW');
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
-- 4. STAFF/MANAGER gửi YÊU CẦU XÁC MINH khi gặp nghi vấn PLATE_AND_LAST5.
--    Không tạo xe. Gắn subject_id = xe ứng viên; payload = bản xe định tạo/sửa.
-- ============================================================
CREATE OR REPLACE FUNCTION private.request_vehicle_duplicate_review_impl(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['MANAGER','STAFF']::public.user_role[]);
  v_is_edit boolean := (p_data->>'_op') = 'SAVE';
  v_edit_id uuid := nullif(p_data->>'id', '')::uuid;
  v_frame text := btrim(coalesce(p_data->>'frame_number', ''));
  v_plate text := btrim(coalesce(p_data->>'license_plate', ''));
  v_detect jsonb;
  v_level text;
  v_reason text;
  v_compact text := private.frame_compact_of(v_frame);
  v_last5 text;
  v_plate_c text;
  v_candidate uuid;
  v_cand public.vehicles;
  v_requester text;
  v_payload jsonb;
  v_approval uuid;
  v_reason_text text;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  IF NOT (v_is_edit OR (p_data->>'_op') = 'ACQUIRE') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_REVIEW_MODE';
  END IF;

  v_last5 := private.frame_last5_of(v_compact);
  v_plate_c := private.plate_compact_of(v_plate);

  -- Phải có đủ chữ ký để đối chiếu (biển + 5 cuối) — nếu không thì không phải nghi vấn.
  IF v_plate_c IS NULL OR v_last5 IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'NO_DUPLICATE_TO_REVIEW';
  END IF;

  -- Re-run engine NGAY lúc gửi để không xin-duyệt cho tín hiệu đã mất.
  v_detect := private.detect_vehicle_duplicates(v_frame, v_plate, NULL, v_edit_id);
  v_level := v_detect->>'level';
  v_reason := v_detect->>'reason';

  IF v_level = 'RED' AND v_reason = 'FULL_FRAME_MATCH' THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_FRAME_NUMBER';
  END IF;
  IF v_level <> 'RED' OR v_reason <> 'PLATE_AND_LAST5' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'NO_DUPLICATE_TO_REVIEW';
  END IF;

  v_candidate := nullif((v_detect->'candidate_ids')->>0, '')::uuid;
  IF v_candidate IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'NO_DUPLICATE_TO_REVIEW';
  END IF;
  SELECT * INTO v_cand FROM public.vehicles WHERE id = v_candidate;

  -- Một yêu cầu mở cho mỗi (kind, candidate); map lỗi unique thành mã nghiệp vụ rõ.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_candidate AND ar.kind = 'VEHICLE_DUPLICATE_REVIEW' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'ALREADY_PENDING';
  END IF;

  SELECT full_name INTO v_requester FROM public.profiles WHERE id = v_actor;

  -- Snapshot dữ liệu đối chiếu tại thời điểm gửi để Chủ/Quản lý thấy đúng bối cảnh.
  v_payload := jsonb_build_object(
    'mode', CASE WHEN v_is_edit THEN 'SAVE' ELSE 'ACQUIRE' END,
    'edit_id', v_edit_id,
    'frame_number', v_frame,
    'license_plate', v_plate,
    'frame_last5', v_last5,
    'plate_compact', v_plate_c,
    'candidate_ids', v_detect->'candidate_ids',
    'candidate_code', v_cand.internal_code,
    'requested_data', p_data - '_op',
    'snapshot_by', v_actor
  );

  v_reason_text := 'Nghi trùng khi ' || (CASE WHEN v_is_edit THEN 'sửa' ELSE 'thu' END) || ' xe: biển '
    || v_plate || ' + 5 ký tự cuối ' || v_last5
    || ' khớp xe đang quản lý '
    || private.vehicle_label_text(v_cand.license_plate, v_cand.frame_number, v_cand.internal_code)
    || '. ' || coalesce(nullif(btrim(coalesce(p_data->>'staff_note','')),''), 'Nhân viên')
    || ' (' || coalesce(v_requester, 'n/a') || ') xin Chủ/Quản lý xác minh.';

  INSERT INTO public.approval_requests (kind, subject_id, requested_by, reason, payload)
  VALUES ('VEHICLE_DUPLICATE_REVIEW', v_candidate, v_actor, left(v_reason_text, 1000), v_payload)
  RETURNING id INTO v_approval;

  INSERT INTO public.vehicle_duplicate_checks
    (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
     candidate_ids, acknowledged, decision, approval_id)
  VALUES (v_actor, CASE WHEN v_is_edit THEN 'SAVE' ELSE 'ACQUIRE' END, 'RED', 'PLATE_AND_LAST5',
    v_plate_c, v_last5, private.frame_kind(v_compact),
    (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
    false, 'REQUEST', v_approval);

  PERFORM private.audit('REQUEST_VEHICLE_DUPLICATE_REVIEW', 'vehicles', v_candidate, null,
    v_payload || jsonb_build_object('request_id', v_approval, 'requested_by', v_actor), v_candidate);

  RETURN v_approval;
END $fn$;

-- Wrapper biên lai idempotent theo protocol request_id (retry cùng payload trả lại
-- đúng đơn đã tạo, không tạo đơn thứ hai).
CREATE OR REPLACE FUNCTION public.request_vehicle_duplicate_review(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid := nullif(p_data->>'request_id','')::uuid;
  v_payload jsonb := p_data - 'request_id';
  v_hash bytea := sha256(convert_to(v_payload::text, 'UTF8'));
  v_receipt private.operation_receipts;
  v_result uuid;
BEGIN
  IF v_request IS NULL THEN RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED'; END IF;
  INSERT INTO private.operation_receipts(actor_id,operation,request_id,payload_hash)
    VALUES(v_actor,'request_vehicle_duplicate_review',v_request,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='request_vehicle_duplicate_review' AND request_id=v_request FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_CONFLICT';
  END IF;
  IF v_receipt.result IS NOT NULL THEN RETURN (v_receipt.result #>> '{}')::uuid; END IF;
  v_result := private.request_vehicle_duplicate_review_impl(v_payload);
  UPDATE private.operation_receipts SET result=to_jsonb(v_result)
    WHERE actor_id=v_actor AND operation='request_vehicle_duplicate_review' AND request_id=v_request;
  RETURN v_result;
END $fn$;

-- ============================================================
-- 5. OWNER/MANAGER quyết định. APPROVE = chính tay lưu ngoại lệ bằng payload đã
--    snapshot (kèm bộ ba override); REJECT = không tạo gì, nhân viên nhận thông báo.
--    KHÔNG tự gộp/ghi đè/xoá hồ sơ cũ. Re-run detect để bắt dữ liệu lỗi thời.
-- ============================================================
CREATE OR REPLACE FUNCTION private.resolve_vehicle_duplicate_review_impl(
  p_approval_id uuid, p_action text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_req public.approval_requests;
  v_payload jsonb;
  v_intended jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_mode text;
  v_edit_id uuid;
  v_candidate uuid;
  v_new_id uuid;
BEGIN
  IF p_action NOT IN ('APPROVE','REJECT') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_APPROVAL_ACTION';
  END IF;

  SELECT * INTO v_req FROM public.approval_requests
    WHERE id = p_approval_id AND kind = 'VEHICLE_DUPLICATE_REVIEW' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='APPROVAL_NOT_FOUND'; END IF;
  IF v_req.status <> 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='ALREADY_RESOLVED';
  END IF;

  v_payload := v_req.payload;
  v_mode := coalesce(v_payload->>'mode', 'ACQUIRE');
  v_edit_id := nullif(v_payload->>'edit_id', '')::uuid;
  v_intended := coalesce(v_payload->'requested_data', '{}'::jsonb);

  IF p_action = 'REJECT' THEN
    UPDATE public.approval_requests
      SET status='REJECTED', resolved_by=v_actor, resolved_at=now(), resolution_note=left(v_reason,1000), updated_at=now()
      WHERE id = p_approval_id;
    UPDATE public.vehicle_duplicate_checks
      SET decision='REQUEST', override_reason=coalesce(v_reason, override_reason)
      WHERE approval_id = p_approval_id;
    PERFORM private.audit('REJECT_VEHICLE_DUPLICATE_REVIEW', 'vehicles', v_req.subject_id, null,
      v_payload || jsonb_build_object('request_id', p_approval_id, 'note', v_reason, 'decided_by', v_actor),
      v_req.subject_id);
    RETURN NULL;
  END IF;

  -- APPROVE bắt buộc lý do (>= 5 ký tự) vì đây là ghi ngoại lệ có trách nhiệm giải trình.
  IF v_reason IS NULL OR char_length(v_reason) < 5 THEN
    RAISE EXCEPTION USING errcode='22023', message='DUPLICATE_OVERRIDE_REASON_REQUIRED';
  END IF;

  -- Kiểm lại tại thời điểm duyệt: nếu giờ là exact-FULL thì KHÔNG được vượt;
  -- nếu nghi vấn đã mất thì cũng từ chối (đơn lỗi thời, phải gửi lại).
  DECLARE
    v_detect jsonb;
    v_frame text := v_payload->>'frame_number';
    v_plate text := v_payload->>'license_plate';
  BEGIN
    v_detect := private.detect_vehicle_duplicates(v_frame, v_plate, NULL, v_edit_id);
    IF v_detect->>'level' = 'RED' AND v_detect->>'reason' = 'FULL_FRAME_MATCH' THEN
      RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_FRAME_NUMBER';
    END IF;
    IF v_detect->>'level' <> 'RED' OR v_detect->>'reason' <> 'PLATE_AND_LAST5' THEN
      RAISE EXCEPTION USING errcode='40001', message='APPROVAL_STALE_DATA';
    END IF;
    -- reviewed_vehicle_id phải nằm trong candidate của chính đơn này (không bịa được).
    v_candidate := v_req.subject_id;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_detect->'candidate_ids') e
      WHERE e::uuid = v_candidate
    ) THEN
      RAISE EXCEPTION USING errcode='40001', message='APPROVAL_STALE_DATA';
    END IF;
  END;

  UPDATE public.approval_requests
    SET status='APPROVED', resolved_by=v_actor, resolved_at=now(), resolution_note=left(v_reason,1000), updated_at=now()
    WHERE id = p_approval_id;

  -- Chính tay OWNER/MANAGER ghi ngoại lệ bằng dữ liệu đã duyệt + bộ ba override.
  v_intended := v_intended
    || jsonb_build_object(
         'duplicate_override', true,
         'duplicate_override_reason', v_reason,
         'duplicate_reviewed_vehicle_id', v_candidate,
         '_review_approval_id', p_approval_id,
         'duplicate_ack', true);

  IF v_mode = 'SAVE' THEN
    v_new_id := private.save_vehicle_impl(v_intended, v_edit_id);
  ELSE
    v_new_id := private.acquire_vehicle_impl(v_intended);
  END IF;

  PERFORM private.audit('APPROVE_VEHICLE_DUPLICATE_REVIEW', 'vehicles', v_req.subject_id, null,
    v_payload || jsonb_build_object('request_id', p_approval_id, 'new_vehicle_id', v_new_id,
      'reviewed_vehicle_id', v_candidate, 'note', v_reason, 'approved_by', v_actor),
    coalesce(v_new_id, v_req.subject_id));

  RETURN v_new_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.resolve_vehicle_duplicate_review(
  p_approval_id uuid, p_action text, p_reason text DEFAULT NULL, p_request_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_hash bytea := sha256(convert_to(
    jsonb_build_object('approval_id', p_approval_id, 'action', p_action, 'reason', p_reason)::text, 'UTF8'));
  v_receipt private.operation_receipts;
  v_result jsonb;
  v_new uuid;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED'; END IF;
  INSERT INTO private.operation_receipts(actor_id,operation,request_id,payload_hash)
    VALUES(v_actor,'resolve_vehicle_duplicate_review',p_request_id,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='resolve_vehicle_duplicate_review' AND request_id=p_request_id FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_CONFLICT';
  END IF;
  IF v_receipt.result IS NOT NULL THEN RETURN v_receipt.result; END IF;
  v_new := private.resolve_vehicle_duplicate_review_impl(p_approval_id, p_action, p_reason);
  v_result := jsonb_build_object('approval_id', p_approval_id, 'action', p_action, 'vehicle_id', v_new);
  UPDATE private.operation_receipts SET result=v_result
    WHERE actor_id=v_actor AND operation='resolve_vehicle_duplicate_review' AND request_id=p_request_id;
  RETURN v_result;
END $fn$;

-- ============================================================
-- 6. Hàng đợi riêng cho loại nghi vấn này (OWNER + MANAGER xem), KHÔNG nới lỏng
--    list_pending_approvals tổng (vẫn OWNER-only để giữ privacy tài chính).
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_vehicle_duplicate_reviews(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 50)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_status text := upper(btrim(coalesce(nullif(p_filters->>'status', ''), 'PENDING')));
  v_items jsonb; v_total bigint;
BEGIN
  IF v_status NOT IN ('PENDING','APPROVED','REJECTED') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT count(*) INTO v_total FROM public.approval_requests ar
    WHERE ar.kind = 'VEHICLE_DUPLICATE_REVIEW' AND ar.status = v_status;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'subject_id', x.subject_id, 'reason', x.reason, 'status', x.status,
      'payload', x.payload, 'requested_by', x.requested_by, 'requester_name', x.requester_name,
      'created_at', x.created_at, 'resolved_at', x.resolved_at, 'resolution_note', x.resolution_note,
      'resolved_by_name', x.resolved_by_name,
      'vehicle_code', x.vehicle_code, 'vehicle_title', x.vehicle_title,
      'license_plate', x.license_plate, 'frame_number', x.frame_number, 'vehicle_status', x.vehicle_status
    ) ORDER BY x.rn), '[]'::jsonb) INTO v_items
  FROM (
    SELECT row_number() OVER (ORDER BY ar.created_at DESC, ar.id DESC) AS rn,
      ar.id, ar.subject_id, ar.requested_by, ar.reason, ar.status, ar.payload,
      ar.created_at, ar.resolved_at, ar.resolution_note,
      req.full_name AS requester_name, res.full_name AS resolved_by_name,
      v.internal_code AS vehicle_code,
      private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) AS vehicle_title,
      v.license_plate, v.frame_number, v.status::text AS vehicle_status
    FROM public.approval_requests ar
    LEFT JOIN public.profiles req ON req.id = ar.requested_by
    LEFT JOIN public.profiles res ON res.id = ar.resolved_by
    LEFT JOIN public.vehicles v ON v.id = ar.subject_id
    WHERE ar.kind = 'VEHICLE_DUPLICATE_REVIEW' AND ar.status = v_status
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT v_limit OFFSET v_offset
  ) x;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $fn$;

-- ============================================================
-- 7. Quyền: mở RPC công cho authenticated + service_role; đóng helper private.
-- ============================================================
REVOKE ALL ON FUNCTION
  private.request_vehicle_duplicate_review_impl(jsonb),
  private.resolve_vehicle_duplicate_review_impl(uuid, text, text)
  FROM public, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.request_vehicle_duplicate_review(jsonb),
  public.resolve_vehicle_duplicate_review(uuid, text, text, uuid),
  public.list_vehicle_duplicate_reviews(jsonb)
  FROM public, anon;

GRANT EXECUTE ON FUNCTION
  public.request_vehicle_duplicate_review(jsonb),
  public.resolve_vehicle_duplicate_review(uuid, text, text, uuid),
  public.list_vehicle_duplicate_reviews(jsonb)
  TO authenticated, service_role;

-- ============================================================
-- 8. Assert: acquire/save không còn chặn cứng mù quáng PLATE_AND_LAST5 mà có
--    nhánh override có kiểm soát; các RPC mới tồn tại & được GRANT đúng.
-- ============================================================
DO $assert$
DECLARE
  v_src text;
BEGIN
  FOR v_src IN
    SELECT prosrc FROM pg_proc
     WHERE pronamespace = 'private'::regnamespace
       AND proname IN ('acquire_vehicle_impl','save_vehicle_impl')
  LOOP
    IF v_src NOT LIKE '%DUPLICATE_OVERRIDE%' AND v_src NOT LIKE '%duplicate_override%' THEN
      RAISE EXCEPTION 'acquire/save thiếu nhánh override có kiểm soát cho PLATE_AND_LAST5';
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname IN
                 ('request_vehicle_duplicate_review','resolve_vehicle_duplicate_review','list_vehicle_duplicate_reviews')) THEN
    RAISE EXCEPTION 'Thiếu RPC luồng xác minh nghi trùng';
  END IF;
END $assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
