-- Forward-only security repair. Supabase Auth remains the password authority.
-- The private fingerprint proves a required password actually changed; passwords
-- and their hashes are never returned to browser clients or copied into audit logs.

CREATE TABLE private.required_password_changes (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  password_fingerprint text,
  reset_pending boolean NOT NULL DEFAULT false,
  required_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.required_password_changes FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.track_required_password_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.must_change_password AND (TG_OP = 'INSERT' OR NOT OLD.must_change_password) THEN
    INSERT INTO private.required_password_changes(user_id, password_fingerprint)
    SELECT NEW.id, encode(sha256(convert_to(u.encrypted_password, 'UTF8')), 'hex')
    FROM auth.users u WHERE u.id = NEW.id
    ON CONFLICT (user_id) DO UPDATE SET
      password_fingerprint = EXCLUDED.password_fingerprint,
      required_at = now();
  ELSIF NOT NEW.must_change_password THEN
    DELETE FROM private.required_password_changes WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.track_required_password_change() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER track_required_password_change
AFTER INSERT OR UPDATE OF must_change_password ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.track_required_password_change();

INSERT INTO private.required_password_changes(user_id, password_fingerprint)
SELECT p.id, encode(sha256(convert_to(u.encrypted_password, 'UTF8')), 'hex')
FROM public.profiles p JOIN auth.users u ON u.id = p.id
WHERE p.must_change_password;

CREATE OR REPLACE FUNCTION public.complete_password_change() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_before text;
  v_current text;
  v_reset_pending boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'AUTH_REQUIRED';
  END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND OR NOT v_profile.active OR v_profile.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'ACCESS_DENIED';
  END IF;
  IF NOT v_profile.must_change_password THEN RETURN; END IF;
  SELECT password_fingerprint, reset_pending INTO v_before, v_reset_pending FROM private.required_password_changes
  WHERE user_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'PASSWORD_CHANGE_REQUIRED';
  END IF;
  SELECT encode(sha256(convert_to(encrypted_password, 'UTF8')), 'hex') INTO v_current
  FROM auth.users WHERE id = v_uid;
  IF v_reset_pending OR v_current IS NULL OR v_current IS NOT DISTINCT FROM v_before THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'PASSWORD_CHANGE_REQUIRED';
  END IF;
  UPDATE public.profiles SET must_change_password = false, updated_at = now() WHERE id = v_uid;
  PERFORM private.audit('COMPLETE_PASSWORD_CHANGE', 'profiles', v_uid,
    jsonb_build_object('must_change_password', true),
    jsonb_build_object('must_change_password', false));
END $$;
REVOKE ALL ON FUNCTION public.complete_password_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_password_change() TO authenticated;

-- Each administrative reset records a new baseline, including when an older
-- password change is still pending. Unrelated profile edits preserve that proof.
CREATE FUNCTION public.require_password_change(p_user_id uuid, p_reset_pending boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    UPDATE public.profiles SET must_change_password = true, updated_at = now() WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'PROFILE_NOT_FOUND'; END IF;
    PERFORM private.audit('FORCE_PASSWORD_CHANGE', 'profiles', p_user_id, NULL,
      jsonb_build_object('must_change_password', true));
  ELSE
    PERFORM private.require_role(ARRAY['OWNER']::public.user_role[]);
    PERFORM public.update_profile(p_user_id, jsonb_build_object('must_change_password', true));
  END IF;
  INSERT INTO private.required_password_changes(user_id, password_fingerprint, reset_pending)
  SELECT p_user_id, encode(sha256(convert_to(encrypted_password, 'UTF8')), 'hex'), p_reset_pending FROM auth.users WHERE id = p_user_id
  ON CONFLICT (user_id) DO UPDATE SET password_fingerprint = EXCLUDED.password_fingerprint, reset_pending = EXCLUDED.reset_pending, required_at = now();
END $$;
REVOKE ALL ON FUNCTION public.require_password_change(uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.require_password_change(uuid,boolean) TO authenticated, service_role;

CREATE FUNCTION private.schedule_allows_time(p_from time, p_until time, p_time time) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_from IS NULL OR p_until IS NULL THEN true
    WHEN p_from <= p_until THEN p_time BETWEEN p_from AND p_until
    ELSE p_time >= p_from OR p_time <= p_until END;
$$;
REVOKE ALL ON FUNCTION private.schedule_allows_time(time,time,time) FROM PUBLIC, anon, authenticated;

-- check_user_access continues to allow login to the password-change screen.
-- Every business RPC, table policy and Storage policy uses this stricter check.
CREATE OR REPLACE FUNCTION private.is_user_authorized(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p public.profiles;
  v_now timestamp := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_time time := v_now::time;
  v_dow integer := extract(isodow FROM v_now)::integer;
BEGIN
  IF p_user_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND OR NOT v_p.active OR v_p.deleted_at IS NOT NULL OR v_p.must_change_password THEN
    RETURN false;
  END IF;
  IF v_p.role = 'OWNER' THEN RETURN true; END IF;
  IF v_p.disabled_until IS NOT NULL AND v_p.disabled_until > now() THEN RETURN false; END IF;
  IF NOT private.schedule_allows_time(v_p.allowed_from, v_p.allowed_until, v_time) THEN RETURN false; END IF;
  IF v_p.working_days IS NOT NULL AND NOT (v_dow = ANY(v_p.working_days)) THEN RETURN false; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION private.is_user_authorized(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_user_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.profiles;
  v_now timestamp := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('allowed', false, 'code', 'UNAUTHENTICATED', 'message', 'Chưa đăng nhập.'); END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'code', 'PROFILE_NOT_FOUND', 'message', 'Không tìm thấy thông tin tài khoản.'); END IF;
  IF v_p.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('allowed', false, 'code', 'ACCOUNT_DELETED', 'message', 'Tài khoản đã bị vô hiệu hóa.'); END IF;
  IF NOT v_p.active THEN RETURN jsonb_build_object('allowed', false, 'code', 'ACCOUNT_INACTIVE', 'message', 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ chủ cửa hàng.'); END IF;
  IF v_p.role <> 'OWNER' THEN
    IF v_p.disabled_until IS NOT NULL AND v_p.disabled_until > now() THEN
      RETURN jsonb_build_object('allowed', false, 'code', 'TEMP_LOCKED', 'message', 'Tài khoản đang bị khóa tạm thời. Vui lòng liên hệ chủ cửa hàng.');
    END IF;
    IF NOT private.schedule_allows_time(v_p.allowed_from, v_p.allowed_until, v_now::time) THEN
      RETURN jsonb_build_object('allowed', false, 'code', 'OUTSIDE_HOURS', 'message', 'Bạn đang đăng nhập ngoài khung giờ được cho phép.');
    END IF;
    IF v_p.working_days IS NOT NULL AND NOT (extract(isodow FROM v_now)::integer = ANY(v_p.working_days)) THEN
      RETURN jsonb_build_object('allowed', false, 'code', 'OUTSIDE_DAYS', 'message', 'Hôm nay không phải ngày làm việc được phân công.');
    END IF;
  END IF;
  RETURN jsonb_build_object('allowed', true, 'role', v_p.role, 'must_change_password', v_p.must_change_password);
END $$;
REVOKE ALL ON FUNCTION public.check_user_access() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_user_access() TO authenticated;

-- A soft deletion must not bypass update_profile's last-owner protection.
CREATE FUNCTION private.protect_last_usable_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_before text;
  v_current text;
  v_reset_pending boolean;
BEGIN
  IF OLD.must_change_password AND NOT NEW.must_change_password THEN
    SELECT password_fingerprint, reset_pending INTO v_before, v_reset_pending FROM private.required_password_changes WHERE user_id = OLD.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'PASSWORD_CHANGE_REQUIRED';
    END IF;
    SELECT encode(sha256(convert_to(encrypted_password, 'UTF8')), 'hex') INTO v_current
    FROM auth.users WHERE id = OLD.id;
    IF v_reset_pending OR v_current IS NULL OR v_current IS NOT DISTINCT FROM v_before THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'PASSWORD_CHANGE_REQUIRED';
    END IF;
  END IF;
  IF OLD.role = 'OWNER' AND OLD.active AND OLD.deleted_at IS NULL
    AND (NEW.role <> 'OWNER' OR NOT NEW.active OR NEW.deleted_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(761482190);
    IF NOT EXISTS (SELECT 1 FROM public.profiles
      WHERE id <> OLD.id AND role = 'OWNER' AND active AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'LAST_OWNER_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.protect_last_usable_owner() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER protect_last_usable_owner BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.protect_last_usable_owner();

-- Acquisitions carry purchase cost. Operational users use the masked list RPC.
DROP POLICY IF EXISTS acquisitions_read ON public.acquisitions;
CREATE POLICY acquisitions_read ON public.acquisitions FOR SELECT TO authenticated
USING (private.can_financials());

-- A definer view exposed all staff activity and financial revenue. Invoker
-- semantics and the explicit owner predicate now enforce both access boundaries.
-- Correlated aggregates avoid multiplication between independent business rows.
CREATE OR REPLACE VIEW public.user_performance_summary
WITH (security_invoker = true, security_barrier = true) AS
SELECT p.id AS user_id, p.username, p.full_name, p.role, p.active,
  p.created_at AS account_created_at,
  (SELECT count(*) FROM public.acquisitions a WHERE a.created_by = p.id) AS vehicles_acquired_count,
  (SELECT count(*) FROM public.sales s WHERE s.sold_by = p.id AND s.status = 'COMPLETED') AS vehicles_sold_count,
  (SELECT coalesce(sum(s.sale_price), 0) FROM public.sales s
    WHERE s.sold_by = p.id AND s.status = 'COMPLETED') AS total_sales_revenue,
  (SELECT count(*) FROM public.vehicle_expenses ve
    WHERE ve.created_by = p.id AND ve.status = 'ACTIVE') AS vehicle_expenses_count,
  (SELECT count(*) FROM public.payments pay
    WHERE pay.created_by = p.id AND pay.status = 'ACTIVE') AS payments_recorded_count,
  (SELECT max(al.created_at) FROM public.audit_logs al WHERE al.user_id = p.id) AS last_activity_at
FROM public.profiles p WHERE private.current_role() = 'OWNER';
REVOKE ALL ON public.user_performance_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_performance_summary TO authenticated;

-- Remove leftover legacy account deletion helpers with no authorization checks.
DROP FUNCTION IF EXISTS private.delete_auth_user(uuid);
DROP FUNCTION IF EXISTS private.cleanup_deleted_accounts();
