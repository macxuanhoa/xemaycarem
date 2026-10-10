-- Migration: 20261010000300_below_cost_sale_approval.sql
-- Description: Bán xe dưới giá thu là quyết định của chủ cửa hàng, không phải của
--   người thao tác xe. Mọi nhân viên đều ĐƯỢC đề xuất và nhìn thấy con số, nhưng
--   chỉ OWNER mới được hoàn tất giao dịch lỗ vốn.
--   * QUY TẮC BÁN: sale_price >= purchase_price → bán bình thường, không duyệt
--     (kể cả STAFF/MANAGER). sale_price < purchase_price → STAFF/MANAGER vẫn nhập
--     giá và bấm xác nhận, nhưng giao dịch không hoàn tất: nó hoá thành một yêu
--     cầu trong hàng đợi "Chờ duyệt" có sẵn. OWNER bán trực tiếp thì tự quyết,
--     không cần gửi đơn cho chính mình (server: chỉ role OWNER được sell under cost).
--   * KHÔNG CÓ HỆ THỐNG PHÊ DUYỆT SONG SONG: tái dùng public.approval_requests
--     (20261008000200) + hàng đợi/trang /approvals + RPC list_pending_approvals +
--     fan-out thông báo private.notify_from_audit. Thêm kind 'SALE_BELOW_COST' và
--     cột payload jsonb để cất đúng bản đề xuất (khách, giá, ngày, công nợ).
--   * PENDING ≠ ĐÃ BÁN: trong lúc chờ, xe KHÔNG chuyển SOLD và KHÔNG có doanh thu.
--     Xe đang có đơn chờ bị chặn bán bởi MỌI giao dịch khác (kể cả OWNER direct),
--     kể cả xóa xe — OWNER phải quyết đơn trước.
--   * CHỐNG DỮ LIỆU LỖI THỜI: snapshot giá thu + tổng chi phí tại lúc gửi nằm trong
--     payload; khi duyệt server đối chiếu lại, lệch là APPROVAL_STALE_DATA (yêu cầu
--     phải được rút và gửi lại với số mới). Nhân xét duyệt ghi lịch sử bất biến qua
--     private.audit (audit_logs + vehicle_activity) như mọi thao tác tiền khác.
--   * THU XE KHÔNG ĐỔI QUY TRÌNH: STAFF/MANAGER/OWNER đều nhập giá thu mua, giá
--     thu bắt buộc > 0 ngay từ đầu, không còn bước "chờ bổ sung giá vốn" cho xe
--     mới. Vì giá thu là dữ liệu người thao tác xe nhập, purchase_price được trả
--     về cho mọi role trong hồ sơ xe (lợi nhuận/tổng chi phí vẫn là số riêng của
--     quyền tài chính). Xe CŨ chưa có giá vẫn bị PURCHASE_COST_REQUIRED chặn bán.
--   * GIỮ NGUYÊN cơ chế chống lưu hai lần: private.operation_receipts keyed by
--     (actor, operation, request_id) + payload hash cho cả ba thao tác mới, FOR
--     UPDATE trên xe và trên hàng đợi khi duyệt.
-- Forward-only. Không xoá dữ liệu, không backfill giá về 0, không sửa migration cũ.

BEGIN;

-- ============================================================
-- STEP 1: Hàng đợi "Chờ duyệt" nhận thêm loại yêu cầu bán dưới giá thu
-- ============================================================

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.approval_requests.payload IS
  'Bản đề xuất server-sinh cho yêu cầu (kind=SALE_BELOW_COST: khách, giá bán, ngày, công nợ, snapshot giá thu/chi phí). Client không bao giờ ghi cột này.';

-- reason vẫn NOT NULL 3..1000: với yêu cầu bán, server tự soạn câu lý do có đủ
-- biển số · giá thu · giá bán · số chênh, nên không nới ràng buộc.

-- ============================================================
-- STEP 2: Bi Receipt operation cho hai thao tác mới + hàm đối chiếu biên lai
-- ============================================================

ALTER TABLE private.operation_receipts
  DROP CONSTRAINT operation_receipts_operation_check,
  ADD CONSTRAINT operation_receipts_operation_check CHECK (
    operation IN ('acquire_vehicle','import_vehicles','sell_vehicle','create_vehicle',
                  'request_sale_below_cost','resolve_sale_approval')
  );

CREATE OR REPLACE FUNCTION public.get_operation_result(p_operation text, p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_result jsonb;
BEGIN
  IF p_operation NOT IN ('acquire_vehicle','import_vehicles','sell_vehicle','create_vehicle',
                         'request_sale_below_cost','resolve_sale_approval') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_OPERATION';
  END IF;
  SELECT result INTO v_result FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation=p_operation AND request_id=p_request_id;
  RETURN jsonb_build_object('confirmed',v_result IS NOT NULL,'result',v_result);
END $$;

-- ============================================================
-- STEP 3: Giá thu là dữ liệu của người thao tác xe, không còn là mật khẩu
--         nội bộ. Chỉ tổng chi phí / lợi nhuận mới thuộc quyền tài chính.
-- ============================================================

CREATE OR REPLACE FUNCTION private.vehicle_json(p_vehicle public.vehicles)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare v_purchase bigint; v_expenses bigint; v_result jsonb; v_end date; v_approval uuid;
begin
  select purchase_price into v_purchase from public.vehicle_financials where vehicle_id=p_vehicle.id;
  if p_vehicle.status='SOLD' then select sale_date into v_end from public.sales where vehicle_id=p_vehicle.id and status='COMPLETED'; end if;
  -- purchase_price đứng ngoài nhánh can_financials: nhân viên nhập giá thu khi thu
  -- xe và phải thấy giá thu để biết mình đang bán dưới giá thu hay không.
  -- Cột duyệt bán đi kèm để hồ sơ xe/bán xe nói được "đang chờ chủ duyệt" với cả
  -- người gửi đơn (RLS hàng đợi vốn chỉ mở SELECT cho OWNER và chính tác giả).
  select ar.id into v_approval from public.approval_requests ar
    where ar.subject_id=p_vehicle.id and ar.kind='SALE_BELOW_COST' and ar.status='PENDING'
    limit 1;
  v_result:=to_jsonb(p_vehicle)||private.vehicle_display(p_vehicle)||jsonb_build_object(
    'cost_pending',v_purchase is null,
    'purchase_price',v_purchase,
    'pending_sale_approval',v_approval is not null,
    'sale_approval_id',v_approval,
    'days_in_inventory',greatest(0,coalesce(v_end,private.today())-p_vehicle.purchase_date));
  if private.can_financials() then
    select private.safe_money(coalesce(sum(amount),0)) into v_expenses from public.vehicle_expenses where vehicle_id=p_vehicle.id and status='ACTIVE';
    v_result:=v_result||jsonb_build_object('expense_total',v_expenses,'total_cost',private.safe_money(v_purchase::numeric+v_expenses));
  end if;
  return v_result;
end $$;

-- list_acquisitions: bản cuối (20261008000300) che purchase_price theo quyền tài
-- chính. Nhân viên là người trực tiếp nhập giá thu khi thu xe, nên lịch sử thu
-- xe phải trả lại đúng con số họ đã nhập. Bảng acquisitions vẫn RLS-only cho
-- quyền tài chính; RPC này là đường đọc duy nhất của mọi role đang công tác.
CREATE OR REPLACE FUNCTION public.list_acquisitions(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_from date := coalesce(nullif(p_filters->>'from', ''), nullif(p_filters->>'date_from', ''))::date;
  v_to date := coalesce(nullif(p_filters->>'to', ''), nullif(p_filters->>'date_to', ''))::date;
  v_search text := left(coalesce(p_filters->>'search', ''), 200);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
BEGIN
  IF v_from > v_to THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE';
  END IF;

  WITH matching AS (
    SELECT a.*, v.frame_number, v.license_plate, v.year, v.color, v.internal_code,
           t.name AS vehicle_type, p.full_name AS creator_name
    FROM public.acquisitions a
    JOIN public.vehicles v ON v.id = a.vehicle_id
    LEFT JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN public.profiles p ON p.id = a.created_by
    WHERE
      (v_from IS NULL OR a.acquisition_date >= v_from)
      AND (v_to IS NULL OR a.acquisition_date <= v_to)
      AND (nullif(p_filters->>'status', '') IS NULL OR a.status::text = p_filters->>'status')
      AND (v_search = '' OR concat_ws(' ', v.frame_number, v.license_plate, v.internal_code, t.name, a.seller_name, a.seller_phone) ILIKE '%' || v_search || '%')
  ),
  paged AS (
    SELECT * FROM matching
    ORDER BY acquisition_date DESC, created_at DESC, id
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    (SELECT count(*) FROM matching),
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'vehicle_id', p.vehicle_id,
          'frame_number', p.frame_number,
          'license_plate', p.license_plate,
          'vehicle_type', p.vehicle_type,
          'year', p.year,
          'color', p.color,
          'internal_code', p.internal_code,
          'vehicle_title', private.vehicle_label_text(p.license_plate, p.frame_number, p.internal_code),
          'vehicle_subtitle', private.vehicle_subtitle_text(p.vehicle_type, p.year, p.color),
          'acquisition_date', p.acquisition_date,
          'purchase_price', p.purchase_price,
          'seller_name', p.seller_name,
          'seller_phone', p.seller_phone,
          'status', p.status,
          'notes', p.notes,
          'creator_name', p.creator_name,
          'created_by', p.created_by,
          'created_at', p.created_at
        ) ORDER BY p.acquisition_date DESC, p.created_at DESC, p.id
      ) FROM paged p
    ), '[]'::jsonb)
  INTO v_total, v_items;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

-- ============================================================
-- STEP 4: THU XE — giá thu bắt buộc > 0, mọi role đều nhập được (bỏ gate tài
--         chính ở nhánh ghi). Giữ nguyên kiểm trùng + advisory lock của 09/10.
-- ============================================================

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
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  -- Không còn "xe vào kho chờ giá vốn": mọi xe chính thức vào kho phải có giá thu.
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
    v_purchase,
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

-- ============================================================
-- STEP 5: Hồ sơ xe — tạo hồ sơ mới cũng bắt buộc giá thu > 0; sửa hồ sơ thì
--         giá cũ được giữ và mọi role sửa được giá (họ là người nhập nó).
-- ============================================================

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
  -- Xe mới vào kho phải có giá thu ngay: không còn hồ sơ cost_pending.
  IF p_id IS NULL AND (v_purchase IS NULL OR v_purchase <= 0) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_PRICE_REQUIRED';
  END IF;
  -- Xe CŨ (chưa giá) khi được bổ sung giá thì giá phải > 0, không được ghi 0.
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

-- Nhập lô và soạn thảo nhanh cùng dùng chung máy validate này, nên giá thu bắt
-- buộc phải đi vào cả hai đường: bỏ gate tài chính, bắt buộc purchase_price > 0.
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
  v_purchase bigint;
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
    -- Giá thu bắt buộc ngay từ dòng nhập lô: xe vào kho là có giá vốn.
    BEGIN
      v_purchase := private.money_input(v_row, 'purchase_price');
      IF v_purchase IS NULL OR v_purchase <= 0 THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_PRICE_REQUIRED';
      END IF;
    EXCEPTION WHEN invalid_parameter_value THEN
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
-- STEP 6: BÁN XE — ba chốt mới: xe đang chờ duyệt thì không bán được;
--         bán dưới giá thu là quyền OWNER; giá bán phải > 0.
-- ============================================================

CREATE OR REPLACE FUNCTION private.sell_vehicle_impl(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
  v_sale public.sales;
  v_purchase bigint;
  v_expenses bigint;
  v_price bigint := private.money_input(p_data, 'sale_price');
  v_initial bigint := private.money_input(p_data, 'initial_payment', 0);
  v_date date := coalesce((p_data->>'sale_date')::date, private.today());
  v_due_date date := nullif(p_data->>'due_date', '')::date;
  v_sold_by uuid := nullif(p_data->>'sold_by', '')::uuid;
  v_payment public.payments;
  v_settings public.system_settings;
  v_phone text;
  v_channel text;
  v_status text;
  v_preview text;
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = (p_data->>'vehicle_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_vehicle.status NOT IN ('IN_STOCK', 'RESERVED') THEN RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_NOT_AVAILABLE'; END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETE_PENDING';
  END IF;
  -- Một đơn bán dưới giá thu đang chờ = xe đã có lời đề xuất. Không cho giao dịch
  -- khác chen vào (kể cả OWNER): OWNER quyết đơn trước, rồi bán.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'SALE_BELOW_COST' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_APPROVAL_PENDING';
  END IF;
  IF v_date < v_vehicle.purchase_date OR v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SALE_DATE'; END IF;
  IF v_due_date IS NOT NULL AND v_due_date < v_date THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE'; END IF;
  IF v_price IS NULL OR v_price <= 0 OR v_initial > v_price THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT'; END IF;
  IF EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE' AND expense_date > v_date) THEN RAISE EXCEPTION USING errcode = '22023', message = 'SALE_BEFORE_EXPENSE'; END IF;
  SELECT purchase_price INTO v_purchase FROM public.vehicle_financials WHERE vehicle_id = v_vehicle.id;
  IF v_purchase IS NULL THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_COST_REQUIRED'; END IF;
  -- Bán lỗ vốn thuộc về chủ cửa hàng. STAFF/MANAGER gặp mã này thì UI đổi nút
  -- thành "Gửi yêu cầu duyệt"; server là nơi chốt, không tin frontend.
  IF v_price < v_purchase AND private.current_role() <> 'OWNER' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'SALE_BELOW_COST_APPROVAL_REQUIRED';
  END IF;
  -- sold_by chỉ được gửi nội bộ (lúc OWNER duyệt đơn của nhân viên) và chỉ khi
  -- người đó còn hoạt động; client thường không có quyền đổi người bán.
  IF v_sold_by IS NOT NULL AND (private.current_role() <> 'OWNER'
      OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_sold_by AND p.active)) THEN
    v_sold_by := NULL;
  END IF;
  v_sold_by := coalesce(v_sold_by, v_actor);
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE';
  PERFORM private.safe_money(v_purchase::numeric + v_expenses);
  INSERT INTO public.sales (vehicle_id, customer_name, customer_phone, sale_price, sale_date, due_date, sold_by, notes)
  VALUES (v_vehicle.id, btrim(p_data->>'customer_name'), btrim(coalesce(p_data->>'customer_phone', '')), v_price, v_date, v_due_date, v_sold_by, coalesce(p_data->>'notes', '')) RETURNING * INTO v_sale;
  INSERT INTO public.sale_financials (sale_id, purchase_cost_snapshot, expense_cost_snapshot, sale_price_snapshot) VALUES (v_sale.id, v_purchase, v_expenses, v_price);
  IF v_initial > 0 THEN
    INSERT INTO public.payments (sale_id, amount, payment_method, payment_date, created_by)
    VALUES (v_sale.id, v_initial, coalesce((p_data->>'payment_method')::public.payment_method, 'CASH'), v_date, v_actor) RETURNING * INTO v_payment;
    PERFORM private.audit('CREATE_PAYMENT', 'payments', v_payment.id, null, to_jsonb(v_payment), v_vehicle.id);
  END IF;
  UPDATE public.vehicles SET status = 'SOLD', updated_at = now() WHERE id = v_vehicle.id;
  PERFORM private.audit('CREATE_SALE', 'sales', v_sale.id, null,
    to_jsonb(v_sale) || jsonb_build_object('purchase_cost_snapshot', v_purchase, 'expense_cost_snapshot', v_expenses,
      'total_cost_snapshot', v_purchase + v_expenses, 'gross_profit', v_price - v_purchase - v_expenses), v_vehicle.id);

  -- The outbox is atomic in the normal path. An outbox/schema failure rolls back
  -- only this nested block, never the already validated sale transaction.
  BEGIN
    SELECT * INTO v_settings FROM public.system_settings WHERE id;
    v_phone := CASE WHEN private.normalize_customer_phone(v_sale.customer_phone) ~ '^0[35789][0-9]{8}$'
      THEN '+84' || substr(private.normalize_customer_phone(v_sale.customer_phone),2) ELSE NULL END;
    v_channel := CASE WHEN v_settings.customer_messaging_enabled AND v_settings.sale_thank_you_enabled THEN v_settings.primary_message_channel ELSE 'DISABLED' END;
    v_status := CASE WHEN v_channel = 'DISABLED' THEN 'SKIPPED' WHEN v_phone IS NULL THEN 'SKIPPED' ELSE 'QUEUED' END;
    v_preview := 'Cảm ơn Quý khách đã mua xe tại ' || coalesce(v_settings.store_name,'cửa hàng') || '.';
    INSERT INTO public.message_outbox(event_type, channel, sale_id, recipient_phone, template_code, template_variables, status, next_attempt_at, created_by, processed_at,
      last_error_code, last_error_message_safe)
    VALUES ('SALE_THANK_YOU', v_channel, v_sale.id, coalesce(v_phone,''), 'sale_thank_you_v1',
      jsonb_build_object('customer_name',v_sale.customer_name,'store_name',v_settings.store_name,'support_phone',v_settings.support_phone),
      v_status, CASE WHEN v_status='QUEUED' THEN now() ELSE NULL END, v_actor, CASE WHEN v_status='QUEUED' THEN NULL ELSE now() END,
      CASE WHEN v_channel='DISABLED' THEN 'MESSAGING_DISABLED' WHEN v_phone IS NULL THEN 'INVALID_OR_MISSING_PHONE' END,
      CASE WHEN v_channel='DISABLED' THEN 'Chưa cấu hình kênh nhắn tin.' WHEN v_phone IS NULL THEN 'Số điện thoại khách hàng không hợp lệ.' END);
    INSERT INTO public.customer_communications(sale_id, channel, message_type, template_code, message_preview, provider, status, created_by, failed_at)
    VALUES (v_sale.id, v_channel, 'THANK_YOU', 'sale_thank_you_v1', v_preview,
      'DISABLED', v_status, v_actor,
      CASE WHEN v_status='FAILED' THEN now() END);
    PERFORM private.audit(CASE WHEN v_status='QUEUED' THEN 'AUTO_MESSAGE_QUEUED' ELSE 'MESSAGE_SKIPPED' END, 'message_outbox', v_sale.id,
      null, jsonb_build_object('status',v_status,'channel',v_channel), v_vehicle.id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN v_sale.id;
END $$;

-- ============================================================
-- STEP 7: Gửi yêu cầu duyệt bán dưới giá thu (STAFF/MANAGER).
--         Không tạo sales, không đổi trạng thái xe — chỉ ghi một đơn.
-- ============================================================

CREATE OR REPLACE FUNCTION private.request_sale_below_cost_impl(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
  v_purchase bigint;
  v_expenses bigint;
  v_price bigint := private.money_input(p_data, 'sale_price');
  v_initial bigint := private.money_input(p_data, 'initial_payment', 0);
  v_date date := coalesce((p_data->>'sale_date')::date, private.today());
  v_due_date date := nullif(p_data->>'due_date', '')::date;
  v_customer text := btrim(coalesce(p_data->>'customer_name', ''));
  v_payload jsonb;
  v_approval uuid;
  v_reason text;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = (p_data->>'vehicle_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['MANAGER','STAFF']::public.user_role[]);
  IF v_vehicle.status NOT IN ('IN_STOCK', 'RESERVED') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_NOT_AVAILABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETE_PENDING';
  END IF;
  -- idx duy nhất approval_open_unique đã chặn hai đơn mở cùng xe; check này cho
  -- ra mã nghiệp vụ rõ ràng thay vì lỗi 23505 thô.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'SALE_BELOW_COST' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'ALREADY_PENDING';
  END IF;

  IF v_customer = '' OR char_length(v_customer) > 160 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_CUSTOMER_NAME';
  END IF;
  IF v_date < v_vehicle.purchase_date OR v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SALE_DATE';
  END IF;
  IF v_due_date IS NOT NULL AND v_due_date < v_date THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE';
  END IF;
  IF v_price IS NULL OR v_price <= 0 OR v_initial > v_price THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT';
  END IF;

  SELECT purchase_price INTO v_purchase FROM public.vehicle_financials WHERE vehicle_id = v_vehicle.id;
  IF v_purchase IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_COST_REQUIRED';
  END IF;
  -- Đường này chỉ dành cho đơn dưới giá thu; bán đủ giá thì bấm bán bình thường.
  IF v_price >= v_purchase THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_NOT_BELOW_COST';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE' AND expense_date > v_date) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_BEFORE_EXPENSE';
  END IF;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses
  FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE';

  -- Bản đề xuất server-sinh: chủ cửa hàng duyệt đúng dữ liệu này, và snapshot chi
  -- phí là căn cứ bắt lỗi "duyệt dữ liệu lỗi thời" ở STEP 8.
  v_payload := jsonb_build_object(
    'vehicle_id', v_vehicle.id,
    'customer_name', v_customer,
    'customer_phone', btrim(coalesce(p_data->>'customer_phone', '')),
    'sale_price', v_price,
    'sale_date', v_date,
    'due_date', v_due_date,
    'payment_method', coalesce(nullif(p_data->>'payment_method',''), 'CASH'),
    'initial_payment', v_initial,
    'notes', coalesce(p_data->>'notes', ''),
    'sold_by', v_actor,
    'snapshot_purchase_price', v_purchase,
    'snapshot_expense_total', v_expenses,
    'shortfall', v_purchase - v_price
  );

  v_reason := 'Bán dưới giá thu xe '
    || private.vehicle_label_text(v_vehicle.license_plate, v_vehicle.frame_number, v_vehicle.internal_code)
    || ': giá thu ' || private.money_text(v_purchase)
    || ' → giá bán ' || private.money_text(v_price)
    || ' (thiếu ' || private.money_text(v_purchase - v_price) || ').';

  INSERT INTO public.approval_requests (kind, subject_id, requested_by, reason, payload)
  VALUES ('SALE_BELOW_COST', v_vehicle.id, v_actor, left(v_reason, 1000), v_payload)
  RETURNING id INTO v_approval;

  PERFORM private.audit('REQUEST_SALE_BELOW_COST', 'vehicles', v_vehicle.id, null,
    v_payload || jsonb_build_object('request_id', v_approval, 'requested_by', v_actor), v_vehicle.id);

  RETURN v_approval;
END $$;

-- Wrapper theo đúng protocol biên lai: thiếu request_id là fail closed, retry
-- cùng payload trả lại đúng đơn đã tạo (không tạo đơn thứ hai).
CREATE OR REPLACE FUNCTION public.request_sale_below_cost(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
    VALUES(v_actor,'request_sale_below_cost',v_request,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='request_sale_below_cost' AND request_id=v_request FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_CONFLICT';
  END IF;
  IF v_receipt.result IS NOT NULL THEN RETURN (v_receipt.result #>> '{}')::uuid; END IF;
  v_result := private.request_sale_below_cost_impl(v_payload);
  UPDATE private.operation_receipts SET result=to_jsonb(v_result)
    WHERE actor_id=v_actor AND operation='request_sale_below_cost' AND request_id=v_request;
  RETURN v_result;
END $$;

-- ============================================================
-- STEP 8: OWNER quyết định. APPROVE = hoàn tất đúng bản đề xuất (một
--         transaction: sales + payments + xe SOLD + doanh thu/lợi nhuận),
--         REJECT = xe không bị bán, nhân viên nhận thông báo.
-- ============================================================

CREATE OR REPLACE FUNCTION private.resolve_sale_approval_impl(
  p_approval_id uuid, p_action text, p_note text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_req public.approval_requests;
  v_vehicle public.vehicles;
  v_payload jsonb;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_purchase bigint;
  v_expenses bigint;
  v_sale uuid;
BEGIN
  IF p_action NOT IN ('APPROVE','REJECT') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_APPROVAL_ACTION';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  -- Khoá hàng đợi trước: hai lượt duyệt song song thì lượt sau thấy
  -- status đã đổi và nhận ALREADY_RESOLVED, không thể bán hai lần.
  SELECT * INTO v_req FROM public.approval_requests
    WHERE id = p_approval_id AND kind = 'SALE_BELOW_COST' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='APPROVAL_NOT_FOUND'; END IF;
  IF v_req.status <> 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='ALREADY_RESOLVED';
  END IF;
  v_payload := v_req.payload;

  IF p_action = 'REJECT' THEN
    UPDATE public.approval_requests
      SET status='REJECTED', resolved_by=v_actor, resolved_at=now(), resolution_note=v_note, updated_at=now()
      WHERE id = p_approval_id;
    PERFORM private.audit('REJECT_SALE_BELOW_COST', 'vehicles', v_req.subject_id, null,
      v_payload || jsonb_build_object('request_id', p_approval_id, 'requested_by', v_req.requested_by,
        'note', v_note, 'decided_by', v_actor), v_req.subject_id);
    RETURN NULL;
  END IF;

  -- Duyệt phải kiểm lại hiện trạng, không tin dữ liệu lúc gửi.
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_req.subject_id FOR UPDATE;
  IF NOT FOUND OR v_vehicle.status NOT IN ('IN_STOCK','RESERVED') THEN
    RAISE EXCEPTION USING errcode='22023', message='VEHICLE_NOT_AVAILABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE vehicle_id = v_req.subject_id AND status = 'COMPLETED') THEN
    RAISE EXCEPTION USING errcode='22023', message='VEHICLE_NOT_AVAILABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_req.subject_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode='22023', message='DELETE_PENDING';
  END IF;
  SELECT purchase_price INTO v_purchase FROM public.vehicle_financials WHERE vehicle_id = v_req.subject_id;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses
  FROM public.vehicle_expenses WHERE vehicle_id = v_req.subject_id AND status = 'ACTIVE';
  -- Giá vốn đã đổi sau khi nhân viên gửi đơn → con số chủ đang nhìn không còn là
  -- con số nhân viên đã đề xuất. Đơn phải được rút và gửi lại với số mới.
  IF v_purchase IS DISTINCT FROM (v_payload->>'snapshot_purchase_price')::bigint
     OR v_expenses IS DISTINCT FROM (v_payload->>'snapshot_expense_total')::bigint THEN
    RAISE EXCEPTION USING errcode='40001', message='APPROVAL_STALE_DATA';
  END IF;
  IF v_purchase IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='PURCHASE_COST_REQUIRED';
  END IF;
  IF ((v_payload->>'sale_date')::date) < v_vehicle.purchase_date THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_SALE_DATE';
  END IF;

  -- Đánh dấu đã duyệt TRƯỚC khi ghi bán: guard SALE_APPROVAL_PENDING trong
  -- sell_vehicle_impl vì thế không chặn chính đơn này, còn mọi lỗi phía sau
  -- vẫn rollback cả đơn lẫn giao dịch (không có "duyệt nửa chừng").
  UPDATE public.approval_requests
    SET status='APPROVED', resolved_by=v_actor, resolved_at=now(), resolution_note=v_note, updated_at=now()
    WHERE id = p_approval_id;

  v_sale := private.sell_vehicle_impl(v_payload || jsonb_build_object('sold_by', v_req.requested_by));

  PERFORM private.audit('APPROVE_SALE_BELOW_COST', 'vehicles', v_req.subject_id, null,
    v_payload || jsonb_build_object('request_id', p_approval_id, 'sale_id', v_sale,
      'requested_by', v_req.requested_by, 'note', v_note, 'approved_by', v_actor), v_req.subject_id);
  RETURN v_sale;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_sale_approval(
  p_approval_id uuid, p_action text, p_note text DEFAULT NULL, p_request_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_hash bytea := sha256(convert_to(
    jsonb_build_object('approval_id', p_approval_id, 'action', p_action, 'note', p_note)::text, 'UTF8'));
  v_receipt private.operation_receipts;
  v_result jsonb;
  v_sale uuid;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED'; END IF;
  INSERT INTO private.operation_receipts(actor_id,operation,request_id,payload_hash)
    VALUES(v_actor,'resolve_sale_approval',p_request_id,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='resolve_sale_approval' AND request_id=p_request_id FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_CONFLICT';
  END IF;
  -- Retry sau khi response bị mất: biên lai đã có thì trả lại đúng kết quả cũ,
  -- không bán thêm lần nữa.
  IF v_receipt.result IS NOT NULL THEN RETURN v_receipt.result; END IF;
  v_sale := private.resolve_sale_approval_impl(p_approval_id, p_action, p_note);
  v_result := jsonb_build_object('approval_id', p_approval_id, 'action', p_action, 'sale_id', v_sale);
  UPDATE private.operation_receipts SET result=v_result
    WHERE actor_id=v_actor AND operation='resolve_sale_approval' AND request_id=p_request_id;
  RETURN v_result;
END $$;

-- ============================================================
-- STEP 9: Nhân viên rút đơn khi số liệu đổi (giá bán, khách, chi phí) để gửi lại
--         bản mới. CHỦ cũng rút được. Rút = REJECTED, không mất lịch sử.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_sale_approval(p_approval_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_req public.approval_requests;
  v_note text := left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''),
    'Yêu cầu được rút để gửi lại bản mới'), 1000);
BEGIN
  SELECT * INTO v_req FROM public.approval_requests
    WHERE id = p_approval_id AND kind = 'SALE_BELOW_COST' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='APPROVAL_NOT_FOUND'; END IF;
  IF v_req.status <> 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='ALREADY_RESOLVED';
  END IF;
  IF private.current_role() <> 'OWNER' AND v_req.requested_by <> v_actor THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;

  UPDATE public.approval_requests
    SET status='REJECTED', resolved_by=v_actor, resolved_at=now(), resolution_note=v_note, updated_at=now()
    WHERE id = p_approval_id;
  PERFORM private.audit('CANCEL_SALE_BELOW_COST', 'vehicles', v_req.subject_id, null,
    v_req.payload || jsonb_build_object('request_id', p_approval_id, 'requested_by', v_req.requested_by,
      'note', v_note, 'cancelled_by', v_actor), v_req.subject_id);
END $$;

-- ============================================================
-- STEP 10: Đơn bán đang chờ cũng chặn đường xoá xe, để không có xe "bốc hơi"
--          khỏi kho trong lúc chủ còn đang cân nhắc lời đề xuất.
-- ============================================================

CREATE OR REPLACE FUNCTION public.request_delete_vehicle(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode='22023', message='DELETION_REASON_REQUIRED';
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='VEHICLE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE vehicle_id = p_id) THEN
    RAISE EXCEPTION USING errcode='22023', message='SALE_HISTORY_EXISTS';
  END IF;
  IF v_vehicle.status NOT IN ('IN_STOCK','RESERVED') THEN
    RAISE EXCEPTION USING errcode='22023', message='VEHICLE_NOT_AVAILABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode='22023', message='ALREADY_PENDING';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = p_id AND ar.kind = 'SALE_BELOW_COST' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode='22023', message='SALE_APPROVAL_PENDING';
  END IF;
  INSERT INTO public.approval_requests(kind, subject_id, requested_by, reason)
  VALUES ('VEHICLE_DELETION', p_id, v_actor, btrim(p_reason));
  PERFORM private.audit('REQUEST_DELETE_VEHICLE', 'vehicles', p_id, null,
    jsonb_build_object('reason', btrim(p_reason), 'requested_by', v_actor), p_id);
END $$;

CREATE OR REPLACE FUNCTION public.delete_vehicle(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_old public.vehicles;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETION_REASON_REQUIRED';
  END IF;
  -- A vehicle already queued for approval is resolved through the approvals page,
  -- not by a parallel direct purge.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETE_PENDING';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = p_id AND ar.kind = 'SALE_BELOW_COST' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_APPROVAL_PENDING';
  END IF;
  v_old := private.purge_vehicle(p_id);
  PERFORM private.audit(
    'DELETE_VEHICLE', 'vehicles', p_id, to_jsonb(v_old),
    jsonb_build_object('reason', btrim(p_reason), 'deleted_by', v_actor, 'deleted_at', now()),
    NULL
  );
END $$;

-- Duyệt xóa xe cũng phải đi qua chốt này: không được "xóa" một xe đang có đơn
-- bán chờ duyệt, để hàng đợi không còn con trỏ mồ côi và chủ không mất xe ngay
-- trước mắt.
CREATE OR REPLACE FUNCTION public.resolve_vehicle_deletion(p_request_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_req public.approval_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_action NOT IN ('APPROVE','RESTORE') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_APPROVAL_ACTION';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  SELECT * INTO v_req FROM public.approval_requests WHERE id = p_request_id AND kind = 'VEHICLE_DELETION' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='APPROVAL_NOT_FOUND'; END IF;
  IF v_req.status <> 'PENDING' THEN RAISE EXCEPTION USING errcode='22023', message='ALREADY_RESOLVED'; END IF;
  IF p_action = 'APPROVE' AND EXISTS (SELECT 1 FROM public.approval_requests ar
      WHERE ar.subject_id = v_req.subject_id AND ar.kind = 'SALE_BELOW_COST' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode='22023', message='SALE_APPROVAL_PENDING';
  END IF;

  IF p_action = 'APPROVE' THEN
    -- purge_vehicle re-checks sale history and removes the full record set.
    PERFORM private.purge_vehicle(v_req.subject_id);
    UPDATE public.approval_requests
      SET status='APPROVED', resolved_by=v_actor, resolved_at=now(), resolution_note=v_note, updated_at=now()
      WHERE id = p_request_id;
    PERFORM private.audit('APPROVE_VEHICLE_DELETION', 'vehicles', v_req.subject_id, null,
      jsonb_build_object('request_id', p_request_id, 'reason', v_req.reason, 'requested_by', v_req.requested_by, 'note', v_note, 'approved_by', v_actor));
  ELSE
    UPDATE public.approval_requests
      SET status='REJECTED', resolved_by=v_actor, resolved_at=now(), resolution_note=v_note, updated_at=now()
      WHERE id = p_request_id;
    PERFORM private.audit('RESTORE_VEHICLE_DELETION', 'vehicles', v_req.subject_id, null,
      jsonb_build_object('request_id', p_request_id, 'reason', v_req.reason, 'requested_by', v_req.requested_by, 'note', v_note, 'restored_by', v_actor));
  END IF;
END $$;

-- ============================================================
-- STEP 11: Cùng một trang "Chờ duyệt" hiển thị đủ dữ liệu chủ cần quyết:
--          xe · biển số · số khung · giá thu · giá bán đề xuất · chênh lệch ·
--          người gửi · thời gian. Thêm bộ lọc status để xem lại lịch sử.
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_pending_approvals(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 50)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_status text := upper(btrim(coalesce(nullif(p_filters->>'status', ''), 'PENDING')));
  v_kind text := nullif(btrim(coalesce(p_filters->>'kind', '')), '');
  v_items jsonb; v_total bigint;
BEGIN
  IF v_status NOT IN ('PENDING','APPROVED','REJECTED') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT count(*) INTO v_total FROM public.approval_requests ar
    WHERE ar.status = v_status AND (v_kind IS NULL OR ar.kind = v_kind);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'kind', x.kind, 'subject_id', x.subject_id, 'reason', x.reason,
      'status', x.status, 'payload', x.payload,
      'requested_by', x.requested_by, 'requester_name', x.requester_name, 'created_at', x.created_at,
      'resolved_at', x.resolved_at, 'resolution_note', x.resolution_note,
      'resolved_by_name', x.resolved_by_name,
      'vehicle_code', x.vehicle_code, 'vehicle_title', x.vehicle_title,
      'vehicle_subtitle', x.vehicle_subtitle, 'license_plate', x.license_plate,
      'frame_number', x.frame_number, 'vehicle_status', x.vehicle_status
    ) ORDER BY x.rn), '[]'::jsonb) INTO v_items
  FROM (
    SELECT row_number() OVER (ORDER BY ar.created_at DESC, ar.id DESC) AS rn,
      ar.id, ar.kind, ar.subject_id, ar.requested_by, ar.reason, ar.status, ar.payload,
      ar.created_at, ar.resolved_at, ar.resolution_note,
      req.full_name AS requester_name,
      res.full_name AS resolved_by_name,
      v.internal_code AS vehicle_code,
      private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) AS vehicle_title,
      private.vehicle_display(v) ->> 'vehicle_subtitle' AS vehicle_subtitle,
      v.license_plate, v.frame_number, v.status::text AS vehicle_status
    FROM public.approval_requests ar
    LEFT JOIN public.profiles req ON req.id = ar.requested_by
    LEFT JOIN public.profiles res ON res.id = ar.resolved_by
    LEFT JOIN public.vehicles v ON v.id = ar.subject_id
    WHERE ar.status = v_status AND (v_kind IS NULL OR ar.kind = v_kind)
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT v_limit OFFSET v_offset
  ) x;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

-- ============================================================
-- STEP 12: Chuông báo cho chủ cửa hàng khi có đơn, và cho nhân viên khi
--          đơn được quyết/rút. Copy có tiền chỉ đi tới người có quyền tiền
--          hoặc chính tác giả hành động; người nhận khác nhận bản không con số.
-- ============================================================

CREATE OR REPLACE FUNCTION private.notify_from_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text := NEW.action;
  v_actor uuid := coalesce(NEW.user_id, auth.uid());
  v_new jsonb := coalesce(NEW.new_data, '{}'::jsonb);
  v_actor_name text;
  v_label text;
  v_sale uuid;
  v_sale_code text;
  v_vehicle uuid;
  v_extra uuid;               -- entity owner to include beyond actor + bosses
  v_title text;
  v_body_money text;          -- copy shown to finance-visible recipients
  v_body_plain text;          -- copy shown to everyone else
  v_link text;
  v_amount bigint;
  v_reason text;
  v_customer text;
  v_seller text;
  r record;
BEGIN
  IF v_action NOT IN ('CREATE_ACQUISITION','CANCEL_ACQUISITION','CREATE_SALE','CANCEL_SALE',
                      'CREATE_PAYMENT','VOID_PAYMENT','CREATE_VEHICLE','UPDATE_VEHICLE',
                      'REQUEST_DELETE_VEHICLE',
                      'REQUEST_SALE_BELOW_COST','APPROVE_SALE_BELOW_COST',
                      'REJECT_SALE_BELOW_COST','CANCEL_SALE_BELOW_COST') THEN
    RETURN NEW;
  END IF;

  -- Dedup: CREATE_VEHICLE issued inside acquire_vehicle (CREATE_ACQUISITION audited
  -- first, same transaction, same vehicle id) must not double-notify.
  IF v_action = 'CREATE_VEHICLE' AND EXISTS (
    SELECT 1 FROM public.audit_logs al
    WHERE al.action = 'CREATE_ACQUISITION'
      AND al.created_at = NEW.created_at
      AND al.new_data -> 'vehicle' ->> 'id' = NEW.entity_id::text
  ) THEN
    RETURN NEW;
  END IF;

  v_actor_name := coalesce(
    (SELECT p.full_name FROM public.profiles p WHERE p.id = v_actor), 'Hệ thống');

  IF v_action = 'CREATE_ACQUISITION' THEN
    v_vehicle := (v_new -> 'vehicle' ->> 'id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thu');
    v_seller := nullif(btrim(coalesce(v_new ->> 'seller_name', '')), '');
    -- purchase_price 0 means "chờ giá vốn" (cost pending), not a real price.
    v_amount := NULLIF((v_new ->> 'purchase_price')::bigint, 0);
    v_title := left('Thu vào xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã thu vào xe ' || v_label
      || coalesce(' từ ' || v_seller, '')
      || coalesce(', giá vốn ' || private.money_text(v_amount), '');
    v_body_plain := v_actor_name || ' đã thu vào xe ' || v_label;
    v_link := '/acquisitions';
  ELSIF v_action = 'CANCEL_ACQUISITION' THEN
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã thu');
    v_extra := (v_new ->> 'created_by')::uuid;
    v_reason := nullif(btrim(coalesce(v_new ->> 'cancellation_reason', '')), '');
    v_title := left('Hủy thu xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã hủy phiếu thu xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '');
    v_body_plain := v_body_money;
    v_link := '/acquisitions';
  ELSIF v_action = 'CREATE_SALE' THEN
    v_sale := NEW.entity_id;
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã bán');
    v_customer := nullif(btrim(coalesce(v_new ->> 'customer_name', '')), '');
    v_amount := (v_new ->> 'sale_price')::bigint;
    v_extra := (SELECT v2.created_by FROM public.vehicles v2 WHERE v2.id = v_vehicle);
    v_title := left('Bán xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã bán xe ' || v_label
      || coalesce(' cho ' || v_customer, '')
      || coalesce(', giá bán ' || private.money_text(v_amount), '');
    v_body_plain := v_actor_name || ' đã bán xe ' || v_label
      || coalesce(' cho ' || v_customer, '');
    v_link := '/sales/' || v_sale;
    -- The initial payment recorded inside sell_vehicle shares this transaction;
    -- its standalone notification is redundant noise. now() is stable per txn.
    DELETE FROM public.notifications n
    WHERE n.action = 'CREATE_PAYMENT'
      AND n.created_at = NEW.created_at
      AND n.deep_link = '/sales/' || v_sale::text;
  ELSIF v_action = 'CANCEL_SALE' THEN
    v_sale := NEW.entity_id;
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã bán');
    v_extra := (v_new ->> 'sold_by')::uuid;
    v_reason := nullif(btrim(coalesce(v_new ->> 'cancellation_reason', '')), '');
    v_title := left('Hủy bán xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã hủy giao dịch bán xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '');
    v_body_plain := v_body_money;
    v_link := '/sales/' || v_sale;
    -- Same-transaction VOID_PAYMENT rows come from the cancel cascade, not a
    -- standalone correction; the CANCEL_SALE notice covers them.
    DELETE FROM public.notifications n
    WHERE n.action = 'VOID_PAYMENT'
      AND n.created_at = NEW.created_at
      AND n.deep_link = '/sales/' || v_sale::text;
  ELSIF v_action = 'CREATE_PAYMENT' OR v_action = 'VOID_PAYMENT' THEN
    v_sale := (v_new ->> 'sale_id')::uuid;
    v_amount := (v_new ->> 'amount')::bigint;
    SELECT s.sale_code, s.sold_by,
           private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_sale_code, v_extra, v_label
    FROM public.sales s
    JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE s.id = v_sale;
    v_vehicle := (SELECT s2.vehicle_id FROM public.sales s2 WHERE s2.id = v_sale);
    v_label := coalesce(v_label, 'xe đã bán');
    IF v_action = 'CREATE_PAYMENT' THEN
      v_title := left('Thu tiền đơn ' || coalesce(v_sale_code, 'bán xe'), 160);
      v_body_money := v_actor_name || ' đã ghi nhận thu ' || private.money_text(v_amount)
        || ' cho đơn bán xe ' || v_label;
      v_body_plain := v_actor_name || ' đã ghi nhận một khoản thu cho đơn bán xe ' || v_label;
    ELSE
      v_title := left('Hủy khoản thu đơn ' || coalesce(v_sale_code, 'bán xe'), 160);
      v_body_money := v_actor_name || ' đã hủy khoản thu ' || private.money_text(v_amount)
        || ' của đơn bán xe ' || v_label;
      v_body_plain := v_actor_name || ' đã hủy một khoản thu của đơn bán xe ' || v_label;
    END IF;
    v_link := '/sales/' || v_sale;
  ELSIF v_action = 'CREATE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thêm');
    v_title := left('Thêm xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã thêm xe ' || v_label || ' vào tồn kho';
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  ELSIF v_action = 'REQUEST_DELETE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_reason := nullif(btrim(coalesce(v_new ->> 'reason', '')), '');
    v_title := left('Yêu cầu xóa xe ' || v_label, 160);
    v_body_money := v_actor_name || ' gửi yêu cầu xóa xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '') || ' — đang chờ chủ cửa hàng duyệt.';
    v_body_plain := v_body_money;
    v_link := '/approvals';
  ELSIF v_action IN ('REQUEST_SALE_BELOW_COST','APPROVE_SALE_BELOW_COST',
                     'REJECT_SALE_BELOW_COST','CANCEL_SALE_BELOW_COST') THEN
    -- Đơn bán dưới giá thu: người gửi luôn nằm trong danh sách nhận (v_extra)
    -- để nhân viên biết chủ đã quyết định, dù chủ là người bấm nút.
    v_vehicle := NEW.entity_id;
    v_extra := nullif(v_new ->> 'requested_by', '')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_reason := nullif(btrim(coalesce(v_new ->> 'note', '')), '');
    v_link := '/approvals';
    IF v_action = 'REQUEST_SALE_BELOW_COST' THEN
      v_amount := NULLIF(v_new ->> 'shortfall', '')::bigint;
      v_title := left('Chờ duyệt: bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' xin bán dưới giá thu xe ' || v_label
        || coalesce(', thiếu ' || private.money_text(v_amount), '')
        || ' — chờ chủ cửa hàng duyệt.';
      v_body_plain := v_actor_name || ' xin bán dưới giá thu xe ' || v_label
        || ' — đang chờ chủ cửa hàng duyệt.';
    ELSIF v_action = 'APPROVE_SALE_BELOW_COST' THEN
      v_sale := NULLIF(v_new ->> 'sale_id', '')::uuid;
      v_amount := NULLIF(v_new ->> 'sale_price', '')::bigint;
      v_title := left('Đã duyệt bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' đã duyệt và ghi nhận bán xe ' || v_label
        || coalesce(' với giá ' || private.money_text(v_amount), '')
        || coalesce('. Ghi chú: ' || v_reason, '');
      v_body_plain := v_actor_name || ' đã duyệt cho bán xe ' || v_label
        || coalesce('. Ghi chú: ' || v_reason, '');
      v_link := coalesce('/sales/' || v_sale::text, '/approvals');
    ELSIF v_action = 'REJECT_SALE_BELOW_COST' THEN
      v_title := left('Từ chối bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' đã từ chối yêu cầu bán dưới giá thu xe ' || v_label
        || coalesce('. Lý do: ' || v_reason, '');
      v_body_plain := v_actor_name || ' đã từ chối yêu cầu bán xe ' || v_label
        || coalesce('. Lý do: ' || v_reason, '');
    ELSE -- CANCEL_SALE_BELOW_COST: rút đơn là tin không con số với mọi người.
      v_title := left('Đã rút yêu cầu bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' đã rút yêu cầu duyệt bán xe ' || v_label
        || coalesce('. Lý do: ' || v_reason, '');
      v_body_plain := v_body_money;
    END IF;
  ELSE -- UPDATE_VEHICLE
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_extra := (v_new ->> 'created_by')::uuid;
    v_title := left('Cập nhật xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã cập nhật thông tin xe ' || v_label;
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  END IF;

  -- Recipients: the actor (all roles, self-confirmation), every active
  -- OWNER/MANAGER, plus the non-acting owner of the affected transaction.
  FOR r IN
    SELECT p.id, p.role, p.can_view_financials FROM public.profiles p
    WHERE p.id = v_actor
       OR (p.role IN ('OWNER', 'MANAGER') AND p.active)
       OR (v_extra IS NOT NULL AND p.id = v_extra AND p.active
           AND (v_actor IS NULL OR p.id <> v_actor))
    GROUP BY p.id, p.role, p.can_view_financials
  LOOP
    -- Money copy only for OWNER, finance-visible MANAGERs, and the actor itself.
    IF r.role = 'OWNER' OR (r.role = 'MANAGER' AND r.can_view_financials) OR r.id = v_actor THEN
      INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                        vehicle_id, title, body, deep_link)
      VALUES (r.id, v_actor, v_action, NEW.entity_type, NEW.entity_id,
              v_vehicle, v_title, left(v_body_money, 400), v_link);
    ELSE
      INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                        vehicle_id, title, body, deep_link)
      VALUES (r.id, v_actor, v_action, NEW.entity_type, NEW.entity_id,
              v_vehicle, v_title, left(v_body_plain, 400), v_link);
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

-- ============================================================
-- STEP 13: Bề mặt RPC. Helper nội bộ đóng kín; ba hàm mới mở cho
--          authenticated (bên trong đã chốt quyền OWNER/STAFF-MANAGER).
-- ============================================================

REVOKE ALL ON FUNCTION
  private.request_sale_below_cost_impl(jsonb),
  private.resolve_sale_approval_impl(uuid, text, text)
  FROM public, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.request_sale_below_cost(jsonb),
  public.resolve_sale_approval(uuid, text, text, uuid),
  public.cancel_sale_approval(uuid, text)
  FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.request_sale_below_cost(jsonb),
  public.resolve_sale_approval(uuid, text, text, uuid),
  public.cancel_sale_approval(uuid, text)
  TO authenticated, service_role;

-- Tự kiểm chứng: thiếu một trong ba RPC hoặc cột payload là migration đã áp
-- dở dang — thà abort còn hơn để UI bán xe chạy với nửa quy tắc.
DO $$
BEGIN
  IF (SELECT count(DISTINCT p.proname) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('request_sale_below_cost','resolve_sale_approval','cancel_sale_approval')) <> 3 THEN
    RAISE EXCEPTION USING errcode = 'P0001', message = 'APPROVAL_RPC_MISSING';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'approval_requests'
        AND a.attname = 'payload' AND a.attnum > 0) <> 1 THEN
    RAISE EXCEPTION USING errcode = 'P0001', message = 'APPROVAL_PAYLOAD_MISSING';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
