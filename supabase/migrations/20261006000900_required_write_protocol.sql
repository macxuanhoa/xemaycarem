-- Mandatory client protocol: fail closed when an operation identity or revision
-- is missing. Apply after versioned RPCs and compatible current frontend exist.
-- No business row rewrite and no new IDs manufactured for legacy retries.
BEGIN;

CREATE OR REPLACE FUNCTION public.acquire_vehicle(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid := nullif(p_data->>'request_id','')::uuid;
  v_payload jsonb := jsonb_set(p_data - 'request_id', '{frame_number}', to_jsonb(upper(btrim(coalesce(p_data->>'frame_number','')))));
  v_hash bytea := sha256(convert_to(v_payload::text, 'UTF8'));
  v_receipt private.operation_receipts;
  v_result uuid;
BEGIN
  IF v_request IS NULL THEN RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED'; END IF;
  INSERT INTO private.operation_receipts(actor_id,operation,request_id,payload_hash)
    VALUES(v_actor,'acquire_vehicle',v_request,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='acquire_vehicle' AND request_id=v_request FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_CONFLICT';
  END IF;
  IF v_receipt.result IS NOT NULL THEN RETURN (v_receipt.result #>> '{}')::uuid; END IF;
  v_result := private.acquire_vehicle_impl(v_payload);
  UPDATE private.operation_receipts SET result=to_jsonb(v_result)
    WHERE actor_id=v_actor AND operation='acquire_vehicle' AND request_id=v_request;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.import_vehicles(p_vehicles jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid;
  v_rows jsonb;
  v_hash bytea;
  v_receipt private.operation_receipts;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_vehicles) = 'array' THEN RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED'; END IF;
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'object' OR jsonb_typeof(p_vehicles->'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  v_request := nullif(p_vehicles->>'request_id','')::uuid;
  IF v_request IS NULL THEN RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED'; END IF;
  v_rows := p_vehicles->'rows';
  v_hash := sha256(convert_to(v_rows::text, 'UTF8'));
  INSERT INTO private.operation_receipts(actor_id,operation,request_id,payload_hash)
    VALUES(v_actor,'import_vehicles',v_request,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='import_vehicles' AND request_id=v_request FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_CONFLICT';
  END IF;
  IF v_receipt.result IS NOT NULL THEN RETURN v_receipt.result; END IF;
  v_result := private.import_vehicles_impl(v_rows);
  UPDATE private.operation_receipts SET result=v_result
    WHERE actor_id=v_actor AND operation='import_vehicles' AND request_id=v_request;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION private.import_vehicles_impl(p_vehicles jsonb) RETURNS jsonb
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
    -- The parent batch receipt already commits every row atomically. No row UUID is
    -- invented here; this internal helper is inaccessible to client roles.
    v_data := jsonb_set(v_data, '{frame_number}', to_jsonb(upper(btrim(coalesce(v_data->>'frame_number','')))));
    v_ids := array_append(v_ids, private.acquire_vehicle_impl(v_data));
  END LOOP;
  RETURN jsonb_build_object('imported_count', cardinality(v_ids), 'vehicle_ids', to_jsonb(v_ids));
END $$;

CREATE OR REPLACE FUNCTION public.update_sale_due_date(p_sale_id uuid,p_due_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  -- Retain the old RPC signature so stale clients receive an actionable error,
  -- rather than performing a write without a comparison baseline.
  RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
END $$;

CREATE OR REPLACE FUNCTION public.save_expense(p_kind text,p_data jsonb,p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid:=private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_id uuid; v_vehicle_id uuid; v_vehicle public.vehicles; v_old jsonb; v_new jsonb; v_date date;
BEGIN
  IF jsonb_typeof(p_data)<>'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;
  IF p_kind='vehicle' THEN
    IF p_id IS NOT NULL THEN
      SELECT vehicle_id INTO v_vehicle_id FROM public.vehicle_expenses WHERE id=p_id;
      IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='EXPENSE_NOT_FOUND'; END IF;
    ELSE v_vehicle_id:=(p_data->>'vehicle_id')::uuid;
    END IF;
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id=v_vehicle_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='VEHICLE_NOT_FOUND'; END IF;
    PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
    IF v_vehicle.status NOT IN ('IN_STOCK','RESERVED') THEN RAISE EXCEPTION USING errcode='22023',message='VEHICLE_EXPENSE_LOCKED'; END IF;
    IF p_data ? 'vehicle_id' AND (p_data->>'vehicle_id')::uuid<>v_vehicle_id THEN RAISE EXCEPTION USING errcode='22023',message='EXPENSE_VEHICLE_IMMUTABLE'; END IF;
    IF p_id IS NOT NULL THEN
      SELECT to_jsonb(e) INTO v_old FROM public.vehicle_expenses e WHERE id=p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='EXPENSE_NOT_FOUND'; END IF;
      PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
      IF v_old->>'status'<>'ACTIVE' THEN RAISE EXCEPTION USING errcode='22023',message='EXPENSE_CANCELLED'; END IF;
      IF nullif(btrim(p_data->>'expected_updated_at'),'') IS NULL THEN
        RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
      END IF;
      IF (p_data->>'expected_updated_at')::timestamptz IS DISTINCT FROM (v_old->>'updated_at')::timestamptz THEN
        RAISE EXCEPTION USING errcode='40001',message='EXPENSE_EDIT_CONFLICT';
      END IF;
    END IF;
    v_date:=coalesce((p_data->>'expense_date')::date,(v_old->>'expense_date')::date,private.today());
    IF v_date>private.today() OR v_date<v_vehicle.purchase_date THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_EXPENSE_DATE'; END IF;
    IF p_id IS NULL THEN
      INSERT INTO public.vehicle_expenses(vehicle_id,expense_type,description,amount,expense_date,created_by)
      VALUES(v_vehicle_id,(p_data->>'expense_type')::public.vehicle_expense_type,btrim(p_data->>'description'),private.money_input(p_data,'amount'),v_date,v_actor)
      RETURNING id,to_jsonb(vehicle_expenses) INTO v_id,v_new;
    ELSE
      UPDATE public.vehicle_expenses SET expense_type=coalesce((p_data->>'expense_type')::public.vehicle_expense_type,expense_type),
        description=btrim(coalesce(p_data->>'description',description)),amount=private.money_input(p_data,'amount',amount),expense_date=v_date,
        updated_at=greatest(clock_timestamp(),(v_old->>'updated_at')::timestamptz + interval '1 microsecond')
      WHERE id=p_id RETURNING id,to_jsonb(vehicle_expenses) INTO v_id,v_new;
    END IF;
  ELSIF p_kind='business' THEN
    IF p_id IS NOT NULL THEN
      SELECT to_jsonb(e) INTO v_old FROM public.business_expenses e WHERE id=p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='EXPENSE_NOT_FOUND'; END IF;
      PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
      IF v_old->>'status'<>'ACTIVE' THEN RAISE EXCEPTION USING errcode='22023',message='EXPENSE_CANCELLED'; END IF;
      IF nullif(btrim(p_data->>'expected_updated_at'),'') IS NULL THEN
        RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
      END IF;
      IF (p_data->>'expected_updated_at')::timestamptz IS DISTINCT FROM (v_old->>'updated_at')::timestamptz THEN
        RAISE EXCEPTION USING errcode='40001',message='EXPENSE_EDIT_CONFLICT';
      END IF;
    END IF;
    v_date:=coalesce((p_data->>'expense_date')::date,(v_old->>'expense_date')::date,private.today());
    IF v_date>private.today() THEN RAISE EXCEPTION USING errcode='22023',message='FUTURE_DATE'; END IF;
    IF p_id IS NULL THEN
      INSERT INTO public.business_expenses(category,description,amount,expense_date,created_by)
      VALUES((p_data->>'category')::public.business_expense_category,btrim(p_data->>'description'),private.money_input(p_data,'amount'),v_date,v_actor)
      RETURNING id,to_jsonb(business_expenses) INTO v_id,v_new;
    ELSE
      UPDATE public.business_expenses SET category=coalesce((p_data->>'category')::public.business_expense_category,category),
        description=btrim(coalesce(p_data->>'description',description)),amount=private.money_input(p_data,'amount',amount),expense_date=v_date,
        updated_at=greatest(clock_timestamp(),(v_old->>'updated_at')::timestamptz + interval '1 microsecond')
      WHERE id=p_id RETURNING id,to_jsonb(business_expenses) INTO v_id,v_new;
    END IF;
  ELSE RAISE EXCEPTION USING errcode='22023',message='INVALID_EXPENSE_KIND';
  END IF;
  PERFORM private.audit(CASE WHEN p_id IS NULL THEN 'ADD_EXPENSE' ELSE 'UPDATE_EXPENSE' END,p_kind||'_expenses',v_id,v_old,v_new,v_vehicle_id);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION private.acquire_vehicle_impl(jsonb),private.import_vehicles_impl(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.acquire_vehicle(jsonb),public.import_vehicles(jsonb),public.update_sale_due_date(uuid,date),public.save_expense(text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_vehicle(jsonb),public.import_vehicles(jsonb),public.update_sale_due_date(uuid,date),public.save_expense(text,jsonb,uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
