-- Fenced, bounded leases for the explicitly supported MOCK/DISABLED providers.
-- No external provider is enabled by this migration. Unknown delivery requires review.
BEGIN;

ALTER TABLE public.message_outbox
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_actor uuid REFERENCES public.profiles(id),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN lease_provider_mode text CHECK (lease_provider_mode IN ('MOCK','DISABLED')),
  ADD COLUMN total_attempt_count integer NOT NULL DEFAULT 0 CHECK (total_attempt_count >= 0),
  ADD COLUMN delivery_review_required boolean NOT NULL DEFAULT false;
UPDATE public.message_outbox SET total_attempt_count=attempt_count;

-- Legacy workers had no fencing or durable provider outcome. Never resend them blindly.
WITH quarantined AS (
  UPDATE public.message_outbox SET status='FAILED',delivery_review_required=true,
    last_error_code='DELIVERY_OUTCOME_UNKNOWN',
    last_error_message_safe='Kết quả gửi chưa xác định. Cần đối chiếu trước khi gửi lại.',
    processed_at=clock_timestamp(),next_attempt_at=NULL
  WHERE status='PROCESSING' RETURNING sale_id
)
UPDATE public.customer_communications SET status='FAILED',failed_at=clock_timestamp()
WHERE sale_id IN (SELECT sale_id FROM quarantined) AND message_type='THANK_YOU';

-- Read-only screens need state and attempt counters, never a worker's fencing token.
CREATE OR REPLACE FUNCTION public.get_sale_communication(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sales WHERE id=p_sale_id) THEN
    RAISE EXCEPTION USING errcode='P0002',message='SALE_NOT_FOUND';
  END IF;
  SELECT to_jsonb(o)-'lease_token'-'lease_actor' INTO v_result FROM public.message_outbox o
    WHERE sale_id=p_sale_id AND event_type='SALE_THANK_YOU' ORDER BY created_at DESC LIMIT 1;
  RETURN coalesce(v_result,'{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.claim_message(p_message_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
END $$;

CREATE OR REPLACE FUNCTION public.claim_message(p_message_id uuid,p_provider_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_job public.message_outbox; v_vehicle uuid; v_reclaimed boolean := false;
BEGIN
  IF p_provider_mode IS NULL OR p_provider_mode NOT IN ('MOCK','DISABLED') THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_NOT_SUPPORTED';
  END IF;
  SELECT * INTO v_job FROM public.message_outbox WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
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

CREATE OR REPLACE FUNCTION private.lock_message_lease(p_id uuid,p_token uuid,p_allow_sent boolean DEFAULT false)
RETURNS public.message_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_job public.message_outbox;
BEGIN
  SELECT * INTO v_job FROM public.message_outbox WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='MESSAGE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF p_token IS NULL OR v_job.lease_token IS DISTINCT FROM p_token OR v_job.lease_actor IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_CONFLICT';
  END IF;
  IF p_allow_sent AND v_job.status='SENT' THEN RETURN v_job; END IF;
  IF v_job.status<>'PROCESSING' THEN RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_CONFLICT'; END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING errcode='40001',message='MESSAGE_LEASE_EXPIRED';
  END IF;
  RETURN v_job;
END $$;
REVOKE ALL ON FUNCTION private.lock_message_lease(uuid,uuid,boolean) FROM public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.renew_message_lease(p_message_id uuid,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.message_outbox;
BEGIN
  v_job := private.lock_message_lease(p_message_id,p_lease_token);
  UPDATE public.message_outbox SET lease_expires_at=clock_timestamp()+interval '120 seconds'
    WHERE id=v_job.id RETURNING * INTO v_job;
  RETURN to_jsonb(v_job);
END $$;

CREATE OR REPLACE FUNCTION public.finish_mock_message(p_message_id uuid,p_provider_message_id text,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid;
BEGIN
  v_job := private.lock_message_lease(p_message_id,p_lease_token,true);
  -- The provider result is deterministic for the outbox ID, even across process restarts.
  IF v_job.lease_provider_mode IS DISTINCT FROM 'MOCK' OR p_provider_message_id IS DISTINCT FROM 'mock_'||v_job.id::text THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_PROVIDER_MESSAGE_ID';
  END IF;
  IF v_job.status='SENT' THEN RETURN to_jsonb(v_job); END IF;
  UPDATE public.message_outbox SET status='SENT',provider_message_id=p_provider_message_id,
    processed_at=clock_timestamp(),lease_expires_at=NULL,last_error_code=NULL,last_error_message_safe=NULL
    WHERE id=v_job.id RETURNING * INTO v_job;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status='SENT',provider='MOCK',provider_message_id=p_provider_message_id,
    sent_at=clock_timestamp(),failed_at=NULL WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_SENT','message_outbox',v_job.id,NULL,jsonb_build_object('provider','MOCK','status','SENT'),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

CREATE OR REPLACE FUNCTION public.fail_message(p_message_id uuid,p_error_code text,p_safe_message text,p_permanent boolean,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid;
BEGIN
  v_job := private.lock_message_lease(p_message_id,p_lease_token);
  UPDATE public.message_outbox SET status=CASE WHEN p_permanent OR attempt_count>=max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
    last_error_code=left(coalesce(p_error_code,'PROVIDER_ERROR'),80),
    last_error_message_safe=left(coalesce(p_safe_message,'Không thể gửi tin nhắn.'),240),
    next_attempt_at=CASE WHEN p_permanent OR attempt_count>=max_attempts THEN NULL
      ELSE clock_timestamp()+make_interval(mins => least(60,5*(2^greatest(attempt_count-1,0))::integer)) END,
    processed_at=CASE WHEN p_permanent OR attempt_count>=max_attempts THEN clock_timestamp() ELSE NULL END,
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

CREATE OR REPLACE FUNCTION public.skip_message(p_message_id uuid,p_error_code text,p_safe_message text,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.message_outbox; v_vehicle uuid;
BEGIN
  v_job := private.lock_message_lease(p_message_id,p_lease_token);
  UPDATE public.message_outbox SET status='SKIPPED',last_error_code=left(coalesce(p_error_code,'PROVIDER_NOT_CONFIGURED'),80),
    last_error_message_safe=left(coalesce(p_safe_message,'Chưa cấu hình nhà cung cấp tin nhắn.'),240),
    processed_at=clock_timestamp(),next_attempt_at=NULL,lease_token=NULL,lease_actor=NULL,lease_expires_at=NULL
    WHERE id=v_job.id RETURNING * INTO v_job;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status='SKIPPED' WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_SKIPPED','message_outbox',v_job.id,NULL,
    jsonb_build_object('status','SKIPPED','error_code',v_job.last_error_code),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

-- Compatibility entry points fail before mutation: old workers cannot complete a new lease.
CREATE OR REPLACE FUNCTION public.finish_mock_message(p_message_id uuid,p_provider_message_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
END $$;
CREATE OR REPLACE FUNCTION public.fail_message(p_message_id uuid,p_error_code text,p_safe_message text,p_permanent boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
END $$;
CREATE OR REPLACE FUNCTION public.skip_message(p_message_id uuid,p_error_code text,p_safe_message text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  RAISE EXCEPTION USING errcode='22023',message='CLIENT_UPGRADE_REQUIRED';
END $$;

CREATE OR REPLACE FUNCTION public.retry_sale_thank_you(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_job public.message_outbox; v_vehicle uuid;
BEGIN
  SELECT * INTO v_job FROM public.message_outbox WHERE sale_id=p_sale_id AND event_type='SALE_THANK_YOU' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='MESSAGE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
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

CREATE OR REPLACE FUNCTION public.resolve_message_delivery(p_message_id uuid,p_resolution text,p_evidence_reference text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_job public.message_outbox; v_vehicle uuid;
BEGIN
  IF p_resolution IS NULL OR p_resolution NOT IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT')
    OR p_evidence_reference IS NULL OR p_evidence_reference !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,119}$' THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_DELIVERY_EVIDENCE_REQUIRED';
  END IF;
  SELECT * INTO v_job FROM public.message_outbox WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='MESSAGE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  IF NOT v_job.delivery_review_required OR v_job.status<>'FAILED' THEN
    RAISE EXCEPTION USING errcode='22023',message='MESSAGE_DELIVERY_REVIEW_NOT_REQUIRED';
  END IF;
  UPDATE public.message_outbox SET delivery_review_required=false,
    status=CASE WHEN p_resolution='CONFIRMED_SENT' THEN 'SENT' ELSE 'FAILED' END,
    provider_message_id=CASE WHEN p_resolution='CONFIRMED_SENT' THEN p_evidence_reference ELSE provider_message_id END,
    lease_token=NULL,lease_actor=NULL,lease_expires_at=NULL,lease_provider_mode=NULL,
    last_error_code=CASE WHEN p_resolution='CONFIRMED_NOT_SENT' THEN 'DELIVERY_VERIFIED_NOT_SENT' ELSE NULL END,
    last_error_message_safe=NULL,processed_at=clock_timestamp() WHERE id=v_job.id RETURNING * INTO v_job;
  UPDATE public.customer_communications SET status=v_job.status,
    sent_at=CASE WHEN v_job.status='SENT' THEN clock_timestamp() ELSE sent_at END,
    provider_message_id=v_job.provider_message_id,
    failed_at=CASE WHEN v_job.status='FAILED' THEN clock_timestamp() ELSE NULL END
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  PERFORM private.audit('MESSAGE_DELIVERY_RECONCILED','message_outbox',v_job.id,NULL,
    jsonb_build_object('resolution',p_resolution,'evidence_reference',p_evidence_reference),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

REVOKE ALL ON FUNCTION public.claim_message(uuid,text),public.renew_message_lease(uuid,uuid),
  public.finish_mock_message(uuid,text,uuid),public.fail_message(uuid,text,text,boolean,uuid),
  public.skip_message(uuid,text,text,uuid),public.resolve_message_delivery(uuid,text,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.claim_message(uuid,text),public.renew_message_lease(uuid,uuid),
  public.finish_mock_message(uuid,text,uuid),public.fail_message(uuid,text,text,boolean,uuid),
  public.skip_message(uuid,text,text,uuid),public.resolve_message_delivery(uuid,text,text) TO authenticated;
COMMIT;
