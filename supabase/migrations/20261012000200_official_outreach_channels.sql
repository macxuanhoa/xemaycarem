-- Migration: 20261012000200_official_outreach_channels.sql
-- Smart Sales Automation V2 — kiến trúc tích hợp kênh CHÍNH THỨC:
--   Zalo OA, Facebook Page Messenger, SMS (provider adapters + queue + retry +
--   delivery states + permissions) và kênh CÁ NHÂN (Zalo/Messenger) cho luồng
--   nhân viên sao chép — chỉ đổi trạng thái thủ công, không API không chính thức.
-- Forward-only: nới CHECK constraints (không siết lại), định nghĩa lại claim_message
-- với danh sách mode mở rộng, thêm finish_message/mark_message_delivered generic.
-- Chưa có credential → adapter fail-closed PROVIDER_NOT_CONFIGURED → SKIPPED,
-- KHÔNG BAO GIỜ giả lập gửi thành công (semantics y hệt MOCK/DISABLED hiện tại).

BEGIN;

-- ============================================================
-- 1. Nới ràng buộc hàng đợi outbox (forward-only)
-- ============================================================

ALTER TABLE public.message_outbox DROP CONSTRAINT IF EXISTS message_outbox_event_type_check;
ALTER TABLE public.message_outbox ADD CONSTRAINT message_outbox_event_type_check
  CHECK (event_type IN (
    'SALE_THANK_YOU', 'SALE_THANK_YOU_PERSONAL', 'PAYMENT_RECEIVED', 'DEBT_DUE_SOON',
    'DEBT_OVERDUE', 'CUSTOMER_FOLLOW_UP', 'MAINTENANCE_REMINDER'));

ALTER TABLE public.message_outbox DROP CONSTRAINT IF EXISTS message_outbox_channel_check;
ALTER TABLE public.message_outbox ADD CONSTRAINT message_outbox_channel_check
  CHECK (channel IN (
    'DISABLED', 'ZALO_ZNS', 'SMS',
    'ZALO_OA', 'FB_MESSENGER',
    'ZALO_PERSONAL', 'MESSENGER_PERSONAL'));

ALTER TABLE public.message_outbox DROP CONSTRAINT IF EXISTS message_outbox_status_check;
ALTER TABLE public.message_outbox ADD CONSTRAINT message_outbox_status_check
  CHECK (status IN (
    'QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED',
    'AWAITING_STAFF'));

-- Kênh cá nhân do chính nhân viên đánh dấu đã gửi — lease_provider_mode phải ghi nhận được.
ALTER TABLE public.message_outbox DROP CONSTRAINT IF EXISTS message_outbox_lease_provider_mode_check;
ALTER TABLE public.message_outbox ADD CONSTRAINT message_outbox_lease_provider_mode_check
  CHECK (lease_provider_mode IN (
    'MOCK', 'DISABLED', 'ZALO_OA', 'FB_MESSENGER', 'SMS', 'STAFF_MANUAL'));

ALTER TABLE public.customer_communications DROP CONSTRAINT IF EXISTS customer_communications_channel_check;
ALTER TABLE public.customer_communications ADD CONSTRAINT customer_communications_channel_check
  CHECK (channel IN (
    'DISABLED', 'ZALO_ZNS', 'SMS',
    'ZALO_OA', 'FB_MESSENGER',
    'ZALO_PERSONAL', 'MESSENGER_PERSONAL'));

ALTER TABLE public.customer_communications DROP CONSTRAINT IF EXISTS customer_communications_provider_check;
ALTER TABLE public.customer_communications ADD CONSTRAINT customer_communications_provider_check
  CHECK (provider IN (
    'MOCK', 'DISABLED', 'ZALO_ZNS', 'SMS',
    'ZALO_OA', 'FB_MESSENGER', 'ZALO_PERSONAL', 'MESSENGER_PERSONAL', 'STAFF_MANUAL'));

ALTER TABLE public.customer_communications DROP CONSTRAINT IF EXISTS customer_communications_status_check;
ALTER TABLE public.customer_communications ADD CONSTRAINT customer_communications_status_check
  CHECK (status IN (
    'QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED',
    'AWAITING_STAFF'));

-- Cài đặt kênh chính/kênh dự phòng cũng chọn được kênh chính thức mới.
ALTER TABLE public.system_settings DROP CONSTRAINT IF EXISTS system_settings_primary_message_channel_check;
ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_primary_message_channel_check
  CHECK (primary_message_channel IN (
    'DISABLED', 'ZALO_ZNS', 'SMS', 'ZALO_OA', 'FB_MESSENGER'));
ALTER TABLE public.system_settings DROP CONSTRAINT IF EXISTS system_settings_fallback_channel_check;
ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_fallback_channel_check
  CHECK (fallback_channel IN (
    'DISABLED', 'ZALO_ZNS', 'SMS', 'ZALO_OA', 'FB_MESSENGER'));

-- ============================================================
-- 2.claim_message mở rộng danh sách mode (giữ nguyên hàng rào lease)
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_message(p_message_id uuid,p_provider_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_job public.message_outbox; v_vehicle uuid; v_reclaimed boolean := false;
BEGIN
  IF p_provider_mode IS NULL OR p_provider_mode NOT IN
     ('MOCK','DISABLED','ZALO_OA','FB_MESSENGER','SMS') THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_NOT_SUPPORTED';
  END IF;
  -- Hàng đợi cá nhân không có worker: nhân viên xử lý qua RPC riêng.
  IF p_provider_mode = 'STAFF_MANUAL' THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_NOT_SUPPORTED';
  END IF;
  SELECT * INTO v_job FROM public.message_outbox WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_job.channel IN ('ZALO_PERSONAL','MESSENGER_PERSONAL') THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_MANUAL_CHANNEL';
  END IF;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id AND status='COMPLETED';
  IF NOT FOUND THEN
    IF v_job.status IN ('QUEUED','PROCESSING') THEN
      UPDATE public.message_outbox SET status='CANCELLED',lease_token=NULL,lease_actor=NULL,
        lease_expires_at=NULL,next_attempt_at=NULL,processed_at=clock_timestamp() WHERE id=v_job.id;
      UPDATE public.customer_communications SET status='CANCELLED'
        WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
    END IF;
    RETURN '{}'::jsonb;
  END IF;
  IF v_job.status='PROCESSING' THEN
    IF v_job.lease_expires_at > clock_timestamp() THEN RETURN '{}'::jsonb; END IF;
    IF v_job.lease_provider_mode IS NULL OR v_job.lease_token IS NULL THEN
      UPDATE public.message_outbox SET status='FAILED',delivery_review_required=true,
        last_error_code='DELIVERY_OUTCOME_UNKNOWN',
        last_error_message_safe='Kết quả gửi chưa xác định. Cần đối chiếu trước khi gửi lại.',
        lease_expires_at=NULL,next_attempt_at=NULL,processed_at=clock_timestamp() WHERE id=v_job.id;
      UPDATE public.customer_communications SET status='FAILED',failed_at=clock_timestamp()
        WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
      PERFORM private.audit('MESSAGE_DELIVERY_REVIEW_REQUIRED','message_outbox',v_job.id,NULL,
        jsonb_build_object('error_code','DELIVERY_OUTCOME_UNKNOWN'),v_vehicle);
      RETURN '{}'::jsonb;
    END IF;
    v_reclaimed := true;
  ELSIF v_job.status<>'QUEUED' OR coalesce(v_job.next_attempt_at,clock_timestamp())>clock_timestamp() THEN
    RETURN '{}'::jsonb;
  END IF;
  IF v_job.delivery_review_required THEN RETURN '{}'::jsonb; END IF;
  IF v_job.lease_provider_mode IS NOT NULL AND v_job.lease_provider_mode<>p_provider_mode THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_MODE_CONFLICT';
  END IF;
  IF v_job.attempt_count>=v_job.max_attempts THEN
    UPDATE public.message_outbox SET status='FAILED',last_error_code='ATTEMPTS_EXHAUSTED',
      last_error_message_safe='Đã hết số lần xử lý tự động.',lease_expires_at=NULL,
      next_attempt_at=NULL,processed_at=clock_timestamp() WHERE id=v_job.id;
    UPDATE public.customer_communications SET status='FAILED',failed_at=clock_timestamp()
      WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
    PERFORM private.audit('MESSAGE_FAILED','message_outbox',v_job.id,NULL,
      jsonb_build_object('error_code','ATTEMPTS_EXHAUSTED','total_attempt_count',v_job.total_attempt_count),v_vehicle);
    RETURN '{}'::jsonb;
  END IF;
  UPDATE public.message_outbox SET status='PROCESSING',attempt_count=attempt_count+1,
    total_attempt_count=total_attempt_count+1,last_attempt_at=clock_timestamp(),
    lease_token=gen_random_uuid(),lease_actor=v_actor,
    lease_expires_at=clock_timestamp()+interval '120 seconds',lease_provider_mode=p_provider_mode,
    next_attempt_at=NULL,processed_at=NULL WHERE id=v_job.id RETURNING * INTO v_job;
  UPDATE public.customer_communications SET status='PROCESSING',failed_at=NULL
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit(CASE WHEN v_reclaimed THEN 'MESSAGE_LEASE_RECLAIMED' ELSE 'MESSAGE_CLAIMED' END,
    'message_outbox',v_job.id,NULL,
    jsonb_build_object('attempt_count',v_job.attempt_count,'total_attempt_count',v_job.total_attempt_count,
      'provider',p_provider_mode,'lease_expires_at',v_job.lease_expires_at),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

-- ============================================================
-- 3. finish_message generic cho provider chính thức + mark_message_delivered
-- ============================================================

-- Chỉ mode ngoài MOCK (MOCK giữ nguyên đường finish_mock_message deterministic cũ).
CREATE OR REPLACE FUNCTION public.finish_message(p_message_id uuid,p_provider_message_id text,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid;
BEGIN
  v_job := private.lock_message_lease(p_message_id,p_lease_token,true);
  IF v_job.lease_provider_mode IS NULL OR v_job.lease_provider_mode='MOCK' THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_NOT_SUPPORTED';
  END IF;
  IF p_provider_message_id IS NULL
     OR p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,119}$' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_PROVIDER_MESSAGE_ID';
  END IF;
  IF v_job.status='SENT' THEN RETURN to_jsonb(v_job); END IF;
  UPDATE public.message_outbox SET status='SENT',provider_message_id=p_provider_message_id,
    processed_at=clock_timestamp(),lease_expires_at=NULL,
    last_error_code=NULL,last_error_message_safe=NULL
    WHERE id=v_job.id RETURNING * INTO v_job;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications
    SET status='SENT',provider=v_job.lease_provider_mode,
        provider_message_id=p_provider_message_id,
        channel=v_job.channel,sent_at=clock_timestamp(),failed_at=NULL
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_SENT','message_outbox',v_job.id,NULL,
    jsonb_build_object('provider',v_job.lease_provider_mode,'status','SENT'),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

-- Đánh dấu DELIVERED khi nhà cung cấp xác nhận thiết bị khách nhận tin.
CREATE OR REPLACE FUNCTION public.mark_message_delivered(p_message_id uuid,p_provider_message_id text,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid;
BEGIN
  v_job := private.lock_message_lease(p_message_id,p_lease_token,true);
  IF v_job.status NOT IN ('SENT','DELIVERED') THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_CONFLICT';
  END IF;
  IF p_provider_message_id IS NOT NULL AND v_job.provider_message_id IS NOT NULL
     AND p_provider_message_id <> v_job.provider_message_id THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_PROVIDER_MESSAGE_ID';
  END IF;
  IF v_job.status='DELIVERED' THEN RETURN to_jsonb(v_job); END IF;
  UPDATE public.message_outbox SET status='DELIVERED',processed_at=clock_timestamp(),
    lease_token=NULL,lease_actor=NULL,lease_expires_at=NULL,lease_provider_mode=NULL
    WHERE id=v_job.id RETURNING * INTO v_job;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications
    SET status='DELIVERED',delivered_at=clock_timestamp()
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_DELIVERED','message_outbox',v_job.id,NULL,
    jsonb_build_object('status','DELIVERED'),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

-- retry_sale_thank_you: hàng đợi cá nhân KHÔNG có đường tự động gửi lại.
CREATE OR REPLACE FUNCTION public.retry_sale_thank_you(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_job public.message_outbox; v_vehicle uuid;
BEGIN
  SELECT * INTO v_job FROM public.message_outbox WHERE sale_id=p_sale_id AND event_type='SALE_THANK_YOU' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='MESSAGE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  IF v_job.channel IN ('ZALO_PERSONAL','MESSENGER_PERSONAL') THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_MANUAL_CHANNEL';
  END IF;
  IF v_job.delivery_review_required THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_DELIVERY_REVIEW_REQUIRED';
  END IF;
  IF v_job.status NOT IN ('FAILED','SKIPPED') OR v_job.channel='DISABLED' THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_NOT_RETRYABLE';
  END IF;
  IF v_job.last_error_code='PROVIDER_NOT_CONFIGURED' THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_NOT_CONFIGURED';
  END IF;
  IF private.normalize_customer_phone(v_job.recipient_phone) !~ '^0[35789][0-9]{8}$' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_PHONE';
  END IF;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=p_sale_id AND status='COMPLETED';
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='22023',message='SALE_CANCELLED'; END IF;
  UPDATE public.message_outbox SET status='QUEUED',attempt_count=0,next_attempt_at=clock_timestamp(),
    last_error_code=NULL,last_error_message_safe=NULL,processed_at=NULL,
    lease_token=NULL,lease_actor=NULL,lease_expires_at=NULL WHERE id=v_job.id RETURNING * INTO v_job;
  UPDATE public.customer_communications SET status='QUEUED',failed_at=NULL WHERE sale_id=p_sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_MANUALLY_RETRIED','message_outbox',v_job.id,NULL,
    jsonb_build_object('sale_id',p_sale_id,'total_attempt_count',v_job.total_attempt_count),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

-- ============================================================
-- 4. Luồng CÁ NHÂN: sao chép → mở liên hệ → nhân viên tự đánh dấu đã gửi.
--    Không bot, không cookie scraping, không API không chính thức.
-- ============================================================

-- Nhân viên bấm "Sao chép lời cảm ơn": QUEUED → AWAITING_STAFF (có ghi dấu audit).
CREATE OR REPLACE FUNCTION public.mark_thank_you_copied(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_job public.message_outbox;
BEGIN
  SELECT * INTO v_job FROM public.message_outbox
    WHERE sale_id = p_sale_id AND event_type = 'SALE_THANK_YOU_PERSONAL'
      AND status = 'QUEUED'
    ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='MESSAGE_NOT_FOUND';
  END IF;
  UPDATE public.message_outbox SET status='AWAITING_STAFF', processed_at=clock_timestamp()
    WHERE id = v_job.id RETURNING * INTO v_job;
  PERFORM private.audit('MESSAGE_THANK_YOU_COPIED','message_outbox',v_job.id,NULL,
    jsonb_build_object('sale_id',p_sale_id,'channel',v_job.channel),
    (SELECT s.vehicle_id FROM public.sales s WHERE s.id = p_sale_id));
  RETURN to_jsonb(v_job)-'lease_token'-'lease_actor';
END $$;

-- Nhân viên xác nhận ĐÃ TỰ GỬI tin ngoài ứng dụng. Trạng thái do người ghi nhận,
-- không phải nhà cung cấp — provider = STAFF_MANUAL, không bao giờ DELIVERED.
CREATE OR REPLACE FUNCTION public.mark_personal_thank_you_sent(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_job public.message_outbox;
  v_channel text := upper(btrim(coalesce(p_data->>'channel','')));
  v_evidence text := left(btrim(coalesce(p_data->>'evidence_note','')), 240);
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object'
     OR v_channel NOT IN ('ZALO_PERSONAL','MESSENGER_PERSONAL') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  SELECT * INTO v_job FROM public.message_outbox
    WHERE sale_id = nullif(p_data->>'sale_id','')::uuid
      AND event_type = 'SALE_THANK_YOU_PERSONAL' AND channel = v_channel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='MESSAGE_NOT_FOUND';
  END IF;
  IF v_job.status NOT IN ('QUEUED','AWAITING_STAFF') THEN
    RAISE EXCEPTION USING errcode='22023', message='MESSAGE_NOT_RETRYABLE';
  END IF;
  UPDATE public.message_outbox SET status='SENT', processed_at=clock_timestamp(),
    lease_provider_mode='STAFF_MANUAL', provider_message_id=NULL,
    last_error_code=NULL, last_error_message_safe=CASE WHEN v_evidence<>'' THEN v_evidence END
    WHERE id = v_job.id RETURNING * INTO v_job;
  INSERT INTO public.customer_communications
    (sale_id, channel, direction, message_type, template_code, message_preview,
     provider, status, sent_at, created_by)
  VALUES (v_job.sale_id, v_job.channel, 'OUTBOUND', 'THANK_YOU', v_job.template_code,
    left(coalesce(v_job.template_variables->>'customer_name',''), 500),
    'STAFF_MANUAL', 'SENT', clock_timestamp(), v_actor);
  PERFORM private.audit('MESSAGE_PERSONAL_THANK_YOU_SENT','message_outbox',v_job.id,NULL,
    jsonb_build_object('sale_id',v_job.sale_id,'channel',v_job.channel,
                       'evidence_note',v_evidence),
    (SELECT s.vehicle_id FROM public.sales s WHERE s.id = v_job.sale_id));
  RETURN jsonb_build_object('id', v_job.id, 'status', v_job.status, 'channel', v_job.channel);
END $$;

-- Liệt kê hàng đợi cảm ơn của một đơn (mọi event type/kênh) cho panel SaleDetail.
-- Trả preview + trạng thái; không chứa lease token; không chứa số tiền (template không biến giá).
CREATE OR REPLACE FUNCTION public.list_sale_thank_you_queue(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_items jsonb;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF NOT EXISTS (SELECT 1 FROM public.sales WHERE id = p_sale_id) THEN
    RAISE EXCEPTION USING errcode='P0002', message='SALE_NOT_FOUND';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'event_type', o.event_type, 'channel', o.channel,
      'status', o.status, 'template_code', o.template_code,
      'recipient_phone', CASE WHEN o.channel IN ('ZALO_PERSONAL','MESSENGER_PERSONAL')
                              THEN o.recipient_phone ELSE '' END,
      'last_error_code', o.last_error_code, 'created_at', o.created_at,
      'processed_at', o.processed_at
    ) ORDER BY o.created_at), '[]'::jsonb) INTO v_items
  FROM public.message_outbox o
  WHERE o.sale_id = p_sale_id
    AND o.event_type IN ('SALE_THANK_YOU','SALE_THANK_YOU_PERSONAL');
  RETURN v_items;
END $$;

-- ============================================================
-- 5. message_templates: mẫu lời cảm ơn cho kênh chính thức, OWNER sửa được.
--    Whitelist biến CẤM giá: chỉ {customer_name} {store_name} {support_phone}
--    {sale_code}. Không có biến số tiền nào — chống lộ giá qua tin nhắn.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.message_templates (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{3,64}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  channel text NOT NULL DEFAULT '' CHECK (channel IN (
    '', 'ZALO_ZNS', 'SMS', 'ZALO_OA', 'FB_MESSENGER')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  variables text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_templates FROM public, anon, authenticated;

-- Mẫu mặc định cho các kênh chính thức V2 (giống tinh thần sale_thank_you_v1: không giá).
INSERT INTO public.message_templates (code, name, channel, body, variables) VALUES
  ('thank_you_zalo_oa_v1', 'Cảm ơn qua Zalo OA', 'ZALO_OA',
   'Cảm ơn {customer_name} đã mua xe tại {store_name}. Mọi hỗ trợ xin gọi {support_phone}.',
   ARRAY['customer_name','store_name','support_phone']),
  ('thank_you_fb_page_v1', 'Cảm ơn qua Facebook Page', 'FB_MESSENGER',
   'Cảm ơn {customer_name} đã đồng hành cùng {store_name}! Cửa hàng luôn sẵn sàng hỗ trợ qua inbox.',
   ARRAY['customer_name','store_name']),
  ('thank_you_sms_v1', 'Cảm ơn qua SMS', 'SMS',
   'Cam on {customer_name} da mua xe tai {store_name}. Lien he ho tro: {support_phone}.',
   ARRAY['customer_name','store_name','support_phone'])
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.list_message_templates()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_items jsonb;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'code', t.code, 'name', t.name, 'channel', t.channel, 'body', t.body,
      'variables', t.variables, 'is_active', t.is_active, 'updated_at', t.updated_at
    ) ORDER BY t.code), '[]'::jsonb) INTO v_items
  FROM public.message_templates t;
  RETURN v_items;
END $$;

CREATE OR REPLACE FUNCTION public.preview_message_template(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code text := btrim(coalesce(p_data->>'code',''));
  v_body text;
  v_render text;
  v_settings public.system_settings;
  v_sale public.sales;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  SELECT t.body INTO v_body FROM public.message_templates t
    WHERE t.code = v_code AND t.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='TEMPLATE_NOT_FOUND';
  END IF;
  SELECT * INTO v_settings FROM public.system_settings WHERE id;
  v_sale := null;
  IF nullif(p_data->>'sale_id','') IS NOT NULL THEN
    SELECT * INTO v_sale FROM public.sales WHERE id = nullif(p_data->>'sale_id','')::uuid;
  END IF;
  v_render := replace(replace(replace(replace(v_body,
    '{customer_name}', coalesce(v_sale.customer_name, 'Quý khách')),
    '{store_name}', coalesce(nullif(v_settings.store_name,''), 'cửa hàng')),
    '{support_phone}', coalesce(nullif(v_settings.support_phone,''), '')),
    '{sale_code}', coalesce(v_sale.sale_code, ''));
  RETURN jsonb_build_object('code', v_code, 'rendered', v_render);
END $$;

-- OWNER sửa mẫu. Kiểm tra whitelist biến server-side: mọi {biến} phải nằm trong
-- danh sách cho phép — không con đường nào chèn biến giá vào tin nhắn khách.
CREATE OR REPLACE FUNCTION public.save_message_template(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old public.message_templates;
  v_new public.message_templates;
  v_code text;
  v_body text;
  v_bad text;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  v_code := lower(btrim(coalesce(p_data->>'code','')));
  v_body := left(btrim(coalesce(p_data->>'body','')), 500);
  IF v_code !~ '^[a-z0-9_]{3,64}$' OR v_body = '' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_TEMPLATE';
  END IF;

  -- Mọi placeholder phải thuộc whitelist phi giá trị.
  FOR v_bad IN
    SELECT mm[1] FROM regexp_matches(v_body, '\{([a-z0-9_]+)\}', 'g') mm
  LOOP
    IF v_bad NOT IN ('customer_name','store_name','support_phone','sale_code') THEN
      RAISE EXCEPTION USING errcode='22023', message='TEMPLATE_VARIABLE_NOT_ALLOWED';
    END IF;
  END LOOP;

  SELECT * INTO v_old FROM public.message_templates WHERE code = v_code FOR UPDATE;
  IF FOUND THEN
    UPDATE public.message_templates SET
      name = left(btrim(coalesce(p_data->>'name', v_old.name)), 120),
      body = v_body,
      is_active = coalesce((p_data->>'is_active')::boolean, v_old.is_active),
      updated_by = v_actor, updated_at = now()
      WHERE code = v_code RETURNING * INTO v_new;
  ELSE
    INSERT INTO public.message_templates (code, name, channel, body, variables, updated_by)
    VALUES (v_code,
      left(btrim(coalesce(p_data->>'name', v_code)), 120),
      CASE WHEN coalesce(p_data->>'channel','') IN ('ZALO_ZNS','SMS','ZALO_OA','FB_MESSENGER')
           THEN p_data->>'channel' ELSE '' END,
      v_body,
      ARRAY(SELECT DISTINCT m[1] FROM regexp_matches(v_body, '\{([a-z0-9_]+)\}', 'g') m),
      v_actor)
    RETURNING * INTO v_new;
  END IF;

  PERFORM private.audit('MESSAGE_TEMPLATE_CHANGED', 'message_templates', NULL,
    to_jsonb(v_old), to_jsonb(v_new));
  RETURN to_jsonb(v_new);
END $$;

-- ============================================================
-- 6. get_sale_communication: thêm hàng đợi cá nhân để màn hình SaleDetail đọc
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_sale_communication(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sales WHERE id=p_sale_id) THEN
    RAISE EXCEPTION USING errcode='P0002',message='SALE_NOT_FOUND';
  END IF;
  SELECT to_jsonb(o)-'lease_token'-'lease_actor' INTO v_result FROM public.message_outbox o
    WHERE sale_id=p_sale_id AND event_type IN ('SALE_THANK_YOU','SALE_THANK_YOU_PERSONAL')
    ORDER BY (o.event_type='SALE_THANK_YOU_PERSONAL') DESC, created_at DESC LIMIT 1;
  RETURN coalesce(v_result,'{}'::jsonb);
END $$;

-- ============================================================
-- 7. Phân quyền
-- ============================================================

REVOKE ALL ON FUNCTION
  public.finish_message(uuid,text,uuid), public.mark_message_delivered(uuid,text,uuid),
  public.mark_thank_you_copied(uuid), public.mark_personal_thank_you_sent(jsonb),
  public.list_sale_thank_you_queue(uuid), public.list_message_templates(),
  public.preview_message_template(jsonb), public.save_message_template(jsonb)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION
  public.finish_message(uuid,text,uuid), public.mark_message_delivered(uuid,text,uuid),
  public.mark_thank_you_copied(uuid), public.mark_personal_thank_you_sent(jsonb),
  public.list_sale_thank_you_queue(uuid), public.list_message_templates(),
  public.preview_message_template(jsonb), public.save_message_template(jsonb)
  TO authenticated;

-- Tự kiểm chứng: thiếu một trong các RPC V2 là migration áp dở dang.
DO $$
BEGIN
  IF (SELECT count(DISTINCT p.proname) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('finish_message','mark_message_delivered','mark_thank_you_copied',
                          'mark_personal_thank_you_sent','save_message_template')) <> 5 THEN
    RAISE EXCEPTION USING errcode = 'P0001', message = 'AUTOMATION_V2_RPC_MISSING';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
