-- Migration: 20261014001200_push_delivery_queue.sql
-- Description: Hàng đợi giao Web Push (transactional outbox) nối chuông hiện có
--   với Edge Function `push-dispatch`.
--   * AFTER INSERT trên public.notifications → một hàng push_deliveries cho
--     người nhận nếu (1) họ còn thiết bị đăng ký và (2) công tắc cá nhân BẬT.
--     Nội dung push lấy THẲNG từ dòng notifications — vốn đã được
--     notify_from_audit gate tiền theo từng người nhận — nên không tồn tại
--     đường thứ hai rò rỉ giá OWNER-private ra màn hình khóa.
--   * notification_id FK ON DELETE CASCADE: dedup cùng-transaction của
--     notify_from_audit (CREATE_PAYMENT nằm trong CREATE_SALE, VOID_PAYMENT
--     trong CANCEL_SALE) xoá dòng notification → hàng push chết theo trước
--     khi dispatcher kịp thấy. Idempotency: UNIQUE(notification_id).
--   * claim/complete/forget CHỈ service_role thực thi (REVOKE khỏi
--     authenticated). Endpoint + khóa mã hoá vì thế không bao giờ đi về
--     phía browser — chúng chỉ luân chuyển Edge Function ↔ DB.
--   * Lease 2 phút tự thu hồi khi dispatcher chết giữa chừng; retry có trần
--     5 lần, backoff luỹ thừa cap 1 giờ — không retry vô hạn, không trùng.
--   * Retention: hàng DONE/FAILED/SKIPPED sau 30 ngày dọn ngay trong claim
--     kế tiếp; hàng của người tắt công tắc / bị vô hiệu hoá → SKIPPED.

-- ============================================================
-- STEP 1: Queue table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'NOTIFICATION' CHECK (kind IN ('NOTIFICATION','TEST')),
  -- NOTIFICATION: bắt buộc, cascade theo bell row. TEST: NULL — tin thử do
  -- chính người dùng bắn vào thiết bị mình, KHÔNG ghi vào kho notifications.
  notification_id uuid REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','CLAIMED','DONE','FAILED','SKIPPED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text CHECK (claimed_by IS NULL OR char_length(claimed_by) <= 100),
  claimed_at timestamptz,
  -- Mã lỗi ngắn, phi ngữ cảnh (vd 'GONE_410', 'PROVIDER_503') — không payload,
  -- không endpoint, không PII.
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS push_deliveries_notification
  ON public.push_deliveries (notification_id) WHERE notification_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS push_deliveries_claimable
  ON public.push_deliveries (available_at, created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS push_deliveries_stale_claim
  ON public.push_deliveries (claimed_at) WHERE status = 'CLAIMED';
CREATE INDEX IF NOT EXISTS push_deliveries_retention
  ON public.push_deliveries (completed_at) WHERE status IN ('DONE','FAILED','SKIPPED');

ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_deliveries FROM public, anon, authenticated;

-- ============================================================
-- STEP 2: Enqueue — móc vào INSERT của bảng notifications.
-- Không gọi private.audit bên trong (chống re-entry như quy ước của
-- notify_from_audit); chỉ hai lookup có index trên hot path.
-- ============================================================

CREATE OR REPLACE FUNCTION private.enqueue_push_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = NEW.user_id)
     AND coalesce(
           (SELECT t.enabled FROM public.push_user_settings t WHERE t.user_id = NEW.user_id),
           true
         )
  THEN
    INSERT INTO public.push_deliveries (kind, notification_id, user_id)
    VALUES ('NOTIFICATION', NEW.id, NEW.user_id)
    -- arbiter phải khớp chỉ mục UNIQUE bộ (partial) ở STEP 1.
    ON CONFLICT (notification_id) WHERE notification_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enqueue_push_after_notification ON public.notifications;
CREATE TRIGGER enqueue_push_after_notification
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION private.enqueue_push_delivery();

-- ============================================================
-- STEP 3: Dispatcher RPCs — service_role ONLY.
-- ============================================================

-- Claim một lô việc: thu hồi lease chết, dọn retention, bỏ qua hàng của người
-- đã tắt công tắc/tài khoản, rồi gán CLAIMED (FOR UPDATE SKIP LOCKED — hai
-- dispatcher concurrent không bao giờ lấy trùng hàng) và trả kèm nội dung đã
-- gate + danh sách subscription của từng người.
CREATE OR REPLACE FUNCTION public.claim_push_deliveries(
  p_worker text,
  p_limit integer DEFAULT 20,
  p_user uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := least(50, greatest(1, coalesce(p_limit, 20)));
  v_rows jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'SERVICE_ONLY';
  END IF;
  IF p_worker IS NULL OR btrim(p_worker) = '' OR char_length(p_worker) > 100 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_WORKER';
  END IF;

  -- 1) Dispatcher chết giữa chừng: lease quá hạn → đếm thêm một lần thử,
  --    quá trần thì FAILED vĩnh viễn (có completed_at cho retention).
  UPDATE public.push_deliveries d
  SET attempts = d.attempts + 1,
      status = CASE WHEN d.attempts + 1 >= 5 THEN 'FAILED' ELSE 'QUEUED' END,
      claimed_by = NULL,
      claimed_at = NULL,
      available_at = CASE WHEN d.attempts + 1 >= 5 THEN d.available_at
                          ELSE now() + make_interval(secs => 60 * power(2, least(d.attempts, 4))::int) END,
      completed_at = CASE WHEN d.attempts + 1 >= 5 THEN now() ELSE NULL END,
      last_error = 'LEASE_EXPIRED'
  WHERE d.status = 'CLAIMED' AND d.claimed_at < now() - interval '2 minutes';

  -- 2) Công tắc cá nhân tắt hoặc tài khoản nghỉ → bỏ qua vĩnh viễn, không
  --    gửi âm thầm sau khi nhân viên bị thu quyền.
  UPDATE public.push_deliveries d
  SET status = 'SKIPPED', completed_at = now(),
      last_error = CASE WHEN coalesce(
                   (SELECT t.enabled FROM public.push_user_settings t WHERE t.user_id = d.user_id),
                   true) THEN 'USER_INACTIVE' ELSE 'PUSH_DISABLED' END
  WHERE d.status = 'QUEUED'
    AND (
      NOT coalesce((SELECT t.enabled FROM public.push_user_settings t WHERE t.user_id = d.user_id), true)
      OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = d.user_id AND p.active)
    );

  -- 3) Retention tối thiểu: hàng kết thúc quá 30 ngày bị xoá (đỡ phình DB free).
  DELETE FROM public.push_deliveries
  WHERE status IN ('DONE','FAILED','SKIPPED')
    AND completed_at IS NOT NULL
    AND completed_at < now() - interval '30 days';

  -- 4) Claim lô mới + lắp nội dung gate-theo-người + subscription đang có.
  WITH cte AS (
    SELECT d.id
    FROM public.push_deliveries d
    WHERE d.status = 'QUEUED' AND d.available_at <= now()
      AND (p_user IS NULL OR d.user_id = p_user)
    ORDER BY d.created_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.push_deliveries d
    SET status = 'CLAIMED', claimed_by = p_worker, claimed_at = now()
    FROM cte
    WHERE d.id = cte.id
    RETURNING d.id, d.kind, d.user_id, d.notification_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'delivery_id', c.id,
    'kind', c.kind,
    'user_id', c.user_id,
    'title', CASE WHEN c.kind = 'TEST' THEN 'Kiểm tra thông báo đẩy' ELSE n.title END,
    'body', CASE WHEN c.kind = 'TEST'
                 THEN 'Thiết bị này đã sẵn sàng nhận thông báo từ Cà Rem.'
                 ELSE n.body END,
    'link', CASE WHEN c.kind = 'TEST' THEN '/cai-dat' ELSE coalesce(n.deep_link, '/thong-bao') END,
    'subscriptions', coalesce(sub.arr, '[]'::jsonb)
  ) ORDER BY c.id), '[]'::jsonb) INTO v_rows
  FROM claimed c
  LEFT JOIN public.notifications n ON n.id = c.notification_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth
    ) ORDER BY s.created_at) AS arr
    FROM public.push_subscriptions s
    WHERE s.user_id = c.user_id
  ) sub ON true;

  RETURN coalesce(v_rows, '[]'::jsonb);
END $$;

-- Kết quả một lần xử lý delivery. RETRY tự bump attempts + backoff; chạm
-- trần 5 lần chuyển FAILED vĩnh viễn — Edge Function không được tự tính
-- số lần thử (chống dispatcher lỗi làm phình retry).
CREATE OR REPLACE FUNCTION public.complete_push_delivery(
  p_id uuid,
  p_outcome text,
  p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 200);
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'SERVICE_ONLY';
  END IF;
  IF p_outcome NOT IN ('DONE','SKIPPED','RETRY','FAILED') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_OUTCOME';
  END IF;

  UPDATE public.push_deliveries d
  SET status = CASE
        WHEN p_outcome = 'RETRY' AND d.attempts + 1 >= 5 THEN 'FAILED'
        WHEN p_outcome = 'RETRY' THEN 'QUEUED'
        ELSE p_outcome
      END,
      attempts = CASE WHEN p_outcome = 'RETRY' THEN d.attempts + 1 ELSE d.attempts END,
      available_at = CASE
        WHEN p_outcome = 'RETRY' AND d.attempts + 1 < 5
          THEN now() + make_interval(secs => 60 * power(2, least(d.attempts, 4))::int)
        ELSE d.available_at END,
      claimed_by = NULL,
      claimed_at = NULL,
      -- RETRY chạm trần 5 lần cũng là FAILED vĩnh viễn → phải đóng dấu
      -- completed_at giống nhánh lease hết hạn, nếu không hàng FAILED kiểu
      -- này thoát khỏi retention 30 ngày và rò riêu phình bảng.
      completed_at = CASE
        WHEN p_outcome IN ('DONE','FAILED','SKIPPED') THEN now()
        WHEN p_outcome = 'RETRY' AND d.attempts + 1 >= 5 THEN now()
        ELSE NULL END,
      last_error = v_error
  WHERE d.id = p_id;
END $$;

-- Dọn subscription chết: push endpoint trả 404/410 (endpoint hết hạn bị
-- trình duyệt thu hồi) → xoá ngay, đúng cam kết "server không gửi vào thiết
-- bị đã thu quyền".
CREATE OR REPLACE FUNCTION public.forget_push_subscription(p_endpoint text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'SERVICE_ONLY';
  END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Đánh dấu thiết bị vừa nhận push thành công (làm device_hint hiển thị đúng
-- "máy gần dùng nhất" trên màn Cài đặt).
CREATE OR REPLACE FUNCTION public.touch_push_subscriptions(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'SERVICE_ONLY';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_ids) > 200 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TOO_MANY_IDS';
  END IF;
  UPDATE public.push_subscriptions s
  SET last_used_at = now()
  WHERE s.id = ANY (p_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ============================================================
-- STEP 4: User-facing RPC — tự bắn tin thử vào thiết bị của mình.
-- Không tạo dòng notifications (kho chuông không bẩn); dispatcher
-- tự drain qua claim(p_user => ...) khi client gọi push-dispatch.
-- ============================================================

CREATE OR REPLACE FUNCTION public.request_push_test()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_id uuid;
BEGIN
  IF NOT coalesce(
    (SELECT t.enabled FROM public.push_user_settings t WHERE t.user_id = v_actor), true
  ) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PUSH_DISABLED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = v_actor) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PUSH_NO_DEVICE';
  END IF;
  INSERT INTO public.push_deliveries (kind, user_id)
  VALUES ('TEST', v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ============================================================
-- STEP 5: Privileges
-- ============================================================

REVOKE ALL ON FUNCTION public.claim_push_deliveries(text, integer, uuid),
  public.complete_push_delivery(uuid, text, text),
  public.forget_push_subscription(text), public.touch_push_subscriptions(uuid[]),
  public.request_push_test(), private.enqueue_push_delivery()
  FROM public, anon, authenticated;

-- Dispatcher (Edge Function, service role) là đường duy nhất.
GRANT EXECUTE ON FUNCTION public.claim_push_deliveries(text, integer, uuid),
  public.complete_push_delivery(uuid, text, text),
  public.forget_push_subscription(text), public.touch_push_subscriptions(uuid[])
  TO service_role;

-- Người dùng chỉ có request_push_test.
GRANT EXECUTE ON FUNCTION public.request_push_test() TO authenticated;
