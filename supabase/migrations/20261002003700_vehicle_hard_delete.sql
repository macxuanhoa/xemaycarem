-- Migration: 20261002003700_vehicle_hard_delete.sql
-- Description: Xóa cứng (hard delete) xe kho và phiếu thu cho các role cao OWNER/MANAGER.
--   * `delete_vehicle` purges an inventory vehicle together with its acquisition
--     (identity documents cascade via 030), financials, expenses, image metadata and
--     activity trail. Any vehicle that has EVER been sold — COMPLETED or CANCELLED —
--     is blocked with SALE_HISTORY_EXISTS so bookkeeping and payment history stay intact;
--     those records must keep using the cancel flows.
--   * `delete_acquisition` removes a phiếu thu mua together with the xe it created,
--     through the same guarded purge path.
--   * The immutable-history trigger keeps blocking every UPDATE and every DELETE on
--     audit_logs/sale_financials, but gains one narrow exception: DELETE on
--     vehicle_activity is allowed only while the transaction-local GUC
--     `private.allow_record_purge` is 'on'. Only `private.purge_vehicle` sets that flag
--     (set_config is_local=true), and no direct browser DELETE exists — business rows
--     are reachable exclusively through these SECURITY DEFINER RPCs, which re-check the
--     OWNER/MANAGER role first.
--   * audit_logs rows are never deleted; every purge is recorded as DELETE_VEHICLE /
--     DELETE_ACQUISITION with the full old-row snapshot and the mandatory reason.
--   * vehicle_images metadata rows are removed; the private bucket binaries become
--     orphan objects that an administrator prunes under the existing retention policy.

-- ============================================================
-- STEP 1: Narrow purge exception inside the immutable-history trigger
-- ============================================================

CREATE OR REPLACE FUNCTION private.immutable_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Only the guarded vehicle purge may remove activity rows, and only when the
  -- transaction-local flag was raised by private.purge_vehicle itself.
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'vehicle_activity'
     AND coalesce(current_setting('private.allow_record_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING errcode = '42501', message = 'IMMUTABLE_HISTORY';
END $$;

-- ============================================================
-- STEP 2: Shared guarded purge helper (returns the removed row for auditing)
-- ============================================================

CREATE FUNCTION private.purge_vehicle(p_id uuid) RETURNS public.vehicles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_vehicle public.vehicles;
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND';
  END IF;
  -- A vehicle that was ever sold (even a cancelled sale) keeps its full history.
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

-- ============================================================
-- STEP 3: Public RPCs — OWNER/MANAGER only, reason mandatory (3–1000)
-- ============================================================

CREATE FUNCTION public.delete_vehicle(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_old public.vehicles;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETION_REASON_REQUIRED';
  END IF;
  v_old := private.purge_vehicle(p_id);
  -- p_vehicle stays NULL: the activity trail was purged with the vehicle, and the
  -- immutable audit_logs row keeps the complete snapshot.
  PERFORM private.audit(
    'DELETE_VEHICLE', 'vehicles', p_id, to_jsonb(v_old),
    jsonb_build_object('reason', btrim(p_reason), 'deleted_by', v_actor, 'deleted_at', now()),
    NULL
  );
END $$;

CREATE FUNCTION public.delete_acquisition(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_acq public.acquisitions;
  v_vehicle public.vehicles;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETION_REASON_REQUIRED';
  END IF;
  SELECT * INTO v_acq FROM public.acquisitions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'ACQUISITION_NOT_FOUND';
  END IF;
  -- Purging the xe also removes this phiếu thu (and cascades its identity documents).
  v_vehicle := private.purge_vehicle(v_acq.vehicle_id);
  PERFORM private.audit(
    'DELETE_ACQUISITION', 'acquisitions', p_id, to_jsonb(v_acq),
    jsonb_build_object('reason', btrim(p_reason), 'deleted_by', v_actor, 'deleted_at', now(), 'vehicle', to_jsonb(v_vehicle)),
    NULL
  );
END $$;

-- ============================================================
-- STEP 4: Grants — helper stays owner-only; RPCs follow the 031 matrix
-- ============================================================

revoke all on function private.immutable_history() from public, anon, authenticated;
revoke all on function private.purge_vehicle(p_id uuid) from public, anon, authenticated;
revoke all on function public.delete_vehicle(p_id uuid, p_reason text) from public, anon, authenticated;
grant execute on function public.delete_vehicle(p_id uuid, p_reason text) to authenticated;
grant execute on function public.delete_vehicle(p_id uuid, p_reason text) to service_role;
revoke all on function public.delete_acquisition(p_id uuid, p_reason text) from public, anon, authenticated;
grant execute on function public.delete_acquisition(p_id uuid, p_reason text) to authenticated;
grant execute on function public.delete_acquisition(p_id uuid, p_reason text) to service_role;
