-- 042 · Optional brand and frame_number on intake/acquisition.
--
-- Business reality: at the moment a STAFF photographs a bike being acquired,
-- they often only have the license plate, seller phone, and a rough model.
-- Chassis number is scratched/rusted and brand is inferred from a faded badge.
-- The prior pipeline (schema CHECK + RPC guard + FRAME_NUMBER_REQUIRED error +
-- hard-coded zod min(1)) forced them to invent values, which polluted the
-- dedup index and created phantom "unique frames" like "CHUA-CO".
--
-- This migration makes BOTH fields optional at every layer while preserving
-- every other rule:
--   * vehicles.brand  : CHECK relaxed to allow '' (upper bound 80 kept).
--                       DEFAULT '' added so a missing key no longer trips NOT NULL.
--   * vehicles.frame_number : stays NOT NULL DEFAULT '' + UNIQUE. The two
--                       write RPCs substitute a "GEN-<uuid>" placeholder when
--                       the caller sends blank (mirroring save_vehicle's
--                       pre-existing behaviour), so the UNIQUE constraint
--                       keeps protecting real frames only.
--   * acquire_vehicle : FRAME_NUMBER_REQUIRED guard removed + GEN placeholder +
--                       brand coalesce.
--   * save_vehicle    : INSERT branch brand coalesce.
--   * validate_import_vehicles : frame empty and brand empty checks removed;
--                       length caps retained.
-- Every other rule in those functions (FUTURE_DATE, PURCHASE_PRICE_REQUIRED,
-- DUPLICATE_FRAME_NUMBER, SOLD_VEHICLE_LOCKED, financial gating, audit shape,
-- actor checks, search_path='') is preserved verbatim.

-- ============================================================
-- STEP 1 · Allow blank brand on vehicles
-- ============================================================

ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_brand_check;
ALTER TABLE public.vehicles
  ALTER COLUMN brand SET DEFAULT '',
  ADD CONSTRAINT vehicles_brand_check
    CHECK (brand IS NOT NULL AND char_length(btrim(brand)) <= 80);

COMMENT ON COLUMN public.vehicles.brand IS
  'Manufacturer label; may be empty when unknown at intake. Cap 80 chars.';

-- ============================================================
-- STEP 2 · acquire_vehicle — blank frame and blank brand become legal
-- ============================================================

CREATE OR REPLACE FUNCTION public.acquire_vehicle(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_frame text := btrim(coalesce(p_data->>'frame_number', ''));
  v_vehicle_id uuid;
  v_vehicle public.vehicles;
  v_acquisition public.acquisitions;
  v_purchase bigint := private.money_input(p_data, 'purchase_price');
  v_date date := coalesce((p_data->>'acquisition_date')::date, private.today());
  v_fin boolean := private.can_financials();
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  IF p_data ? 'purchase_price' AND NOT v_fin THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
  END IF;

  -- Frame is now OPTIONAL. When the caller leaves it blank we mint a synthetic
  -- placeholder so the UNIQUE(frame_number) constraint still guards real
  -- chassis numbers without rejecting a legitimately unknown VIN. Same
  -- technique save_vehicle already used for "Nhập xe mới".
  IF v_frame = '' THEN
    v_frame := 'GEN-' || substr(gen_random_uuid()::text, 1, 12);
  END IF;

  IF v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
  END IF;

  IF v_fin AND v_purchase IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_PRICE_REQUIRED';
  END IF;

  SELECT id INTO v_vehicle_id FROM public.vehicles WHERE frame_number = v_frame;

  IF v_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
    IF v_vehicle.status NOT IN ('CANCELLED') THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_FRAME_NUMBER';
    END IF;
  END IF;

  INSERT INTO public.vehicles (
    frame_number, engine_number, license_plate,
    brand, model, variant, year, color, odometer,
    purchase_date, asking_price, status,
    supplier_name, supplier_phone, notes, created_by
  ) VALUES (
    v_frame,
    btrim(coalesce(p_data->>'engine_number', '')),
    btrim(coalesce(p_data->>'license_plate', '')),
    btrim(coalesce(p_data->>'brand', '')),
    btrim(p_data->>'model'),
    btrim(coalesce(p_data->>'variant', '')),
    nullif(p_data->>'year', '')::integer,
    btrim(coalesce(p_data->>'color', '')),
    coalesce(nullif(p_data->>'odometer', '')::integer, 0),
    v_date,
    private.money_input(p_data, 'asking_price', 0),
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
    to_jsonb(v_vehicle) || jsonb_build_object('purchase_price', v_purchase),
    v_vehicle.id
  );

  RETURN v_vehicle.id;
END $$;

-- ============================================================
-- STEP 3 · save_vehicle — INSERT branch tolerates missing brand
-- ============================================================
-- Only the brand expression changes (from btrim(p_data->>'brand') to
-- btrim(coalesce(p_data->>'brand', ''))). UPDATE branch already uses
-- COALESCE, so no other edit required.

CREATE OR REPLACE FUNCTION public.save_vehicle(p_data jsonb, p_id uuid default null) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.vehicles; v_new public.vehicles; v_purchase bigint; v_old_purchase bigint;
  v_status public.vehicle_status; v_date date; v_old_json jsonb;
  v_frame text;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT'; END IF;
  IF p_data ? 'purchase_price' AND NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501', message='FINANCIAL_ACCESS_DENIED'; END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.vehicles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='VEHICLE_NOT_FOUND'; END IF;
    SELECT purchase_price INTO v_old_purchase FROM public.vehicle_financials WHERE vehicle_id = p_id;
  END IF;
  v_status := COALESCE((p_data->>'status')::public.vehicle_status, v_old.status, 'IN_STOCK');
  IF v_status = 'SOLD' AND (p_id IS NULL OR v_old.status <> 'SOLD') THEN RAISE EXCEPTION USING errcode='22023', message='USE_SELL_VEHICLE'; END IF;
  IF (v_status = 'CANCELLED' OR v_old.status = 'CANCELLED') AND private.current_role() = 'STAFF' THEN RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED'; END IF;
  v_purchase := private.money_input(p_data, 'purchase_price', v_old_purchase);
  v_date := COALESCE((p_data->>'purchase_date')::date, v_old.purchase_date, private.today());
  IF v_date > private.today() THEN RAISE EXCEPTION USING errcode='22023', message='FUTURE_DATE'; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = p_id AND status = 'ACTIVE' AND expense_date < v_date) THEN
    RAISE EXCEPTION USING errcode='22023', message='PURCHASE_AFTER_EXPENSE';
  END IF;
  IF v_old.status = 'SOLD' AND (v_status <> 'SOLD' OR v_purchase IS DISTINCT FROM v_old_purchase
      OR v_date <> v_old.purchase_date OR private.money_input(p_data, 'asking_price', v_old.asking_price) <> v_old.asking_price) THEN
    RAISE EXCEPTION USING errcode='22023', message='SOLD_VEHICLE_LOCKED';
  END IF;

  v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), 'GEN-' || substr(gen_random_uuid()::text, 1, 12));

  IF p_id IS NULL THEN
    INSERT INTO public.vehicles(
      license_plate, brand, model, variant, year, color, frame_number, engine_number,
      odometer, purchase_date, asking_price, status, supplier_name, supplier_phone, notes, created_by
    ) VALUES (
      btrim(COALESCE(p_data->>'license_plate', '')), btrim(COALESCE(p_data->>'brand', '')), btrim(p_data->>'model'), btrim(COALESCE(p_data->>'variant', '')),
      NULLIF(p_data->>'year', '')::integer, btrim(COALESCE(p_data->>'color', '')), v_frame, btrim(COALESCE(p_data->>'engine_number', '')),
      COALESCE(NULLIF(p_data->>'odometer', '')::integer, 0), v_date, private.money_input(p_data, 'asking_price'), v_status,
      btrim(COALESCE(p_data->>'supplier_name', '')), btrim(COALESCE(p_data->>'supplier_phone', '')), COALESCE(p_data->>'notes', ''), v_actor
    ) RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by) VALUES (v_new.id, v_purchase, v_actor);
    PERFORM private.audit('CREATE_VEHICLE', 'vehicles', v_new.id, NULL, to_jsonb(v_new) || jsonb_build_object('purchase_price', v_purchase), v_new.id);
  ELSE
    v_old_json := to_jsonb(v_old) || jsonb_build_object('purchase_price', v_old_purchase);
    UPDATE public.vehicles SET
      license_plate = btrim(COALESCE(p_data->>'license_plate', license_plate)),
      brand = btrim(COALESCE(p_data->>'brand', brand)),
      model = btrim(COALESCE(p_data->>'model', model)),
      variant = btrim(COALESCE(p_data->>'variant', variant)),
      year = CASE WHEN p_data ? 'year' THEN NULLIF(p_data->>'year', '')::integer ELSE year END,
      color = btrim(COALESCE(p_data->>'color', color)),
      frame_number = COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), frame_number),
      engine_number = btrim(COALESCE(p_data->>'engine_number', engine_number)),
      odometer = COALESCE(NULLIF(p_data->>'odometer', '')::integer, odometer),
      purchase_date = v_date,
      asking_price = private.money_input(p_data, 'asking_price', asking_price),
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

    PERFORM private.audit('UPDATE_VEHICLE', 'vehicles', v_new.id, v_old_json, to_jsonb(v_new) || jsonb_build_object('purchase_price', v_purchase), v_new.id);
  END IF;
  RETURN v_new.id;
END $$;

-- ============================================================
-- STEP 4 · validate_import_vehicles — blank frame/brand are legal
-- ============================================================
-- Only two rules change inside the row loop:
--   * frame_number empty → previously INVALID_FRAME_NUMBER, now accepted.
--   * brand char_length BETWEEN 1 AND 80 → only reject > 80.
-- Everything else (engine, plate length/dedup, purchase/asking price money,
-- dates, year/odometer bounds, status) is byte-for-byte identical.

CREATE OR REPLACE FUNCTION public.validate_import_vehicles(p_vehicles jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_row jsonb;
  v_index integer;
  v_field text;
  v_value text;
  v_seen_frames text[] := ARRAY[]::text[];
  v_seen_engines text[] := ARRAY[]::text[];
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
    FOREACH v_field IN ARRAY ARRAY['frame_number','engine_number','license_plate'] LOOP
      v_value := upper(btrim(coalesce(v_row->>v_field, '')));
      -- Blank frame/engine/plate are all allowed now; only over-length is a bug.
      IF length(v_value) > (CASE WHEN v_field = 'license_plate' THEN 30 ELSE 100 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
      IF v_field = 'license_plate' THEN
        v_value := regexp_replace(v_value, '[^A-Z0-9]', '', 'g');
      END IF;
      IF v_value <> '' THEN
        IF (v_field = 'frame_number' AND (v_value = ANY(v_seen_frames) OR EXISTS (SELECT 1 FROM public.vehicles WHERE upper(btrim(frame_number)) = v_value)))
          OR (v_field = 'engine_number' AND (v_value = ANY(v_seen_engines) OR EXISTS (SELECT 1 FROM public.vehicles WHERE upper(btrim(engine_number)) = v_value)))
          OR (v_field = 'license_plate' AND (v_value = ANY(v_seen_plates) OR EXISTS (SELECT 1 FROM public.vehicles WHERE regexp_replace(upper(license_plate), '[^A-Z0-9]', '', 'g') = v_value))) THEN
          v_duplicates := v_duplicates || jsonb_build_object('index', v_index, 'field', v_field, 'value', v_value, 'message',
            CASE v_field WHEN 'frame_number' THEN 'Số khung đã tồn tại hoặc trùng trong file' WHEN 'engine_number' THEN 'Số máy đã tồn tại hoặc trùng trong file' ELSE 'Biển số đã tồn tại hoặc trùng trong file' END);
        END IF;
        IF v_field = 'frame_number' THEN v_seen_frames := array_append(v_seen_frames, v_value);
        ELSIF v_field = 'engine_number' THEN v_seen_engines := array_append(v_seen_engines, v_value);
        ELSE v_seen_plates := array_append(v_seen_plates, v_value); END IF;
      END IF;
    END LOOP;
    IF length(btrim(coalesce(v_row->>'brand', ''))) > 80 THEN v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'brand', 'message', 'INVALID_BRAND'); END IF;
    IF length(btrim(coalesce(v_row->>'model', ''))) NOT BETWEEN 1 AND 120 THEN v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'model', 'message', 'INVALID_MODEL'); END IF;
    FOREACH v_field IN ARRAY ARRAY['variant','color','supplier_name','supplier_phone','notes'] LOOP
      IF length(coalesce(v_row->>v_field, '')) > (CASE v_field
        WHEN 'variant' THEN 120 WHEN 'color' THEN 80 WHEN 'supplier_name' THEN 200
        WHEN 'supplier_phone' THEN 40 ELSE 10000 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
    END LOOP;
    FOREACH v_field IN ARRAY ARRAY['purchase_price','asking_price'] LOOP
      BEGIN
        PERFORM private.money_input(v_row, v_field, 0);
        IF v_field = 'purchase_price' AND NOT private.can_financials() AND v_row ? 'purchase_price' THEN
          RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
        END IF;
        IF v_field = 'purchase_price' AND private.can_financials() AND v_row->>v_field IS NULL THEN
          RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_PRICE_REQUIRED';
        END IF;
      EXCEPTION WHEN invalid_parameter_value OR insufficient_privilege THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', SQLERRM);
      END;
    END LOOP;
    BEGIN
      IF nullif(v_row->>'purchase_date', '') IS NOT NULL AND v_row->>'purchase_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PURCHASE_DATE';
      END IF;
      v_date := coalesce(nullif(v_row->>'purchase_date', '')::date, private.today());
      IF v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_DATE_IN_FUTURE'; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'purchase_date', 'message', 'INVALID_PURCHASE_DATE');
    END;
    FOREACH v_field IN ARRAY ARRAY['year','odometer'] LOOP
      BEGIN
        v_value := nullif(v_row->>v_field, '');
        IF v_value IS NOT NULL THEN
          IF v_value !~ '^[0-9]+$' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER'; END IF;
          v_number := v_value::integer;
          IF (v_field = 'year' AND v_number NOT BETWEEN 1900 AND 2100) OR (v_field = 'odometer' AND v_number NOT BETWEEN 0 AND 10000000) THEN
            RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER';
          END IF;
        END IF;
      EXCEPTION WHEN invalid_parameter_value OR numeric_value_out_of_range OR invalid_text_representation THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END;
    END LOOP;
    IF v_row ? 'status' AND v_row->>'status' IS DISTINCT FROM 'IN_STOCK' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'status', 'message', 'INVALID_VEHICLE_STATUS');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('duplicates', v_duplicates, 'errors', v_errors);
END $$;
