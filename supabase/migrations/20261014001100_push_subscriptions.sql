-- Migration: 20261014001100_push_subscriptions.sql
-- Description: Web Push hạ tầng thiết bị (forward-only, không đụng luồng bell hiện có).
--   * public.push_subscriptions — một hàng cho mỗi thiết bị/trình duyệt đã subscribe
--     Web Push của một nhân viên. endpoint + khóa p256dh/auth là BÌ MẬT bearer
--     (ai cầm chúng = gửi được push vào máy đó): bảng REVOKE toàn bộ khỏi
--     anon/authenticated, không policy SELECT — chủ thiết bị chỉ thao tác được
--     qua các RPC SECURITY DEFINER dưới đây, và list_my_push_devices cố ý
--     KHÔNG trả endpoint/keys về client (client đã biết sẵn thiết bị của mình,
--     device_hint chỉ để hiển thị phân biệt).
--   * public.push_user_settings — công tắc "tắt mọi push" của từng người,
--     tách khỏi profiles để không mở rộng mặt leakage của các RPC đọc profile.
--     Thiếu hàng = BẬT (mặc thân thiện); tắt ghi rõ bằng RPC.
--   * register_push_subscription idempotent theo endpoint: cùng endpoint đăng
--     ký lại (đổi tài khoản trên một máy) chuyển quyền sở hữu — endpoint là
--     duy nhất toàn bảng — và giới hạn 20 thiết bị/người chống rác dữ liệu.
-- Không có đường nào cho client tự ghi bảng; service_role (Edge Function
-- push-dispatch) chỉ đụng các RPC service ở migration kế tiếp.

-- ============================================================
-- STEP 1: Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS public.push_user_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Push endpoint luôn là https:// (FCM, WNS, APNs, Mozilla Push, …).
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https://[^[:space:]]+$' AND char_length(endpoint) <= 2000),
  -- Khóa ECDH P-256 công khai (65 byte → base64url ~86–88 ký tự) và secret 16 byte.
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{40,128}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{8,32}$'),
  device_label text CHECK (device_label IS NULL OR char_length(device_label) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user
  ON public.push_subscriptions (user_id);

-- ============================================================
-- STEP 2: RLS + lockdown — một hàng chỉ thuộc về đúng một người,
-- và người đó chỉ đi qua RPC (không có chính sách SELECT trực tiếp).
-- ============================================================

ALTER TABLE public.push_user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.push_user_settings FROM public, anon, authenticated;
REVOKE ALL ON public.push_subscriptions FROM public, anon, authenticated;

-- ============================================================
-- STEP 3: RPC phía người dùng (SECURITY DEFINER, scoped auth.uid())
-- ============================================================

-- Đăng ký / cập nhật thiết bị của chính mình. Upsert theo endpoint:
-- endpoint đã thuộc người khác bị xoá trước (chuyển quyền sở hữu khi đổi
-- tài khoản trên cùng trình duyệt). Vượt trần 20 thiết bị: thu dọn thiết bị
-- ít dùng nhất trước khi chèn mới — không bao giờ từ chối đăng ký thiết bị
-- hiện tại của người đang thao tác.
CREATE OR REPLACE FUNCTION public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_label text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_id public.push_subscriptions.id%TYPE;
  v_count integer;
BEGIN
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://[^[:space:]]+$' OR char_length(p_endpoint) > 2000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_ENDPOINT';
  END IF;
  IF p_p256dh IS NULL OR p_p256dh !~ '^[A-Za-z0-9_-]{40,128}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_KEY';
  END IF;
  IF p_auth IS NULL OR p_auth !~ '^[A-Za-z0-9_-]{8,32}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_KEY';
  END IF;

  DELETE FROM public.push_subscriptions
  WHERE endpoint = p_endpoint AND user_id <> v_actor;

  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, device_label, last_used_at)
  VALUES (
    v_actor, p_endpoint, p_p256dh, p_auth,
    left(nullif(btrim(coalesce(p_label, '')), ''), 200), now()
  )
  ON CONFLICT (endpoint) DO UPDATE
  SET p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      device_label = coalesce(EXCLUDED.device_label, public.push_subscriptions.device_label),
      last_used_at = now()
  RETURNING id INTO v_id;

  SELECT count(*) INTO v_count FROM public.push_subscriptions WHERE user_id = v_actor;
  IF v_count > 20 THEN
    DELETE FROM public.push_subscriptions
    WHERE id IN (
      SELECT s.id FROM public.push_subscriptions s
      WHERE s.user_id = v_actor AND s.id <> v_id
      ORDER BY s.last_used_at ASC, s.created_at ASC
      LIMIT v_count - 20
    );
  END IF;

  RETURN v_id;
END $$;

-- Thu hồi thiết bị — chỉ hàng của chính mình; không trả thông tin gì thêm.
CREATE OR REPLACE FUNCTION public.unregister_push_subscription(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_count integer;
BEGIN
  DELETE FROM public.push_subscriptions WHERE id = p_id AND user_id = v_actor;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END $$;

-- Danh sách thiết bị đã đăng ký của chính người dùng. TUYỆT đối không trả
-- endpoint/keys — device_hint là md5 6 ký tự đầu, chỉ đủ để người dùng phân
-- biệt "máy nào là máy nào" trên màn hình Cài đặt.
CREATE OR REPLACE FUNCTION public.list_my_push_devices()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id,
      'device_label', s.device_label,
      'device_hint', left(md5(s.endpoint), 6),
      'created_at', s.created_at,
      'last_used_at', s.last_used_at
    ) ORDER BY s.last_used_at DESC)
    FROM public.push_subscriptions s
    WHERE s.user_id = v_actor
  ), '[]'::jsonb);
END $$;

-- Bật/tắt mọi thông báo đẩy của một người (không xoá subscription thiết bị).
CREATE OR REPLACE FUNCTION public.set_push_enabled(p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  INSERT INTO public.push_user_settings (user_id, enabled, updated_at)
  VALUES (v_actor, p_enabled, now())
  ON CONFLICT (user_id) DO UPDATE
  SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;
END $$;

-- Trạng thái công tắc của chính người dùng (thiếu hàng = bật).
CREATE OR REPLACE FUNCTION public.get_push_enabled()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
BEGIN
  RETURN coalesce(
    (SELECT s.enabled FROM public.push_user_settings s WHERE s.user_id = v_actor),
    true
  );
END $$;

-- ============================================================
-- STEP 4: Privileges — mọi đường user-facing đóng gói trong RPC.
-- ============================================================

REVOKE ALL ON FUNCTION public.register_push_subscription(text, text, text, text),
  public.unregister_push_subscription(uuid), public.list_my_push_devices(),
  public.set_push_enabled(boolean), public.get_push_enabled()
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.register_push_subscription(text, text, text, text),
  public.unregister_push_subscription(uuid), public.list_my_push_devices(),
  public.set_push_enabled(boolean), public.get_push_enabled()
  TO authenticated;
