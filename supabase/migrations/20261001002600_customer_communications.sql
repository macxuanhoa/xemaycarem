-- Provider-agnostic transactional outbox for post-sale customer communication.
-- Provider calls are intentionally kept outside sell_vehicle's transaction.

ALTER TABLE public.system_settings
  ADD COLUMN customer_messaging_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN sale_thank_you_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN primary_message_channel text NOT NULL DEFAULT 'DISABLED'
    CHECK (primary_message_channel IN ('DISABLED','ZALO_ZNS','SMS')),
  ADD COLUMN fallback_channel text NOT NULL DEFAULT 'DISABLED'
    CHECK (fallback_channel IN ('DISABLED','ZALO_ZNS','SMS')),
  ADD COLUMN support_phone text NOT NULL DEFAULT '' CHECK (length(support_phone) <= 40);

CREATE TABLE public.message_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('SALE_THANK_YOU','PAYMENT_RECEIVED','DEBT_DUE_SOON','DEBT_OVERDUE','CUSTOMER_FOLLOW_UP','MAINTENANCE_REMINDER')),
  channel text NOT NULL CHECK (channel IN ('DISABLED','ZALO_ZNS','SMS')),
  customer_id uuid,
  sale_id uuid REFERENCES public.sales(id),
  recipient_phone text NOT NULL DEFAULT '',
  template_code text NOT NULL DEFAULT '',
  template_variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(template_variables) = 'object'),
  status text NOT NULL CHECK (status IN ('QUEUED','PROCESSING','SENT','DELIVERED','FAILED','SKIPPED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  last_error_message_safe text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_by uuid REFERENCES public.profiles(id),
  UNIQUE (event_type, sale_id, channel)
);
CREATE INDEX message_outbox_ready ON public.message_outbox(next_attempt_at, created_at) WHERE status IN ('QUEUED','PROCESSING');

CREATE TABLE public.customer_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  sale_id uuid REFERENCES public.sales(id),
  channel text NOT NULL CHECK (channel IN ('DISABLED','ZALO_ZNS','SMS')),
  direction text NOT NULL DEFAULT 'OUTBOUND' CHECK (direction IN ('OUTBOUND','INBOUND')),
  message_type text NOT NULL CHECK (message_type IN ('THANK_YOU','PAYMENT_CONFIRMATION','DEBT_REMINDER','FOLLOW_UP','OTHER')),
  template_code text,
  message_preview text NOT NULL DEFAULT '' CHECK (length(message_preview) <= 500),
  provider text NOT NULL DEFAULT 'DISABLED' CHECK (provider IN ('MOCK','DISABLED','ZALO_ZNS','SMS')),
  provider_message_id text,
  status text NOT NULL CHECK (status IN ('QUEUED','PROCESSING','SENT','DELIVERED','FAILED','SKIPPED','CANCELLED')),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_communications_sale ON public.customer_communications(sale_id, created_at DESC);

ALTER TABLE public.message_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_communications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_outbox, public.customer_communications FROM public, anon, authenticated;

-- Keep the existing sale transaction authoritative. The outbox insert is local SQL only.
CREATE OR REPLACE FUNCTION public.sell_vehicle(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
  v_sale public.sales;
  v_purchase bigint;
  v_expenses bigint;
  v_price bigint := private.money_input(p_data, 'sale_price');
  v_initial bigint := private.money_input(p_data, 'initial_payment', 0);
  v_date date := coalesce((p_data->>'sale_date')::date, private.today());
  v_due_date date := nullif(p_data->>'due_date', '')::date;
  v_payment public.payments;
  v_settings public.system_settings;
  v_phone text;
  v_channel text;
  v_status text;
  v_preview text;
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = (p_data->>'vehicle_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  IF v_vehicle.status NOT IN ('IN_STOCK', 'RESERVED') THEN RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_NOT_AVAILABLE'; END IF;
  IF v_date < v_vehicle.purchase_date OR v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SALE_DATE'; END IF;
  IF v_due_date IS NOT NULL AND v_due_date < v_date THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE'; END IF;
  IF v_price IS NULL OR v_initial > v_price THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT'; END IF;
  IF EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE' AND expense_date > v_date) THEN RAISE EXCEPTION USING errcode = '22023', message = 'SALE_BEFORE_EXPENSE'; END IF;
  SELECT purchase_price INTO v_purchase FROM public.vehicle_financials WHERE vehicle_id = v_vehicle.id;
  IF v_purchase IS NULL THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_COST_REQUIRED'; END IF;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE';
  PERFORM private.safe_money(v_purchase::numeric + v_expenses);
  INSERT INTO public.sales (vehicle_id, customer_name, customer_phone, sale_price, sale_date, due_date, sold_by, notes)
  VALUES (v_vehicle.id, btrim(p_data->>'customer_name'), btrim(coalesce(p_data->>'customer_phone', '')), v_price, v_date, v_due_date, v_actor, coalesce(p_data->>'notes', '')) RETURNING * INTO v_sale;
  INSERT INTO public.sale_financials (sale_id, purchase_cost_snapshot, expense_cost_snapshot, sale_price_snapshot) VALUES (v_sale.id, v_purchase, v_expenses, v_price);
  IF v_initial > 0 THEN
    INSERT INTO public.payments (sale_id, amount, payment_method, payment_date, created_by)
    VALUES (v_sale.id, v_initial, coalesce((p_data->>'payment_method')::public.payment_method, 'CASH'), v_date, v_actor) RETURNING * INTO v_payment;
    PERFORM private.audit('CREATE_PAYMENT', 'payments', v_payment.id, null, to_jsonb(v_payment), v_vehicle.id);
  END IF;
  UPDATE public.vehicles SET status = 'SOLD', updated_at = now() WHERE id = v_vehicle.id;
  PERFORM private.audit('CREATE_SALE', 'sales', v_sale.id, null,
    to_jsonb(v_sale) || jsonb_build_object('purchase_cost_snapshot', v_purchase, 'expense_cost_snapshot', v_expenses,
      'total_cost_snapshot', v_purchase + v_expenses, 'gross_profit', v_price - v_purchase - v_expenses), v_vehicle.id);

  -- The outbox is atomic in the normal path. An outbox/schema failure rolls back
  -- only this nested block, never the already validated sale transaction.
  BEGIN
    SELECT * INTO v_settings FROM public.system_settings WHERE id;
    v_phone := CASE WHEN private.normalize_customer_phone(v_sale.customer_phone) ~ '^0[35789][0-9]{8}$'
      THEN '+84' || substr(private.normalize_customer_phone(v_sale.customer_phone),2) ELSE NULL END;
    v_channel := CASE WHEN v_settings.customer_messaging_enabled AND v_settings.sale_thank_you_enabled THEN v_settings.primary_message_channel ELSE 'DISABLED' END;
    v_status := CASE WHEN v_channel = 'DISABLED' THEN 'SKIPPED' WHEN v_phone IS NULL THEN 'SKIPPED' ELSE 'QUEUED' END;
    v_preview := 'Cảm ơn Quý khách đã mua xe tại ' || coalesce(v_settings.store_name,'cửa hàng') || '.';
    INSERT INTO public.message_outbox(event_type, channel, sale_id, recipient_phone, template_code, template_variables, status, next_attempt_at, created_by, processed_at,
      last_error_code, last_error_message_safe)
    VALUES ('SALE_THANK_YOU', v_channel, v_sale.id, coalesce(v_phone,''), 'sale_thank_you_v1',
      jsonb_build_object('customer_name',v_sale.customer_name,'store_name',v_settings.store_name,'support_phone',v_settings.support_phone),
      v_status, CASE WHEN v_status='QUEUED' THEN now() ELSE NULL END, v_actor, CASE WHEN v_status='QUEUED' THEN NULL ELSE now() END,
      CASE WHEN v_channel='DISABLED' THEN 'MESSAGING_DISABLED' WHEN v_phone IS NULL THEN 'INVALID_OR_MISSING_PHONE' END,
      CASE WHEN v_channel='DISABLED' THEN 'Chưa cấu hình kênh nhắn tin.' WHEN v_phone IS NULL THEN 'Số điện thoại khách hàng không hợp lệ.' END);
    INSERT INTO public.customer_communications(sale_id, channel, message_type, template_code, message_preview, provider, status, created_by, failed_at)
    VALUES (v_sale.id, v_channel, 'THANK_YOU', 'sale_thank_you_v1', v_preview,
      'DISABLED', v_status, v_actor,
      CASE WHEN v_status='FAILED' THEN now() END);
    PERFORM private.audit(CASE WHEN v_status='QUEUED' THEN 'AUTO_MESSAGE_QUEUED' ELSE 'MESSAGE_SKIPPED' END, 'message_outbox', v_sale.id,
      null, jsonb_build_object('status',v_status,'channel',v_channel), v_vehicle.id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN v_sale.id;
END $$;

CREATE OR REPLACE FUNCTION public.get_sale_communication(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sales WHERE id=p_sale_id) THEN RAISE EXCEPTION USING errcode='P0002',message='SALE_NOT_FOUND'; END IF;
  SELECT to_jsonb(o) INTO v_result FROM public.message_outbox o WHERE sale_id=p_sale_id AND event_type='SALE_THANK_YOU' ORDER BY created_at DESC LIMIT 1;
  RETURN coalesce(v_result,'{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.list_customer_communications(p_phone text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_phone text := private.normalize_customer_phone(p_phone); v_result jsonb;
BEGIN
  IF v_phone !~ '^0[35789][0-9]{8}$' THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC),'[]'::jsonb) INTO v_result
  FROM public.customer_communications c JOIN public.sales s ON s.id=c.sale_id
  WHERE private.normalize_customer_phone(s.customer_phone)=v_phone;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.retry_sale_thank_you(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]); v_job public.message_outbox; v_vehicle uuid;
BEGIN
  SELECT * INTO v_job FROM public.message_outbox WHERE sale_id=p_sale_id AND event_type='SALE_THANK_YOU' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='MESSAGE_NOT_FOUND'; END IF;
  IF v_job.status NOT IN ('FAILED','SKIPPED') OR v_job.channel='DISABLED' THEN RAISE EXCEPTION USING errcode='22023',message='MESSAGE_NOT_RETRYABLE'; END IF;
  IF v_job.last_error_code='PROVIDER_NOT_CONFIGURED' THEN RAISE EXCEPTION USING errcode='22023',message='MESSAGE_PROVIDER_NOT_CONFIGURED'; END IF;
  -- OWNER/MANAGER manual retry starts a new bounded attempt window on the same idempotent job.
  IF private.normalize_customer_phone(v_job.recipient_phone) !~ '^0[35789][0-9]{8}$' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_PHONE'; END IF;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=p_sale_id;
  UPDATE public.message_outbox SET status='QUEUED',attempt_count=0,next_attempt_at=now(),last_error_code=NULL,last_error_message_safe=NULL,processed_at=NULL WHERE id=v_job.id RETURNING * INTO v_job;
  UPDATE public.customer_communications SET status='QUEUED',failed_at=NULL WHERE sale_id=p_sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_MANUALLY_RETRIED','message_outbox',v_job.id,null,jsonb_build_object('sale_id',p_sale_id),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

CREATE OR REPLACE FUNCTION public.claim_message(p_message_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_job public.message_outbox; v_vehicle uuid;
BEGIN
  UPDATE public.message_outbox SET status='PROCESSING',attempt_count=attempt_count+1,last_attempt_at=now()
  WHERE id=p_message_id AND status='QUEUED' AND coalesce(next_attempt_at,now())<=now()
    AND attempt_count<max_attempts RETURNING * INTO v_job;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  UPDATE public.customer_communications SET status='PROCESSING' WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  RETURN to_jsonb(v_job);
END $$;

CREATE OR REPLACE FUNCTION public.finish_mock_message(p_message_id uuid, p_provider_message_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_job public.message_outbox; v_vehicle uuid;
BEGIN
  IF p_provider_message_id IS NULL OR p_provider_message_id !~ '^mock_[a-zA-Z0-9_-]{1,80}$' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_PROVIDER_MESSAGE_ID'; END IF;
  UPDATE public.message_outbox SET status='SENT',provider_message_id=p_provider_message_id,processed_at=now(),last_error_code=NULL,last_error_message_safe=NULL
    WHERE id=p_message_id AND status='PROCESSING' RETURNING * INTO v_job;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='22023',message='MESSAGE_NOT_PROCESSING'; END IF;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status='SENT',provider='MOCK',provider_message_id=p_provider_message_id,sent_at=now(),failed_at=NULL
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_SENT','message_outbox',p_message_id,NULL,jsonb_build_object('provider','MOCK','status','SENT'),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

CREATE OR REPLACE FUNCTION public.fail_message(p_message_id uuid, p_error_code text, p_safe_message text, p_permanent boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_job public.message_outbox; v_next text; v_vehicle uuid;
BEGIN
  UPDATE public.message_outbox SET status=CASE WHEN p_permanent OR attempt_count>=max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
    last_error_code=left(coalesce(p_error_code,'PROVIDER_ERROR'),80),last_error_message_safe=left(coalesce(p_safe_message,'Không thể gửi tin nhắn.'),240),
    next_attempt_at=CASE WHEN p_permanent OR attempt_count>=max_attempts THEN NULL ELSE now() + make_interval(mins => least(60,5 * (2 ^ greatest(attempt_count-1,0))::integer)) END,
    processed_at=CASE WHEN p_permanent OR attempt_count>=max_attempts THEN now() ELSE NULL END
  WHERE id=p_message_id AND status='PROCESSING' RETURNING * INTO v_job;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='22023',message='MESSAGE_NOT_PROCESSING'; END IF;
  v_next := v_job.status;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status=v_next,failed_at=CASE WHEN v_next='FAILED' THEN now() ELSE NULL END
    WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit(CASE WHEN v_next='FAILED' THEN 'MESSAGE_FAILED' ELSE 'MESSAGE_RETRIED' END,'message_outbox',p_message_id,NULL,
    jsonb_build_object('status',v_next,'error_code',v_job.last_error_code),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

CREATE OR REPLACE FUNCTION public.skip_message(p_message_id uuid, p_error_code text, p_safe_message text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_job public.message_outbox; v_vehicle uuid;
BEGIN
  UPDATE public.message_outbox SET status='SKIPPED',last_error_code=left(coalesce(p_error_code,'PROVIDER_NOT_CONFIGURED'),80),
    last_error_message_safe=left(coalesce(p_safe_message,'Chưa cấu hình nhà cung cấp tin nhắn.'),240),processed_at=now(),next_attempt_at=NULL
    WHERE id=p_message_id AND status='PROCESSING' RETURNING * INTO v_job;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='22023',message='MESSAGE_NOT_PROCESSING'; END IF;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id=v_job.sale_id;
  UPDATE public.customer_communications SET status='SKIPPED' WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  PERFORM private.audit('MESSAGE_SKIPPED','message_outbox',p_message_id,NULL,jsonb_build_object('status','SKIPPED','error_code',v_job.last_error_code),v_vehicle);
  RETURN to_jsonb(v_job);
END $$;

CREATE OR REPLACE FUNCTION public.save_settings(p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]); v_old jsonb; v_new jsonb;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;
  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;
  UPDATE public.system_settings SET store_name=btrim(coalesce(p_data->>'store_name',store_name)),phone=btrim(coalesce(p_data->>'phone',phone)),
    address=btrim(coalesce(p_data->>'address',address)),low_stock_threshold=coalesce((p_data->>'low_stock_threshold')::integer,low_stock_threshold),
    high_stock_threshold=coalesce((p_data->>'high_stock_threshold')::integer,high_stock_threshold),
    customer_messaging_enabled=coalesce((p_data->>'customer_messaging_enabled')::boolean,customer_messaging_enabled),
    sale_thank_you_enabled=coalesce((p_data->>'sale_thank_you_enabled')::boolean,sale_thank_you_enabled),
    primary_message_channel=coalesce(p_data->>'primary_message_channel',primary_message_channel),
    fallback_channel=coalesce(p_data->>'fallback_channel',fallback_channel),support_phone=btrim(coalesce(p_data->>'support_phone',support_phone)),
    updated_by=v_actor,updated_at=now() WHERE id RETURNING to_jsonb(system_settings) INTO v_new;
  PERFORM private.audit('MESSAGE_SETTING_CHANGED','system_settings',null,v_old,v_new);
END $$;

REVOKE ALL ON FUNCTION public.get_sale_communication(uuid), public.list_customer_communications(text), public.retry_sale_thank_you(uuid), public.claim_message(uuid), public.finish_mock_message(uuid,text), public.fail_message(uuid,text,text,boolean), public.skip_message(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_sale_communication(uuid), public.list_customer_communications(text), public.retry_sale_thank_you(uuid), public.claim_message(uuid), public.finish_mock_message(uuid,text), public.fail_message(uuid,text,text,boolean), public.skip_message(uuid,text,text) TO authenticated;
