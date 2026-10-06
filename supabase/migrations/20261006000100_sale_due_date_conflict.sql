BEGIN;

-- Keep the existing two-argument RPC for older clients. Updated clients send
-- the sale revision captured when opening the editor, including date removal.
-- No default is used, so named arguments resolve unambiguously in PostgREST.
CREATE OR REPLACE FUNCTION public.update_sale_due_date(
  p_sale_id uuid,
  p_due_date date,
  p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.sales;
  v_new public.sales;
BEGIN
  SELECT * INTO v_old FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND'; END IF;
  -- The role may have changed while this request waited for the sale lock.
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_old.status <> 'COMPLETED' THEN RAISE EXCEPTION USING errcode = '22023', message = 'SALE_NOT_ACTIVE'; END IF;
  IF p_expected_updated_at IS DISTINCT FROM v_old.updated_at THEN
    RAISE EXCEPTION USING errcode = '40001', message = 'SALE_DUE_DATE_CONFLICT';
  END IF;
  IF p_due_date IS NOT NULL AND p_due_date < v_old.sale_date THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE';
  END IF;

  UPDATE public.sales
  SET due_date = p_due_date,
      -- Advance even for two saves inside the same transaction; now() does not.
      updated_at = greatest(clock_timestamp(), v_old.updated_at + interval '1 microsecond')
  WHERE id = p_sale_id
  RETURNING * INTO v_new;

  PERFORM private.audit('UPDATE_SALE_DUE_DATE', 'sales', p_sale_id, to_jsonb(v_old), to_jsonb(v_new), v_old.vehicle_id);
  RETURN private.sale_json(v_new);
END $$;

REVOKE ALL ON FUNCTION public.update_sale_due_date(uuid, date, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sale_due_date(uuid, date, timestamptz) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;
