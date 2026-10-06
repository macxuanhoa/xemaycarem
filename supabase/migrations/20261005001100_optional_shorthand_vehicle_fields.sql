-- Let shorthand batch intake save a vehicle before its model and purchase
-- price are known. Staff can complete those fields from the vehicle record.

ALTER TABLE public.vehicles
  DROP CONSTRAINT IF EXISTS vehicles_model_check,
  ADD CONSTRAINT vehicles_model_check
    CHECK (model IS NOT NULL AND char_length(btrim(model)) <= 120);

COMMENT ON COLUMN public.vehicles.model IS
  'Vehicle model; may be empty when unknown at shorthand intake. Cap 120 chars.';

-- A missing price is allowed for the shorthand batch flow. The normal form
-- still requires it in the UI; the nullable vehicle_financials value keeps
-- the vehicle marked as cost-pending until staff fill it in later.
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

  IF v_frame = '' THEN
    v_frame := 'GEN-' || substr(gen_random_uuid()::text, 1, 12);
  END IF;

  IF v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
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
    btrim(coalesce(p_data->>'model', '')),
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
    IF length(btrim(coalesce(v_row->>'model', ''))) > 120 THEN v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'model', 'message', 'INVALID_MODEL'); END IF;
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

CREATE OR REPLACE FUNCTION public.import_vehicles(p_vehicles jsonb) RETURNS jsonb
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
      'model', coalesce(v_row->>'model', ''),
      'acquisition_date', coalesce(nullif(v_row->>'purchase_date', ''), private.today()::text),
      'seller_name', coalesce(v_row->>'supplier_name', ''),
      'seller_phone', coalesce(v_row->>'supplier_phone', ''),
      'acquisition_notes', coalesce(v_row->>'notes', '')
    );
    v_ids := array_append(v_ids, public.acquire_vehicle(v_data));
  END LOOP;
  RETURN jsonb_build_object('imported_count', cardinality(v_ids), 'vehicle_ids', to_jsonb(v_ids));
END $$;
