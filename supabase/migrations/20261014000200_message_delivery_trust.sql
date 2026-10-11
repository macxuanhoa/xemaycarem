-- Trusted official-provider outcomes and conservative uncertain-delivery recovery.
-- Additive forward correction; does not enable providers or change business money.
BEGIN;

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
  IF p_provider_mode IN ('ZALO_OA','FB_MESSENGER','SMS') AND v_job.channel <> p_provider_mode THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_MODE_CONFLICT';
  END IF;
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
    IF v_job.lease_provider_mode IS NULL OR v_job.lease_token IS NULL
       OR v_job.lease_provider_mode NOT IN ('MOCK','DISABLED') THEN
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

CREATE OR REPLACE FUNCTION public.fail_message(p_message_id uuid,p_error_code text,p_safe_message text,p_permanent boolean,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid; v_unknown boolean;
BEGIN
  v_job := private.lock_message_lease(p_message_id,p_lease_token);
  v_unknown := v_job.lease_provider_mode IN ('ZALO_OA','FB_MESSENGER','SMS');
  UPDATE public.message_outbox SET status=CASE WHEN v_unknown OR p_permanent OR attempt_count>=max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
    delivery_review_required=delivery_review_required OR v_unknown,
    last_error_code=CASE WHEN v_unknown THEN 'DELIVERY_OUTCOME_UNKNOWN' ELSE left(coalesce(p_error_code,'PROVIDER_ERROR'),80) END,
    last_error_message_safe=left(coalesce(p_safe_message,'Không thể gửi tin nhắn.'),240),
    next_attempt_at=CASE WHEN v_unknown OR p_permanent OR attempt_count>=max_attempts THEN NULL
      ELSE clock_timestamp()+make_interval(mins => least(60,5*(2^greatest(attempt_count-1,0))::integer)) END,
    processed_at=CASE WHEN v_unknown OR p_permanent OR attempt_count>=max_attempts THEN clock_timestamp() ELSE NULL END,
    lease_token=NULL,lease_actor=NULL,lease_expires_at=NULL
    WHERE id=v_job.id RETURNING * INTO v_job;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status=v_job.status,
    failed_at=CASE WHEN v_job.status='FAILED' THEN clock_timestamp() ELSE NULL END
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit(CASE WHEN v_job.status='FAILED' THEN 'MESSAGE_FAILED' ELSE 'MESSAGE_RETRIED' END,
    'message_outbox',v_job.id,NULL,
    jsonb_build_object('status',v_job.status,'error_code',v_job.last_error_code,'total_attempt_count',v_job.total_attempt_count),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;


CREATE OR REPLACE FUNCTION private.lock_trusted_message_lease(p_id uuid,p_token uuid)
RETURNS public.message_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job public.message_outbox;
BEGIN
  IF NOT private.is_service_role() THEN
    RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED';
  END IF;
  SELECT * INTO v_job FROM public.message_outbox WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='MESSAGE_NOT_FOUND'; END IF;
  IF v_job.lease_provider_mode IS NULL OR v_job.lease_provider_mode NOT IN ('ZALO_OA','FB_MESSENGER','SMS') THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_NOT_SUPPORTED';
  END IF;
  IF p_token IS NULL OR v_job.lease_token IS DISTINCT FROM p_token OR v_job.lease_actor IS NULL THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_CONFLICT';
  END IF;
  IF v_job.status='SENT' THEN RETURN v_job; END IF;
  IF v_job.status<>'PROCESSING' OR v_job.delivery_review_required THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_CONFLICT';
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_EXPIRED';
  END IF;
  RETURN v_job;
END $$;
REVOKE ALL ON FUNCTION private.lock_trusted_message_lease(uuid,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.lock_trusted_message_lease(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_message(p_message_id uuid,p_provider_message_id text,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid;
BEGIN
  v_job := private.lock_trusted_message_lease(p_message_id,p_lease_token);
  IF p_provider_message_id IS NULL OR p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,119}$'
    OR (v_job.provider_message_id IS NOT NULL AND v_job.provider_message_id IS DISTINCT FROM p_provider_message_id) THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_PROVIDER_MESSAGE_ID';
  END IF;
  IF v_job.status='SENT' THEN RETURN to_jsonb(v_job)-'lease_token'-'lease_actor'; END IF;
  UPDATE public.message_outbox SET status='SENT',provider_message_id=p_provider_message_id,
    processed_at=clock_timestamp(),lease_expires_at=NULL,last_error_code=NULL,last_error_message_safe=NULL
    WHERE id=v_job.id RETURNING * INTO v_job;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status='SENT',provider=v_job.lease_provider_mode,
    provider_message_id=p_provider_message_id,channel=v_job.channel,sent_at=clock_timestamp(),failed_at=NULL
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_SENT','message_outbox',v_job.id,NULL,
    jsonb_build_object('provider',v_job.lease_provider_mode,'status','SENT'),v_vehicle);
  RETURN to_jsonb(v_job)-'lease_token'-'lease_actor';
END $$;

-- A verified provider callback may assert delivery; an authenticated browser cannot.
-- This RPC does not replace callback signature/eligibility verification.
CREATE OR REPLACE FUNCTION public.mark_message_delivered(p_message_id uuid,p_provider_message_id text,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid;
BEGIN
  IF NOT private.is_service_role() THEN
    RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED';
  END IF;
  SELECT * INTO v_job FROM public.message_outbox WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='MESSAGE_NOT_FOUND'; END IF;
  IF v_job.status NOT IN ('SENT','DELIVERED') OR v_job.lease_provider_mode IS NULL
    OR v_job.lease_provider_mode NOT IN ('ZALO_OA','FB_MESSENGER','SMS') THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_CONFLICT';
  END IF;
  IF p_provider_message_id IS NULL OR v_job.provider_message_id IS DISTINCT FROM p_provider_message_id THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_PROVIDER_MESSAGE_ID';
  END IF;
  IF v_job.status='DELIVERED' THEN RETURN to_jsonb(v_job)-'lease_token'-'lease_actor'; END IF;
  IF p_lease_token IS NULL OR v_job.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_CONFLICT';
  END IF;
  UPDATE public.message_outbox SET status='DELIVERED',processed_at=clock_timestamp(),
    lease_token=NULL,lease_actor=NULL,lease_expires_at=NULL
    WHERE id=v_job.id RETURNING * INTO v_job;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status='DELIVERED',delivered_at=clock_timestamp()
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_DELIVERED','message_outbox',v_job.id,NULL,
    jsonb_build_object('provider',v_job.lease_provider_mode,'status','DELIVERED'),v_vehicle);
  RETURN to_jsonb(v_job)-'lease_token'-'lease_actor';
END $$;

REVOKE ALL ON FUNCTION public.finish_message(uuid,text,uuid),public.mark_message_delivered(uuid,text,uuid)
  FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_message(uuid,text,uuid),public.mark_message_delivered(uuid,text,uuid)
  TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
