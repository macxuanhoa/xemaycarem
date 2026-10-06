BEGIN;

-- All acquisition/vehicle deletion and cancellation paths acquire vehicle first.
-- Read only the relationship before taking locks; re-read the acquisition after
-- the vehicle lock so a concurrently deleted/cancelled record cannot be used.
CREATE OR REPLACE FUNCTION public.cancel_acquisition(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_acq public.acquisitions;
  v_vehicle public.vehicles;
  v_vehicle_id uuid;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CANCELLATION_REASON_REQUIRED';
  END IF;

  SELECT vehicle_id INTO v_vehicle_id FROM public.acquisitions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'ACQUISITION_NOT_FOUND'; END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  SELECT * INTO v_acq FROM public.acquisitions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'ACQUISITION_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  IF v_acq.status <> 'COMPLETED' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'ACQUISITION_ALREADY_CANCELLED';
  END IF;
  IF v_vehicle.status = 'SOLD' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CANNOT_CANCEL_SOLD_ACQUISITION';
  END IF;

  UPDATE public.acquisitions
  SET status = 'CANCELLED', cancellation_reason = btrim(p_reason),
      cancelled_by = v_actor, cancelled_at = now(), updated_at = now()
  WHERE id = p_id;
  UPDATE public.vehicles SET status = 'CANCELLED', updated_at = now() WHERE id = v_acq.vehicle_id;
  PERFORM private.audit(
    'CANCEL_ACQUISITION', 'acquisitions', p_id, to_jsonb(v_acq),
    to_jsonb(v_acq) || jsonb_build_object('status', 'CANCELLED', 'cancellation_reason', btrim(p_reason)),
    v_acq.vehicle_id
  );
END $$;

CREATE OR REPLACE FUNCTION private.purge_vehicle(p_id uuid) RETURNS public.vehicles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_vehicle public.vehicles;
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  -- delete_vehicle/delete_acquisition may have waited after their initial check.
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  IF EXISTS (SELECT 1 FROM public.sales WHERE vehicle_id = p_id) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_HISTORY_EXISTS';
  END IF;
  PERFORM set_config('private.allow_record_purge', 'on', true);
  DELETE FROM public.acquisitions WHERE vehicle_id = p_id;
  DELETE FROM public.vehicle_financials WHERE vehicle_id = p_id;
  DELETE FROM public.vehicle_expenses WHERE vehicle_id = p_id;
  DELETE FROM public.vehicle_images WHERE vehicle_id = p_id;
  DELETE FROM public.vehicle_activity WHERE vehicle_id = p_id;
  DELETE FROM public.vehicles WHERE id = p_id;
  RETURN v_vehicle;
END $$;

CREATE OR REPLACE FUNCTION public.delete_acquisition(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_acq public.acquisitions;
  v_vehicle public.vehicles;
  v_vehicle_id uuid;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETION_REASON_REQUIRED';
  END IF;
  SELECT vehicle_id INTO v_vehicle_id FROM public.acquisitions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'ACQUISITION_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  SELECT * INTO v_acq FROM public.acquisitions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'ACQUISITION_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_vehicle := private.purge_vehicle(v_acq.vehicle_id);
  PERFORM private.audit(
    'DELETE_ACQUISITION', 'acquisitions', p_id, to_jsonb(v_acq),
    jsonb_build_object('reason', btrim(p_reason), 'deleted_by', v_actor, 'deleted_at', now(), 'vehicle', to_jsonb(v_vehicle)),
    NULL
  );
END $$;

-- CREATE OR REPLACE keeps the existing grant matrix; the private helper stays
-- inaccessible to browser roles. Explicit revocation makes this property clear.
REVOKE ALL ON FUNCTION private.purge_vehicle(uuid) FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
