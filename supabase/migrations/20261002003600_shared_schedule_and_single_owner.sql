-- 036 · Shared staff working time, single OWNER, manager role-setting.
-- Forward-only migration:
--  1. Working hours move from per-profile columns to ONE shared schedule on
--     system_settings applied to every non-OWNER role (Quản lý + Nhân viên).
--     profiles.allowed_from / allowed_until / working_days become legacy:
--     they are no longer read by any authorization path.
--  2. Temporary usage bans are always bounded (disabled_until in the future).
--  3. The system keeps exactly one active OWNER; ownership changes through an
--     atomic transfer_ownership RPC that demotes the previous owner to MANAGER.
--  4. update_profile lets a MANAGER change the role of STAFF accounts only;
--     STAFF keeps the previous "own full_name only" rule.

-- ============================================================
-- STEP 1 · SHARED SCHEDULE COLUMNS ON system_settings
-- ============================================================

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS staff_allowed_from time NOT NULL DEFAULT '00:00:00',
  ADD COLUMN IF NOT EXISTS staff_allowed_until time NOT NULL DEFAULT '23:59:59',
  ADD COLUMN IF NOT EXISTS staff_working_days integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7];

COMMENT ON COLUMN public.system_settings.staff_allowed_from IS
  'Shared login window start for every non-OWNER role (Asia/Ho_Chi_Minh).';
COMMENT ON COLUMN public.system_settings.staff_allowed_until IS
  'Shared login window end for every non-OWNER role (Asia/Ho_Chi_Minh).';
COMMENT ON COLUMN public.system_settings.staff_working_days IS
  'Shared ISO weekdays (1=Mon..7=Sun) non-OWNER roles may work; empty = every day.';

-- ============================================================
-- STEP 2 · save_settings accepts the shared schedule (OWNER only)
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_settings(p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old jsonb; v_new jsonb;
  v_from time; v_until time; v_days integer[];
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;

  -- Validate the shared working-time fields before touching the row.
  IF p_data ? 'staff_allowed_from' AND nullif(btrim(coalesce(p_data->>'staff_allowed_from','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_from')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_from := (p_data->>'staff_allowed_from')::time;
  ELSIF p_data ? 'staff_allowed_from' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_allowed_until' AND nullif(btrim(coalesce(p_data->>'staff_allowed_until','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_until')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_until := (p_data->>'staff_allowed_until')::time;
  ELSIF p_data ? 'staff_allowed_until' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_working_days' THEN
    IF jsonb_typeof(p_data->'staff_working_days') <> 'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_data->'staff_working_days') e WHERE e !~ '^[1-7]$') THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (e)::int), ARRAY[]::integer[]) INTO v_days
      FROM jsonb_array_elements_text(p_data->'staff_working_days') e;
  END IF;

  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;
  UPDATE public.system_settings SET store_name=btrim(coalesce(p_data->>'store_name',store_name)),phone=btrim(coalesce(p_data->>'phone',phone)),
    address=btrim(coalesce(p_data->>'address',address)),low_stock_threshold=coalesce((p_data->>'low_stock_threshold')::integer,low_stock_threshold),
    high_stock_threshold=coalesce((p_data->>'high_stock_threshold')::integer,high_stock_threshold),
    customer_messaging_enabled=coalesce((p_data->>'customer_messaging_enabled')::boolean,customer_messaging_enabled),
    sale_thank_you_enabled=coalesce((p_data->>'sale_thank_you_enabled')::boolean,sale_thank_you_enabled),
    primary_message_channel=coalesce(p_data->>'primary_message_channel',primary_message_channel),
    fallback_channel=coalesce(p_data->>'fallback_channel',fallback_channel),support_phone=btrim(coalesce(p_data->>'support_phone',support_phone)),
    staff_allowed_from=coalesce(v_from,staff_allowed_from),
    staff_allowed_until=coalesce(v_until,staff_allowed_until),
    staff_working_days=coalesce(v_days,staff_working_days),
    updated_by=v_actor,updated_at=now() WHERE id RETURNING to_jsonb(system_settings) INTO v_new;
  PERFORM private.audit(
    CASE WHEN (v_old->>'staff_allowed_from') <> (v_new->>'staff_allowed_from')
           OR (v_old->>'staff_allowed_until') <> (v_new->>'staff_allowed_until')
           OR (v_old->'staff_working_days') <> (v_new->'staff_working_days')
      THEN 'STAFF_SCHEDULE_CHANGED' ELSE 'MESSAGE_SETTING_CHANGED' END,
    'system_settings',null,v_old,v_new);
END $function$;

-- ============================================================
-- STEP 3 · Authorization reads the SHARED schedule for non-OWNER
-- ============================================================

CREATE OR REPLACE FUNCTION private.is_user_authorized(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p public.profiles;
  v_sched public.system_settings;
  v_now timestamp := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_time time := v_now::time;
  v_dow integer := extract(isodow FROM v_now)::integer;
BEGIN
  IF p_user_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND OR NOT v_p.active OR v_p.deleted_at IS NOT NULL OR v_p.must_change_password THEN
    RETURN false;
  END IF;
  -- OWNER is exempt from the shared employee schedule.
  IF v_p.role = 'OWNER' THEN RETURN true; END IF;
  -- Bounded temporary ban (cấm sử dụng tạm thời).
  IF v_p.disabled_until IS NOT NULL AND v_p.disabled_until > now() THEN RETURN false; END IF;
  SELECT * INTO v_sched FROM public.system_settings WHERE id;
  IF NOT FOUND THEN RETURN true; END IF;
  IF NOT private.schedule_allows_time(v_sched.staff_allowed_from, v_sched.staff_allowed_until, v_time) THEN RETURN false; END IF;
  IF cardinality(v_sched.staff_working_days) > 0 AND NOT (v_dow = ANY(v_sched.staff_working_days)) THEN RETURN false; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION private.is_user_authorized(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_user_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.profiles;
  v_sched public.system_settings;
  v_now timestamp := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('allowed', false, 'code', 'UNAUTHENTICATED', 'message', 'Chưa đăng nhập.'); END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'code', 'PROFILE_NOT_FOUND', 'message', 'Không tìm thấy thông tin tài khoản.'); END IF;
  IF v_p.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('allowed', false, 'code', 'ACCOUNT_DELETED', 'message', 'Tài khoản đã bị xóa khỏi hệ thống.'); END IF;
  IF NOT v_p.active THEN RETURN jsonb_build_object('allowed', false, 'code', 'ACCOUNT_INACTIVE', 'message', 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ chủ cửa hàng.'); END IF;
  IF v_p.role <> 'OWNER' THEN
    IF v_p.disabled_until IS NOT NULL AND v_p.disabled_until > now() THEN
      RETURN jsonb_build_object('allowed', false, 'code', 'TEMP_LOCKED', 'message', 'Tài khoản đang bị cấm sử dụng tạm thời. Vui lòng liên hệ chủ cửa hàng.');
    END IF;
    SELECT * INTO v_sched FROM public.system_settings WHERE id;
    IF FOUND AND NOT private.schedule_allows_time(v_sched.staff_allowed_from, v_sched.staff_allowed_until, v_now::time) THEN
      RETURN jsonb_build_object('allowed', false, 'code', 'OUTSIDE_HOURS', 'message', 'Bạn đang đăng nhập ngoài khung giờ làm việc chung (' || to_char(v_sched.staff_allowed_from, 'HH24:MI') || ' - ' || to_char(v_sched.staff_allowed_until, 'HH24:MI') || ').');
    END IF;
    IF FOUND AND cardinality(v_sched.staff_working_days) > 0 AND NOT (extract(isodow FROM v_now)::integer = ANY(v_sched.staff_working_days)) THEN
      RETURN jsonb_build_object('allowed', false, 'code', 'OUTSIDE_DAYS', 'message', 'Hôm nay không phải ngày làm việc của cửa hàng.');
    END IF;
  END IF;
  RETURN jsonb_build_object('allowed', true, 'role', v_p.role, 'must_change_password', v_p.must_change_password);
END $$;
REVOKE ALL ON FUNCTION public.check_user_access() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_user_access() TO authenticated, service_role;

-- ============================================================
-- STEP 4 · update_profile: MANAGER junior-role rule + single OWNER
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_profile(p_id uuid, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_actor_role public.user_role := private.current_role();
  v_old public.profiles;
  v_new public.profiles;
  v_role public.user_role;
  v_active boolean;
  v_fin boolean;
  v_username text;
  v_disabled_until timestamptz;
  v_allowed_from time;
  v_allowed_until time;
  v_working_days integer[];
  v_must_change_pwd boolean;
  v_audit_action text;
BEGIN
  -- Advisory lock to prevent simultaneous demotions of last OWNER
  PERFORM pg_advisory_xact_lock(761482190);

  SELECT * INTO v_old FROM public.profiles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='PROFILE_NOT_FOUND'; END IF;

  IF v_actor_role = 'MANAGER' THEN
    -- A manager may ONLY change the role of STAFF accounts (their juniors).
    IF p_id = v_actor
      OR v_old.role <> 'STAFF'
      OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_data))
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k <> 'role')
      OR COALESCE(p_data->>'role','') NOT IN ('STAFF','MANAGER') THEN
      RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
    END IF;
  ELSIF v_actor_role <> 'OWNER' THEN
    -- STAFF can ONLY update their own full_name.
    IF p_id <> v_actor OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k NOT IN ('full_name')
    ) THEN
      RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
    END IF;
  END IF;

  v_role := COALESCE((p_data->>'role')::public.user_role, v_old.role);
  v_active := COALESCE((p_data->>'active')::boolean, v_old.active);
  v_fin := COALESCE((p_data->>'can_view_financials')::boolean, v_old.can_view_financials);
  v_username := lower(btrim(COALESCE(p_data->>'username', v_old.username)));
  v_must_change_pwd := COALESCE((p_data->>'must_change_password')::boolean, v_old.must_change_password);

  -- Handle disabled_until
  IF p_data ? 'disabled_until' THEN
    v_disabled_until := (p_data->>'disabled_until')::timestamptz;
  ELSE
    v_disabled_until := v_old.disabled_until;
  END IF;

  -- Legacy per-profile schedule fields (kept for history; enforcement is shared)
  IF p_data ? 'allowed_from' THEN
    v_allowed_from := (p_data->>'allowed_from')::time;
  ELSE
    v_allowed_from := v_old.allowed_from;
  END IF;

  IF p_data ? 'allowed_until' THEN
    v_allowed_until := (p_data->>'allowed_until')::time;
  ELSE
    v_allowed_until := v_old.allowed_until;
  END IF;

  IF p_data ? 'working_days' AND jsonb_typeof(p_data->'working_days') = 'array' THEN
    SELECT COALESCE(array_agg(elem::int), ARRAY[1,2,3,4,5,6,7])
    INTO v_working_days
    FROM jsonb_array_elements_text(p_data->'working_days') AS elem;
  ELSE
    v_working_days := v_old.working_days;
  END IF;

  -- Username change validations
  IF v_username <> v_old.username THEN
    IF v_actor_role <> 'OWNER' THEN RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED'; END IF;
    IF v_username !~ '^[a-z0-9_.]{3,30}$' THEN
      RAISE EXCEPTION USING errcode='22023', message='INVALID_USERNAME';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username AND id <> p_id) THEN
      RAISE EXCEPTION USING errcode='23505', message='USERNAME_EXISTS';
    END IF;
  END IF;

  -- The system keeps exactly one OWNER; changing who holds it goes through
  -- transfer_ownership (atomic handover), never through a raw role write.
  IF v_role = 'OWNER' AND v_old.role <> 'OWNER' AND EXISTS (
    SELECT 1 FROM public.profiles WHERE role = 'OWNER' AND active AND deleted_at IS NULL AND id <> p_id
  ) THEN
    RAISE EXCEPTION USING errcode='22023', message='SINGLE_OWNER_REQUIRED';
  END IF;

  -- Protect the last active OWNER
  IF v_old.role = 'OWNER' AND v_old.active AND (v_role <> 'OWNER' OR NOT v_active) AND NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE role = 'OWNER' AND active AND id <> p_id
  ) THEN
    RAISE EXCEPTION USING errcode='22023', message='LAST_OWNER_REQUIRED';
  END IF;

  UPDATE public.profiles SET
    full_name = btrim(COALESCE(p_data->>'full_name', full_name)),
    role = v_role,
    active = v_active,
    can_view_financials = v_fin,
    username = v_username,
    must_change_password = v_must_change_pwd,
    disabled_until = v_disabled_until,
    allowed_from = v_allowed_from,
    allowed_until = v_allowed_until,
    working_days = v_working_days,
    disable_reason = COALESCE(p_data->>'disable_reason', disable_reason),
    deleted_at = CASE
      WHEN p_data ? 'deleted_at' THEN (p_data->>'deleted_at')::timestamptz
      ELSE deleted_at
    END,
    updated_at = now()
  WHERE id = p_id RETURNING * INTO v_new;

  -- Audit specific action
  IF v_old.active AND NOT v_new.active THEN
    v_audit_action := 'DISABLE_USER';
  ELSIF NOT v_old.active AND v_new.active THEN
    v_audit_action := 'ENABLE_USER';
  ELSIF v_old.disabled_until IS NULL AND v_new.disabled_until > now() THEN
    v_audit_action := 'TEMP_BAN_USER';
  ELSIF v_old.disabled_until IS NOT NULL AND v_new.disabled_until IS NULL THEN
    v_audit_action := 'UNLOCK_USER';
  ELSIF v_old.role <> v_new.role THEN
    v_audit_action := 'CHANGE_USER_ROLE';
  ELSIF v_old.allowed_from <> v_new.allowed_from OR v_old.allowed_until <> v_new.allowed_until OR v_old.working_days <> v_new.working_days THEN
    v_audit_action := 'CHANGE_ACCESS_SCHEDULE';
  ELSIF NOT v_old.must_change_password AND v_new.must_change_password THEN
    v_audit_action := 'FORCE_PASSWORD_CHANGE';
  ELSE
    v_audit_action := 'UPDATE_USER';
  END IF;

  PERFORM private.audit(v_audit_action, 'profiles', p_id, to_jsonb(v_old), to_jsonb(v_new));
END $function$;

-- ============================================================
-- STEP 5 · Atomic ownership handover (single OWNER invariant)
-- ============================================================

CREATE OR REPLACE FUNCTION public.transfer_ownership(p_target_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_target public.profiles;
BEGIN
  PERFORM pg_advisory_xact_lock(761482190);
  IF p_target_user = v_actor THEN
    RAISE EXCEPTION USING errcode='22023', message='SELF_TRANSFER';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE id = p_target_user FOR UPDATE;
  IF NOT FOUND OR NOT v_target.active OR v_target.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='TARGET_NOT_ACTIVE';
  END IF;

  -- Promote first, then demote every previous owner to MANAGER, so the
  -- last-owner trigger never observes a zero-owner state. After the handover
  -- the system again holds exactly one active OWNER.
  UPDATE public.profiles SET role = 'OWNER', updated_at = now() WHERE id = p_target_user;
  UPDATE public.profiles SET role = 'MANAGER', updated_at = now()
    WHERE role = 'OWNER' AND id <> p_target_user;

  PERFORM private.audit('TRANSFER_OWNER', 'profiles', p_target_user,
    jsonb_build_object('previous_actor', v_actor), jsonb_build_object('new_owner', p_target_user));
END $function$;
REVOKE ALL ON FUNCTION public.transfer_ownership(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_ownership(uuid) TO authenticated, service_role;
