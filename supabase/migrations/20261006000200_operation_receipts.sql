-- Stable operation receipts are committed atomically with intake/import/sale.
-- Historical implementations and legacy JSON payloads remain compatible.
BEGIN;
CREATE TABLE private.operation_receipts (
  actor_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('acquire_vehicle','import_vehicles','sell_vehicle')),
  request_id uuid NOT NULL,
  payload_hash bytea NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, request_id)
);
ALTER TABLE private.operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.operation_receipts FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.acquire_vehicle(jsonb) RENAME TO acquire_vehicle_impl;
ALTER FUNCTION public.acquire_vehicle_impl(jsonb) SET SCHEMA private;
ALTER FUNCTION public.import_vehicles(jsonb) RENAME TO import_vehicles_impl;
ALTER FUNCTION public.import_vehicles_impl(jsonb) SET SCHEMA private;
ALTER FUNCTION public.sell_vehicle(jsonb) RENAME TO sell_vehicle_impl;
ALTER FUNCTION public.sell_vehicle_impl(jsonb) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.acquire_vehicle_impl(jsonb), private.import_vehicles_impl(jsonb), private.sell_vehicle_impl(jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.acquire_vehicle(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid := nullif(p_data->>'request_id','')::uuid;
  v_payload jsonb := jsonb_set(p_data - 'request_id', '{frame_number}', to_jsonb(upper(btrim(coalesce(p_data->>'frame_number','')))));
  v_hash bytea := sha256(convert_to(v_payload::text, 'UTF8'));
  v_receipt private.operation_receipts;
  v_result uuid;
BEGIN
  IF v_request IS NULL THEN RETURN private.acquire_vehicle_impl(v_payload); END IF;
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

CREATE FUNCTION public.sell_vehicle(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid := nullif(p_data->>'request_id','')::uuid;
  v_payload jsonb := p_data - 'request_id';
  v_hash bytea := sha256(convert_to(v_payload::text, 'UTF8'));
  v_receipt private.operation_receipts;
  v_result uuid;
BEGIN
  IF v_request IS NULL THEN RETURN private.sell_vehicle_impl(p_data); END IF;
  INSERT INTO private.operation_receipts(actor_id,operation,request_id,payload_hash)
    VALUES(v_actor,'sell_vehicle',v_request,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='sell_vehicle' AND request_id=v_request FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_CONFLICT';
  END IF;
  IF v_receipt.result IS NOT NULL THEN RETURN (v_receipt.result #>> '{}')::uuid; END IF;
  v_result := private.sell_vehicle_impl(v_payload);
  UPDATE private.operation_receipts SET result=to_jsonb(v_result)
    WHERE actor_id=v_actor AND operation='sell_vehicle' AND request_id=v_request;
  RETURN v_result;
END $$;

-- Old clients send an array. New clients send {request_id, rows}; signature unchanged.
CREATE FUNCTION public.import_vehicles(p_vehicles jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid;
  v_rows jsonb;
  v_hash bytea;
  v_receipt private.operation_receipts;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_vehicles) = 'array' THEN RETURN private.import_vehicles_impl(p_vehicles); END IF;
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'object' OR jsonb_typeof(p_vehicles->'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  v_request := nullif(p_vehicles->>'request_id','')::uuid;
  IF v_request IS NULL THEN RAISE EXCEPTION USING errcode='22023', message='OPERATION_REQUEST_REQUIRED'; END IF;
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

CREATE FUNCTION public.get_operation_result(p_operation text, p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_result jsonb;
BEGIN
  IF p_operation NOT IN ('acquire_vehicle','import_vehicles','sell_vehicle') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_OPERATION';
  END IF;
  SELECT result INTO v_result FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation=p_operation AND request_id=p_request_id;
  RETURN jsonb_build_object('confirmed',v_result IS NOT NULL,'result',v_result);
END $$;
REVOKE ALL ON FUNCTION public.acquire_vehicle(jsonb), public.import_vehicles(jsonb), public.sell_vehicle(jsonb), public.get_operation_result(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acquire_vehicle(jsonb), public.import_vehicles(jsonb), public.sell_vehicle(jsonb), public.get_operation_result(text,uuid) TO authenticated;
COMMIT;
