BEGIN;

-- Retain the RPC signature and create/cancel behavior. New editors supply a
-- revision in p_data; older clients remain callable without that extra key.
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
      IF p_data ? 'expected_updated_at' AND
         (p_data->>'expected_updated_at')::timestamptz IS DISTINCT FROM (v_old->>'updated_at')::timestamptz THEN
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
      IF p_data ? 'expected_updated_at' AND
         (p_data->>'expected_updated_at')::timestamptz IS DISTINCT FROM (v_old->>'updated_at')::timestamptz THEN
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

-- CREATE OR REPLACE preserves the existing grants. Document the same matrix.
REVOKE ALL ON FUNCTION public.save_expense(text,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_expense(text,jsonb,uuid) TO authenticated, service_role;

COMMIT;
