-- Migration: 20260930002200_auth_recovery_and_account_control.sql
-- Description: Auth Recovery & Account Control Refactor
-- 1. Restores OWNER real email in auth.users matching auth.identities
-- 2. Removes unsafe password_reset_requests and direct auth.users mutation SQL
-- 3. Restores strict RLS on public.profiles (no direct client mutations)
-- 4. Centralizes schedule authorization with business timezone (Asia/Ho_Chi_Minh)
-- 5. Implements business-safe account deactivation & conditional unused account hard-delete check
-- 6. Adds derived user performance summary view for future analytics
-- 7. Fixes performance index vehicles_frame_number

-- ============================================================
-- STEP 1: RESTORE OWNER REAL EMAIL FROM AUTH.IDENTITIES
-- ============================================================

DO $$
DECLARE
  v_has_identities boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'auth' AND table_name = 'identities'
  ) INTO v_has_identities;
  
  IF v_has_identities THEN
    EXECUTE $sql$
      UPDATE auth.users u
      SET email = (
        SELECT (i.identity_data->>'email')::text
        FROM auth.identities i
        WHERE i.user_id = u.id AND i.provider = 'email'
        LIMIT 1
      ),
      email_confirmed_at = COALESCE(email_confirmed_at, now()),
      updated_at = now()
      WHERE u.id IN (
        SELECT id FROM public.profiles WHERE role = 'OWNER'
      )
      AND u.email LIKE '%@internal.xecrm.app'
      AND EXISTS (
        SELECT 1 FROM auth.identities i
        WHERE i.user_id = u.id AND i.provider = 'email' AND i.identity_data->>'email' IS NOT NULL
      );
    $sql$;
  END IF;
END $$;

-- Ensure OWNER profile is active and has no schedule/date/lock restrictions
UPDATE public.profiles
SET active = true,
    disabled_until = NULL,
    allowed_from = '00:00:00',
    allowed_until = '23:59:59',
    working_days = ARRAY[1,2,3,4,5,6,7],
    deleted_at = NULL,
    disable_reason = NULL
WHERE role = 'OWNER';

-- ============================================================
-- STEP 2: REMOVE UNSAFE TABLES, VIEWS AND DIRECT AUTH FUNCTIONS
-- ============================================================

-- Drop unsafe table storing plaintext passwords
DROP TABLE IF EXISTS private.password_reset_requests CASCADE;

-- Drop unsafe functions directly manipulating auth.users passwords / emails
DROP FUNCTION IF EXISTS private.reset_password_direct(UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS private.process_password_reset() CASCADE;
DROP FUNCTION IF EXISTS private.sync_auth_email(UUID) CASCADE;
DROP VIEW IF EXISTS private.user_credentials CASCADE;

-- ============================================================
-- STEP 3: STRICT RLS ON PUBLIC.PROFILES (REVOKE CLIENT MUTATIONS)
-- ============================================================

-- Drop insecure update/delete policies that allowed self-escalation
DROP POLICY IF EXISTS profiles_update ON public.profiles;
DROP POLICY IF EXISTS profiles_delete ON public.profiles;

-- Ensure RLS is active
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Revoke all client mutations on profiles. All updates go through update_profile RPC or Edge Function
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated, anon, public;
GRANT SELECT ON public.profiles TO authenticated;

-- Ensure read policy allows users to read own profile or OWNER to read all
DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR private.current_role() = 'OWNER');

-- ============================================================
-- STEP 4: TIMEZONE & SERVER-SIDE AUTHORIZATION FUNCTIONS
-- ============================================================

-- Ensure time and day calculations use business timezone: Asia/Ho_Chi_Minh
CREATE OR REPLACE FUNCTION private.is_user_authorized(p_user_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_p public.profiles;
  v_now timestamptz := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_time time := v_now::time;
  v_dow int := extract(isodow from v_now)::int; -- 1=Monday, 7=Sunday
BEGIN
  IF p_user_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  
  -- Soft deleted accounts are denied
  IF v_p.deleted_at IS NOT NULL THEN RETURN false; END IF;
  
  -- Inactive accounts are denied
  IF NOT v_p.active THEN RETURN false; END IF;
  
  -- OWNER is exempt from employee scheduling restrictions
  IF v_p.role = 'OWNER' THEN RETURN true; END IF;
  
  -- Temporary lock check
  IF v_p.disabled_until IS NOT NULL AND v_p.disabled_until > now() THEN RETURN false; END IF;
  
  -- Working hours check
  IF v_p.allowed_from IS NOT NULL AND v_p.allowed_until IS NOT NULL THEN
    IF v_time < v_p.allowed_from OR v_time > v_p.allowed_until THEN
      RETURN false;
    END IF;
  END IF;
  
  -- Working days check
  IF v_p.working_days IS NOT NULL AND cardinality(v_p.working_days) > 0 THEN
    IF NOT (v_dow = ANY(v_p.working_days)) THEN
      RETURN false;
    END IF;
  END IF;
  
  RETURN true;
END $$;

-- Update private.is_active() to check full authorization (active + schedule)
CREATE OR REPLACE FUNCTION private.is_active() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT private.is_user_authorized(auth.uid());
$$;

-- Update private.current_role() to return role only if user is authorized right now
CREATE OR REPLACE FUNCTION private.current_role() RETURNS public.user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() AND private.is_user_authorized(auth.uid());
$$;

-- Update private.can_user_login() with explicit timezone and OWNER exemption
CREATE OR REPLACE FUNCTION private.can_user_login() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT private.is_user_authorized(auth.uid());
$$;

-- ============================================================
-- STEP 5: APPLICATION HELPER RPCS
-- ============================================================

-- Detailed access evaluation RPC for UI feedback with friendly Vietnamese messages
CREATE OR REPLACE FUNCTION public.check_user_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.profiles;
  v_now timestamptz := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_time time := v_now::time;
  v_dow int := extract(isodow from v_now)::int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'UNAUTHENTICATED', 'message', 'Chưa đăng nhập.');
  END IF;
  
  SELECT * INTO v_p FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'PROFILE_NOT_FOUND', 'message', 'Không tìm thấy thông tin tài khoản.');
  END IF;
  
  IF v_p.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'ACCOUNT_DELETED', 'message', 'Tài khoản đã bị xóa khỏi hệ thống.');
  END IF;
  
  IF NOT v_p.active THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'ACCOUNT_INACTIVE', 'message', 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ chủ cửa hàng.');
  END IF;
  
  IF v_p.role = 'OWNER' THEN
    RETURN jsonb_build_object('allowed', true, 'role', 'OWNER', 'must_change_password', v_p.must_change_password);
  END IF;
  
  IF v_p.disabled_until IS NOT NULL AND v_p.disabled_until > now() THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'TEMP_LOCKED',
      'message', 'Tài khoản đang bị khóa tạm thời đến ' || to_char(v_p.disabled_until AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') || '.'
    );
  END IF;
  
  IF v_p.allowed_from IS NOT NULL AND v_p.allowed_until IS NOT NULL THEN
    IF v_time < v_p.allowed_from OR v_time > v_p.allowed_until THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'code', 'OUTSIDE_HOURS',
        'message', 'Bạn đang đăng nhập ngoài khung giờ được cho phép (' || to_char(v_p.allowed_from, 'HH24:MI') || ' - ' || to_char(v_p.allowed_until, 'HH24:MI') || ').'
      );
    END IF;
  END IF;
  
  IF v_p.working_days IS NOT NULL AND cardinality(v_p.working_days) > 0 THEN
    IF NOT (v_dow = ANY(v_p.working_days)) THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'code', 'OUTSIDE_DAYS',
        'message', 'Hôm nay không phải ngày làm việc được phân công.'
      );
    END IF;
  END IF;
  
  RETURN jsonb_build_object('allowed', true, 'role', v_p.role, 'must_change_password', v_p.must_change_password);
END $$;
GRANT EXECUTE ON FUNCTION public.check_user_access() TO authenticated;

-- RPC for self-completing password change (clears must_change_password without direct table writes)
CREATE OR REPLACE FUNCTION public.complete_password_change() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'AUTH_REQUIRED';
  END IF;
  UPDATE public.profiles
  SET must_change_password = false, updated_at = now()
  WHERE id = auth.uid();
END $$;
GRANT EXECUTE ON FUNCTION public.complete_password_change() TO authenticated;

-- Secure username resolution RPC for Login UI
-- Resolves username to auth email so owner can use email or username, and staff use username
CREATE OR REPLACE FUNCTION public.resolve_login_email(p_identifier TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_clean text := lower(btrim(p_identifier));
  v_email text;
BEGIN
  IF v_clean IS NULL OR v_clean = '' THEN RETURN ''; END IF;
  
  -- If it already contains '@', treat as direct email
  IF position('@' in v_clean) > 0 THEN
    RETURN v_clean;
  END IF;
  
  -- Look up profile by username
  SELECT u.email INTO v_email
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE lower(p.username) = v_clean
    AND p.deleted_at IS NULL
  LIMIT 1;
  
  IF v_email IS NOT NULL AND v_email <> '' THEN
    RETURN v_email;
  END IF;
  
  -- Fallback to standard internal alias
  RETURN v_clean || '@internal.xecrm.app';
END $$;
GRANT EXECUTE ON FUNCTION public.resolve_login_email(TEXT) TO anon, authenticated;

-- ============================================================
-- STEP 6: SAFE AUTH TRIGGER (NO DIRECT AUTH.USERS MUTATION)
-- ============================================================

CREATE OR REPLACE FUNCTION private.new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_username text;
BEGIN
  -- Extract username from metadata if provided, otherwise from email or fallback
  v_username := lower(btrim(coalesce(
    new.raw_user_meta_data->>'username',
    regexp_replace(new.email, '@.*$', '', 'g'),
    'user_' || substr(new.id::text, 1, 8)
  )));
  
  v_username := regexp_replace(v_username, '[^a-z0-9_.]', '_', 'g');
  IF length(v_username) < 3 THEN
    v_username := v_username || '_' || substr(new.id::text, 1, 4);
  END IF;
  IF length(v_username) > 30 THEN
    v_username := substr(v_username, 1, 30);
  END IF;
  
  -- Ensure username uniqueness
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username AND id <> new.id) LOOP
    v_username := substr(v_username, 1, 25) || substr(md5(random()::text), 1, 4);
  END LOOP;
  
  INSERT INTO public.profiles(
    id, full_name, role, active, username, must_change_password,
    disabled_until, allowed_from, allowed_until, working_days, deleted_at, disable_reason
  ) VALUES (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''), 'Người dùng mới'), 120),
    'VIEWER',
    false, -- Non-owner provisioning is inactive by default
    v_username,
    false,
    NULL, '00:00:00', '23:59:59', ARRAY[1,2,3,4,5,6,7], NULL, NULL
  ) ON CONFLICT (id) DO NOTHING;
  
  RETURN new;
END $$;

-- ============================================================
-- STEP 7: COMPREHENSIVE UPDATE_PROFILE RPC (OWNER ONLY FOR CONTROLS)
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_profile(p_id UUID, p_data JSONb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
  
  -- Non-owners can ONLY update their own full_name
  IF v_actor_role <> 'OWNER' THEN
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
  
  -- Handle allowed_from and allowed_until
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
  
  -- Handle working_days
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
    v_audit_action := 'TEMP_LOCK_USER';
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
END $$;

-- ============================================================
-- STEP 8: BUSINESS INTEGRITY CHECK FOR HARD DELETE
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_user_can_hard_delete(p_user_id UUID) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_caller uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_target public.profiles;
  v_has_acq boolean;
  v_has_veh boolean;
  v_has_sales boolean;
  v_has_payments boolean;
  v_has_vexp boolean;
  v_has_bexp boolean;
  v_has_audit boolean;
BEGIN
  SELECT * INTO v_target FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  END IF;
  
  IF v_target.role = 'OWNER' THEN
    RETURN jsonb_build_object('can_delete', false, 'reason', 'CANNOT_DELETE_OWNER', 'message', 'Không thể xóa tài khoản Chủ cửa hàng.');
  END IF;
  
  SELECT EXISTS(SELECT 1 FROM public.acquisitions WHERE created_by = p_user_id) INTO v_has_acq;
  SELECT EXISTS(SELECT 1 FROM public.vehicles WHERE created_by = p_user_id) INTO v_has_veh;
  SELECT EXISTS(SELECT 1 FROM public.sales WHERE sold_by = p_user_id) INTO v_has_sales;
  SELECT EXISTS(SELECT 1 FROM public.payments WHERE created_by = p_user_id) INTO v_has_payments;
  SELECT EXISTS(SELECT 1 FROM public.vehicle_expenses WHERE created_by = p_user_id) INTO v_has_vexp;
  SELECT EXISTS(SELECT 1 FROM public.business_expenses WHERE created_by = p_user_id) INTO v_has_bexp;
  SELECT EXISTS(SELECT 1 FROM public.audit_logs WHERE user_id = p_user_id) INTO v_has_audit;
  
  IF v_has_acq OR v_has_veh OR v_has_sales OR v_has_payments OR v_has_vexp OR v_has_bexp OR v_has_audit THEN
    RETURN jsonb_build_object(
      'can_delete', false,
      'reason', 'USER_HAS_BUSINESS_HISTORY',
      'message', 'Tài khoản này đã tham gia vào các hoạt động kinh doanh (nhập xe, bán xe, chi phí, thanh toán hoặc nhật ký). Chỉ có thể vô hiệu hóa tài khoản để bảo toàn tính toàn vẹn dữ liệu.'
    );
  END IF;
  
  RETURN jsonb_build_object('can_delete', true);
END $$;
GRANT EXECUTE ON FUNCTION public.check_user_can_hard_delete(UUID) TO authenticated;

-- ============================================================
-- STEP 9: FUTURE EMPLOYEE PERFORMANCE SUMMARY (DERIVED VIEW)
-- ============================================================

CREATE OR REPLACE VIEW public.user_performance_summary AS
SELECT
  p.id AS user_id,
  p.username,
  p.full_name,
  p.role,
  p.active,
  p.created_at AS account_created_at,
  COUNT(DISTINCT a.id) AS vehicles_acquired_count,
  COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'COMPLETED') AS vehicles_sold_count,
  COALESCE(SUM(s.sale_price) FILTER (WHERE s.status = 'COMPLETED'), 0) AS total_sales_revenue,
  COUNT(DISTINCT ve.id) FILTER (WHERE ve.status = 'ACTIVE') AS vehicle_expenses_count,
  COUNT(DISTINCT pay.id) FILTER (WHERE pay.status = 'ACTIVE') AS payments_recorded_count,
  MAX(al.created_at) AS last_activity_at
FROM public.profiles p
LEFT JOIN public.acquisitions a ON a.created_by = p.id
LEFT JOIN public.sales s ON s.sold_by = p.id
LEFT JOIN public.vehicle_expenses ve ON ve.created_by = p.id
LEFT JOIN public.payments pay ON pay.created_by = p.id
LEFT JOIN public.audit_logs al ON al.user_id = p.id
GROUP BY p.id, p.username, p.full_name, p.role, p.active, p.created_at;

REVOKE ALL ON public.user_performance_summary FROM public, anon, authenticated;
GRANT SELECT ON public.user_performance_summary TO authenticated;

-- ============================================================
-- STEP 10: ENSURE EXPECTED PERFORMANCE INDEXES EXIST
-- ============================================================

CREATE INDEX IF NOT EXISTS vehicles_frame_number ON public.vehicles(frame_number);

-- ============================================================
-- STEP 11: SAFE SAVE_VEHICLE WITH FRAME_NUMBER FALLBACK
-- ============================================================

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

  v_frame := COALESCE(NULLIF(btrim(p_data->>'frame_number'), ''), 'GEN-' || substr(gen_random_uuid()::text, 1, 12));

  IF p_id IS NULL THEN
    INSERT INTO public.vehicles(
      license_plate, brand, model, variant, year, color, frame_number, engine_number,
      odometer, purchase_date, asking_price, status, supplier_name, supplier_phone, notes, created_by
    ) VALUES (
      btrim(COALESCE(p_data->>'license_plate', '')), btrim(p_data->>'brand'), btrim(p_data->>'model'), btrim(COALESCE(p_data->>'variant', '')),
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
      frame_number = COALESCE(NULLIF(btrim(p_data->>'frame_number'), ''), frame_number),
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

    IF v_purchase IS DISTINCT FROM v_old_purchase THEN
      UPDATE public.vehicle_financials SET purchase_price = v_purchase, updated_by = v_actor, updated_at = now() WHERE vehicle_id = p_id;
    END IF;
    PERFORM private.audit('UPDATE_VEHICLE', 'vehicles', p_id, v_old_json, to_jsonb(v_new) || jsonb_build_object('purchase_price', v_purchase), p_id);
  END IF;
  RETURN v_new.id;
END $$;
