-- Migration: 20261017000200_push_instant_dispatch.sql
-- Description: Web Push tức thì — hàng vừa vào push_deliveries được gửi trong
--   vài giây thay vì chờ chu kỳ quét gần nhất (pg_cron 15 phút / self-drain).
--   * AFTER INSERT trên push_deliveries → một lời gọi pg_net (fire-and-forget)
--     thẳng tới Edge Function push-dispatch với Bearer sweep token.
--   * KHÔNG CÓ SECRET TRONG GIT: migration chỉ tạo bảng config RỖNG; URL +
--     Bearer (đúng PUSH_SWEEP_TOKEN mà cron sweeper đang dùng) do OWNER nạp
--     ngoài-band sau khi áp. Bảng trống = trigger im lặng no-op, cơ chế cũ
--     (cron + client self-drain) giữ nguyên, không mất gì.
--   * Chống bão HTTP: pg_try_advisory_xact_lock để MỘT transaction fan-out
--     (nhiều notification → nhiều hàng push) chỉ bắn đúng MỘT ping; dispatcher
--     tự claim lô tối đa 10 hàng, phần còn lại chu kỳ sau vét tiếp — hàng
--     không bao giờ mất vì hàng đợi vẫn là nguồn sự thật.
--   * Push không được phép làm gãy ghi nghiệp vụ: toàn bộ thân hàm bọc
--     exception; pg_net chưa cài (cluster PostgreSQL tạm cho test/replay) hoặc
--     chưa cấu hình → RETURN NEW tĩnh lặng.
--   * Khóa chặt y habitus push_subscriptions/push_user_settings: RLS bật,
--     REVOKE mọi role, không chính sách SELECT — chỉ hàm DEFINER dưới đây đọc
--     được (nó chạy với quyền chủ bảng, bỏ qua RLS).

-- ============================================================
-- STEP 1: Bảng cấu hình dispatch (một hàng duy nhất, mặc định trống)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.push_dispatch_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  url text NOT NULL CHECK (url ~ '^https://[^[:space:]]+$' AND char_length(url) <= 2000),
  -- Bearer sweep token — cùng giá trị với cron sweeper, chỉ đủ quyền "rút
  -- hàng đợi của hệ thống", không đọc/ghi được bất kỳ dữ liệu nghiệp vụ nào.
  token text NOT NULL CHECK (char_length(token) BETWEEN 16 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.push_dispatch_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_dispatch_config FROM public, anon, authenticated, service_role;

-- ============================================================
-- STEP 2: Trigger bắn ping tức thì (dedup theo transaction)
-- ============================================================

CREATE OR REPLACE FUNCTION private.dispatch_push_now() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_url text;
  v_token text;
  v_ns text;
BEGIN
  IF NEW.status <> 'QUEUED' THEN
    RETURN NEW;
  END IF;
  -- Một ping mỗi transaction: ai cầm được lock mới là người bắn; các hàng
  -- còn lại trong cùng lô dựa vào claim theo lô của dispatcher.
  IF NOT pg_try_advisory_xact_lock(64614017) THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT c.url, c.token INTO v_url, v_token
    FROM public.push_dispatch_config c
    WHERE c.id = 1;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW; -- bảng/cấp quyền bất thường: coi như chưa cấu hình
  END;
  IF v_url IS NULL OR v_token IS NULL THEN
    RETURN NEW; -- OWNER chưa nạp Bearer → cron 15 phút lo
  END IF;
  -- Định vị pg_net thật (lịch sử Supabase đặt ở schema net hoặc extensions);
  -- extension không tồn tại (DB test/replay sạch) → về im lặng, không nổ.
  SELECT n.nspname INTO v_ns
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'http_post' AND n.nspname IN ('net', 'extensions')
  LIMIT 1;
  IF v_ns IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT %I.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 5000)',
    v_ns,
    v_url,
    jsonb_build_object('Authorization', 'Bearer ' || v_token,
                       'Content-Type', 'application/json')::text,
    '{}'::text
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Mọi sự cố kênh push (net đầy, DNS, timeout...) đều vô hình với nghiệp vụ.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dispatch_push_after_enqueue ON public.push_deliveries;
CREATE TRIGGER dispatch_push_after_enqueue
  AFTER INSERT ON public.push_deliveries
  FOR EACH ROW EXECUTE FUNCTION private.dispatch_push_now();

-- ============================================================
-- STEP 3: Privileges — hàm trigger không ai gọi trực tiếp được.
-- ============================================================

REVOKE ALL ON FUNCTION private.dispatch_push_now() FROM public, anon, authenticated, service_role;
