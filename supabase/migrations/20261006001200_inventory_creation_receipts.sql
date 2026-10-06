-- The inventory-only creation route must have the same durable request identity
-- as acquisition, without manufacturing an acquisition or changing its cost data.
BEGIN;

ALTER TABLE private.operation_receipts
  DROP CONSTRAINT operation_receipts_operation_check,
  ADD CONSTRAINT operation_receipts_operation_check CHECK (
    operation IN ('acquire_vehicle','import_vehicles','sell_vehicle','create_vehicle')
  );

ALTER FUNCTION public.save_vehicle(jsonb,uuid) RENAME TO save_vehicle_impl;
ALTER FUNCTION public.save_vehicle_impl(jsonb,uuid) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.save_vehicle_impl(jsonb,uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.save_vehicle(p_data jsonb,p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid;
  v_payload jsonb;
  v_hash bytea;
  v_receipt private.operation_receipts;
  v_result uuid;
BEGIN
  IF p_id IS NOT NULL THEN
    -- Editing retains the existing state/cost/revision behavior and signature.
    RETURN private.save_vehicle_impl(p_data,p_id);
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
  END IF;
  v_request := nullif(p_data->>'request_id','')::uuid;
  IF v_request IS NULL THEN
    RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
  END IF;
  v_payload := jsonb_set(p_data - 'request_id','{frame_number}',to_jsonb(upper(btrim(coalesce(p_data->>'frame_number','')))));
  v_hash := sha256(convert_to(v_payload::text,'UTF8'));
  INSERT INTO private.operation_receipts(actor_id,operation,request_id,payload_hash)
    VALUES(v_actor,'create_vehicle',v_request,v_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO v_receipt FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation='create_vehicle' AND request_id=v_request FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_receipt.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING errcode='22023',message='OPERATION_REQUEST_CONFLICT';
  END IF;
  IF v_receipt.result IS NOT NULL THEN RETURN (v_receipt.result #>> '{}')::uuid; END IF;
  v_result := private.save_vehicle_impl(v_payload,NULL);
  UPDATE private.operation_receipts SET result=to_jsonb(v_result)
    WHERE actor_id=v_actor AND operation='create_vehicle' AND request_id=v_request;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.get_operation_result(p_operation text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_result jsonb;
BEGIN
  IF p_operation NOT IN ('acquire_vehicle','import_vehicles','sell_vehicle','create_vehicle') THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_OPERATION';
  END IF;
  SELECT result INTO v_result FROM private.operation_receipts
    WHERE actor_id=v_actor AND operation=p_operation AND request_id=p_request_id;
  RETURN jsonb_build_object('confirmed',v_result IS NOT NULL,'result',v_result);
END $$;

REVOKE ALL ON FUNCTION public.save_vehicle(jsonb,uuid),public.get_operation_result(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_vehicle(jsonb,uuid),public.get_operation_result(text,uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
