BEGIN;

-- A QR is a payment instruction, never evidence that money was received.
ALTER TABLE public.vietqr_requests
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN replace_available_at timestamptz,
  ADD COLUMN transfer_content text NOT NULL DEFAULT '',
  ADD COLUMN agreement_text text NOT NULL DEFAULT '',
  ADD COLUMN payer_name text NOT NULL DEFAULT '',
  ADD COLUMN contract_reference text NOT NULL DEFAULT '',
  ADD COLUMN vehicle_label text NOT NULL DEFAULT '',
  ADD COLUMN bank_transaction_id uuid REFERENCES public.bank_transactions(id),
  ADD COLUMN receipt_id uuid REFERENCES public.payment_receipts(id);
UPDATE public.vietqr_requests SET expires_at=created_at+interval '15 minutes',
  replace_available_at=created_at+interval '60 seconds', transfer_content=qr_reference;
ALTER TABLE public.vietqr_requests ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp()+interval '15 minutes'),
  ALTER COLUMN replace_available_at SET NOT NULL,
  ALTER COLUMN replace_available_at SET DEFAULT (clock_timestamp()+interval '60 seconds');
ALTER TABLE public.vietqr_requests DROP CONSTRAINT vietqr_requests_status_check;
ALTER TABLE public.vietqr_requests ADD CONSTRAINT vietqr_requests_status_check
  CHECK(status IN ('PENDING','RECEIVED','CONFIRMED','EXPIRED','CANCELLED'));
UPDATE public.vietqr_requests SET status='EXPIRED',updated_at=clock_timestamp()
  WHERE status='PENDING' AND expires_at<=clock_timestamp();
CREATE UNIQUE INDEX vietqr_verified_bank_identity ON public.vietqr_requests(bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;
ALTER TABLE public.bank_transactions ADD COLUMN account_number text NOT NULL DEFAULT '';
ALTER TABLE public.bank_transactions DROP CONSTRAINT bank_transactions_status_check;
ALTER TABLE public.bank_transactions ADD CONSTRAINT bank_transactions_status_check
  CHECK(status IN ('UNMATCHED','MATCHED_PENDING','MANUAL_REVIEW','RECEIVED','RECORDED','IGNORED'));
ALTER TABLE public.bank_transactions DROP CONSTRAINT bank_transactions_match_reason_check;
ALTER TABLE public.bank_transactions ADD CONSTRAINT bank_transactions_match_reason_check CHECK(match_reason IN (
  '', 'REFERENCE_AMOUNT_MATCH','AMOUNT_MISMATCH','REQUEST_NOT_PENDING','REFERENCE_FOUND_NO_REQUEST',
  'NO_REFERENCE','MANUAL_LINK','AUTO_MATCH_DISABLED','REQUEST_EXPIRED','TRANSFER_OUTSIDE_WINDOW',
  'ACCOUNT_SNAPSHOT_MISMATCH','DUPLICATE_REQUEST_CREDIT','AMBIGUOUS_REFERENCE','RECORDING_REVIEW_REQUIRED'));

CREATE OR REPLACE FUNCTION private.generate_vietqr_reference() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_value text := nextval('private.vietqr_ref_seq')::text;
BEGIN
  -- lpad(value,5) truncates after 99,999. Retain the entire sequence value.
  RETURN 'CAREM GD'||lpad(v_value,greatest(5,length(v_value)),'0');
END $$;

CREATE FUNCTION private.vietqr_name_key(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT upper(regexp_replace(btrim(coalesce(p_name,'')),'[[:space:]]+',' ','g'));
$$;
CREATE FUNCTION private.vietqr_response(p_request public.vietqr_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT to_jsonb(p_request)||jsonb_build_object('server_now',clock_timestamp(),
   'monitoring_available',coalesce((SELECT s.bank_webhook_enabled AND s.bank_auto_match_enabled
     AND s.bank_provider IN ('SEPAY','CASSO') AND s.bank_account_no=p_request.bank_account_no AND s.bank_bin=p_request.bank_bin
     FROM public.system_settings s WHERE s.id),false));
$$;

CREATE OR REPLACE FUNCTION public.create_vietqr_payment_request(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_actor uuid; v_vehicle public.vehicles; v_sale public.sales; v_settings public.system_settings;
 v_existing public.vietqr_requests; v_request public.vietqr_requests;
 v_vehicle_id uuid; v_sale_id uuid; v_replace uuid; v_amount bigint; v_paid bigint;
 v_ref text; v_payer text; v_contract text; v_content text; v_now timestamptz;
 v_superseded boolean := false;
BEGIN
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 v_actor:=auth.uid();
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 v_sale_id:=nullif(p_data->>'sale_id','')::uuid;
 v_vehicle_id:=nullif(p_data->>'vehicle_id','')::uuid;
 v_replace:=nullif(p_data->>'replace_request_id','')::uuid;
 v_amount:=private.money_input(p_data,'amount');
 IF v_amount IS NULL OR v_amount<=0 THEN RAISE EXCEPTION 'INVALID_PAYMENT_AMOUNT'; END IF;
 IF v_replace IS NOT NULL THEN
   SELECT * INTO v_existing FROM public.vietqr_requests WHERE id=v_replace;
   IF NOT FOUND THEN RAISE EXCEPTION 'VIETQR_REQUEST_NOT_FOUND'; END IF;
   v_vehicle_id:=v_existing.vehicle_id; v_sale_id:=v_existing.sale_id;
 END IF;
 IF v_sale_id IS NOT NULL THEN
   SELECT vehicle_id INTO v_vehicle_id FROM public.sales WHERE id=v_sale_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'SALE_NOT_FOUND'; END IF;
 END IF;
 IF v_vehicle_id IS NULL THEN RAISE EXCEPTION 'VEHICLE_REQUIRED'; END IF;
 -- Rate checks and issuance are one serialized transaction across the whole store.
 PERFORM pg_catalog.pg_advisory_xact_lock(20261014,4);
 SELECT * INTO v_vehicle FROM public.vehicles WHERE id=v_vehicle_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND'; END IF;
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 IF v_sale_id IS NOT NULL THEN
   SELECT * INTO v_sale FROM public.sales WHERE id=v_sale_id FOR UPDATE;
   IF v_sale.status<>'COMPLETED' THEN RAISE EXCEPTION 'SALE_CANCELLED'; END IF;
   IF private.current_role()<>'OWNER' AND NOT private.money_disclosable(v_sale.sale_price_visibility)
     THEN RAISE EXCEPTION USING errcode='42501',message='PAYMENT_OWNER_REQUIRED'; END IF;
   SELECT private.safe_money(coalesce(sum(amount),0)) INTO v_paid FROM public.payments
     WHERE sale_id=v_sale_id AND status='ACTIVE';
   IF v_paid+v_amount>v_sale.sale_price THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_BALANCE'; END IF;
 ELSE
   IF v_vehicle.status NOT IN ('IN_STOCK','RESERVED') THEN RAISE EXCEPTION 'VEHICLE_NOT_AVAILABLE'; END IF;
 END IF;
 SELECT * INTO v_settings FROM public.system_settings WHERE id FOR SHARE;
 IF NOT FOUND OR NOT v_settings.vietqr_enabled OR btrim(v_settings.bank_bin)=''
   OR btrim(v_settings.bank_account_no)='' OR btrim(v_settings.bank_account_name)=''
   THEN RAISE EXCEPTION 'VIETQR_NOT_CONFIGURED'; END IF;
 v_payer:=left(btrim(coalesce(nullif(p_data->>'payer_name',''),v_sale.customer_name,'')),200);
 IF v_sale_id IS NULL AND v_payer='' THEN RAISE EXCEPTION 'VIETQR_PAYER_REQUIRED'; END IF;
 v_contract:=coalesce(v_sale.sale_code,'HD-'||v_vehicle.internal_code);
 SELECT * INTO v_existing FROM public.vietqr_requests
 WHERE vehicle_id=v_vehicle_id AND sale_id IS NOT DISTINCT FROM v_sale_id
 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
 v_now:=clock_timestamp();
 IF FOUND AND v_existing.status='PENDING' AND v_existing.expires_at<=v_now THEN
   UPDATE public.vietqr_requests SET status='EXPIRED',updated_at=v_now WHERE id=v_existing.id RETURNING * INTO v_existing;
 END IF;
 IF v_existing.id IS NOT NULL THEN
   IF v_existing.status='RECEIVED' THEN
     IF v_replace IS NOT NULL OR v_existing.amount<>v_amount
       OR private.vietqr_name_key(v_payer) IS DISTINCT FROM private.vietqr_name_key(v_existing.payer_name)
       THEN RAISE EXCEPTION 'VIETQR_FUNDS_ALREADY_RECEIVED'; END IF;
     RETURN private.vietqr_response(v_existing)||jsonb_build_object('superseded',false);
   END IF;
   IF v_replace IS NULL AND v_existing.status IN ('PENDING','EXPIRED') THEN
     IF v_existing.amount<>v_amount OR private.vietqr_name_key(v_existing.payer_name) IS DISTINCT FROM private.vietqr_name_key(v_payer)
       OR v_existing.bank_account_no<>v_settings.bank_account_no OR v_existing.bank_bin<>v_settings.bank_bin
       THEN RAISE EXCEPTION 'VIETQR_REPLACE_REQUIRED'; END IF;
     RETURN private.vietqr_response(v_existing)||jsonb_build_object('superseded',false);
   END IF;
   IF v_replace IS NOT NULL AND v_replace<>v_existing.id THEN RAISE EXCEPTION 'VIETQR_REPLACEMENT_CONFLICT'; END IF;
   IF v_replace IS NOT NULL AND v_existing.status NOT IN ('PENDING','EXPIRED','CANCELLED') THEN RAISE EXCEPTION 'VIETQR_FUNDS_ALREADY_RECEIVED'; END IF;
   IF v_existing.replace_available_at>v_now THEN RAISE EXCEPTION 'VIETQR_REPLACEMENT_COOLDOWN'; END IF;
 END IF;
 IF (SELECT count(*) FROM public.vietqr_requests WHERE vehicle_id=v_vehicle_id AND created_at>v_now-interval '1 hour')>=6
   OR (SELECT count(*) FROM public.vietqr_requests WHERE created_by=v_actor AND created_at>v_now-interval '1 hour')>=60
   OR (SELECT count(*) FROM public.vietqr_requests WHERE created_at>v_now-interval '1 hour')>=300
   THEN RAISE EXCEPTION 'VIETQR_RATE_LIMITED'; END IF;
 IF v_existing.id IS NOT NULL AND v_existing.status IN ('PENDING','EXPIRED') THEN
   UPDATE public.vietqr_requests SET status='CANCELLED',cancelled_by=v_actor,cancelled_at=v_now,
     cancellation_reason='REPLACED_BY_NEW_REQUEST',updated_at=v_now WHERE id=v_existing.id;
   v_superseded:=true;
   PERFORM private.audit('CANCEL_VIETQR_PAYMENT_REQUEST','vietqr_requests',v_existing.id,
     to_jsonb(v_existing),jsonb_build_object('reason','REPLACED_BY_NEW_REQUEST'),v_vehicle_id);
 END IF;
 v_ref:=private.generate_vietqr_reference();
 -- Compact fixed bank memo. Full names and identifiers are kept in the agreement.
 v_content:=v_ref||' XE'||right(v_vehicle.internal_code,6)||' HD'||right(v_contract,6)||' '
   ||left(regexp_replace(private.vietqr_name_key(v_payer),'[^A-Z0-9]','','g'),2)||' CHO '
   ||left(regexp_replace(private.vietqr_name_key(v_settings.bank_account_name),'[^A-Z0-9]','','g'),2)
   ||CASE WHEN v_settings.bank_provider='SEPAY' AND v_settings.bank_bin='970415' THEN ' SEVQR' ELSE '' END;
 IF length(v_content)>50 THEN RAISE EXCEPTION 'VIETQR_CONTENT_TOO_LONG'; END IF;
 INSERT INTO public.vietqr_requests(qr_reference,vehicle_id,sale_id,amount,bank_bin,bank_name,bank_account_no,
   bank_account_name,qr_payload,created_by,created_at,updated_at,expires_at,replace_available_at,
   transfer_content,payer_name,contract_reference,vehicle_label,agreement_text)
 VALUES(v_ref,v_vehicle_id,v_sale_id,v_amount,v_settings.bank_bin,v_settings.bank_name,v_settings.bank_account_no,
   v_settings.bank_account_name,'',v_actor,v_now,v_now,v_now+interval '15 minutes',v_now+interval '60 seconds',
   v_content,v_payer,v_contract,private.vehicle_label_text(v_vehicle.license_plate,v_vehicle.frame_number,v_vehicle.internal_code),
   coalesce(nullif(v_payer,''),'Người thanh toán')||' đồng ý thanh toán cho '||v_settings.bank_account_name
     ||' tiền xe '||coalesce((SELECT name FROM public.vehicle_types WHERE id=v_vehicle.vehicle_type_id),'')
     ||' · '||v_vehicle.internal_code||' · '||coalesce(nullif(v_vehicle.license_plate,''),v_vehicle.frame_number)
     ||' · hợp đồng '||v_contract||' · '||v_ref)
 RETURNING * INTO v_request;
 PERFORM private.audit('CREATE_VIETQR_PAYMENT_REQUEST','vietqr_requests',v_request.id,null,to_jsonb(v_request),v_vehicle_id);
 RETURN private.vietqr_response(v_request)||jsonb_build_object('superseded',v_superseded);
END $$;

CREATE FUNCTION public.replace_vietqr_payment_request(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF nullif(p_data->>'replace_request_id','') IS NULL THEN RAISE EXCEPTION 'VIETQR_REQUEST_NOT_FOUND'; END IF;
 RETURN public.create_vietqr_payment_request(p_data);
END $$;

CREATE OR REPLACE FUNCTION public.get_vietqr_payment_request(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_req public.vietqr_requests;
BEGIN
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 UPDATE public.vietqr_requests SET status='EXPIRED',updated_at=clock_timestamp()
   WHERE id=p_id AND status='PENDING' AND expires_at<=clock_timestamp();
 SELECT * INTO v_req FROM public.vietqr_requests WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'VIETQR_REQUEST_NOT_FOUND'; END IF;
 RETURN private.vietqr_response(v_req);
END $$;
ALTER FUNCTION public.get_vietqr_payment_request(jsonb) VOLATILE;
CREATE OR REPLACE FUNCTION public.get_active_vietqr_request(p_vehicle_id uuid,p_sale_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 SELECT id INTO v_id FROM public.vietqr_requests WHERE vehicle_id=p_vehicle_id
   AND sale_id IS NOT DISTINCT FROM p_sale_id AND status IN ('PENDING','EXPIRED','RECEIVED')
   ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN public.get_vietqr_payment_request(v_id);
END $$;

-- This is the sole automatic ledger path. It first creates immutable bank evidence,
-- then a receipt and payment together. Caller payloads cannot manufacture evidence.
CREATE FUNCTION private.record_vietqr_bank_credit(p_qr_id uuid,p_transaction_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_req public.vietqr_requests; v_txn public.bank_transactions; v_sale public.sales;
 v_actor uuid; v_paid bigint; v_payment uuid; v_date date; v_proof text;
BEGIN
 SELECT * INTO v_req FROM public.vietqr_requests WHERE id=p_qr_id FOR UPDATE;
 SELECT * INTO v_txn FROM public.bank_transactions WHERE id=p_transaction_id FOR UPDATE;
 IF v_req.id IS NULL OR v_txn.id IS NULL OR v_txn.qr_request_id IS DISTINCT FROM v_req.id
   OR v_txn.amount<>v_req.amount OR v_txn.account_number<>v_req.bank_account_no
   OR v_txn.reference<>v_req.qr_reference OR v_txn.match_reason<>'REFERENCE_AMOUNT_MATCH'
   OR v_txn.transfer_at<date_trunc('second',v_req.created_at) OR v_txn.transfer_at>=v_req.expires_at
   OR v_txn.transfer_at>clock_timestamp()+interval '30 seconds'
   OR v_req.status='CANCELLED' THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
 IF v_req.bank_transaction_id IS NOT NULL AND v_req.bank_transaction_id<>v_txn.id
   THEN RAISE EXCEPTION 'BANK_TRANSACTION_ALREADY_LINKED'; END IF;
 IF v_req.status='CONFIRMED' THEN RETURN v_req.payment_id; END IF;
 IF v_req.sale_id IS NULL THEN
   UPDATE public.vietqr_requests SET status='RECEIVED',bank_transaction_id=v_txn.id,
     confirmed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=v_req.id;
   UPDATE public.bank_transactions SET status='RECEIVED',confirmed_at=clock_timestamp() WHERE id=v_txn.id;
   PERFORM private.audit('BANK_TRANSACTION_MATCHED','bank_transactions',v_txn.id,null,
     jsonb_build_object('status','RECEIVED','qr_request_id',v_req.id,'reference',v_req.qr_reference),v_req.vehicle_id);
   RETURN NULL;
 END IF;
 SELECT * INTO v_sale FROM public.sales WHERE id=v_req.sale_id FOR UPDATE;
 IF NOT FOUND OR v_sale.status<>'COMPLETED' OR v_sale.vehicle_id<>v_req.vehicle_id THEN RAISE EXCEPTION 'SALE_CANCELLED'; END IF;
 SELECT private.safe_money(coalesce(sum(amount),0)) INTO v_paid FROM public.payments
   WHERE sale_id=v_sale.id AND status='ACTIVE';
 IF v_paid+v_req.amount>v_sale.sale_price THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_BALANCE'; END IF;
 v_actor:=coalesce(auth.uid(),v_req.created_by);
 v_date:=greatest(v_sale.sale_date,(v_txn.transfer_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);
 IF v_date>private.today() THEN RAISE EXCEPTION 'INVALID_PAYMENT_DATE'; END IF;
 v_payment:=v_txn.id;
 v_proof:='Webhook authenticated · '||v_txn.provider||' · '||v_txn.provider_txn_id;
 INSERT INTO public.payment_receipts(id,sale_id,amount,payment_method,payment_date,reference,notes,
   evidence_kind,evidence_scope,evidence_reference,created_by,verification_reference)
 VALUES(v_txn.id,v_sale.id,v_req.amount,'BANK_TRANSFER',v_date,v_req.qr_reference,v_req.agreement_text,
   'BANK_TRANSACTION',upper(v_txn.account_number),upper(v_txn.provider||':'||v_txn.provider_txn_id),v_actor,v_proof);
 INSERT INTO public.payments(id,sale_id,amount,payment_method,payment_date,reference,notes,created_by)
 VALUES(v_payment,v_sale.id,v_req.amount,'BANK_TRANSFER',v_date,v_req.qr_reference,v_req.agreement_text,v_actor);
 UPDATE public.payment_receipts SET status='RECORDED',payment_id=v_payment,
   verified_at=clock_timestamp() WHERE id=v_txn.id;
 UPDATE public.vietqr_requests SET status='CONFIRMED',bank_transaction_id=v_txn.id,receipt_id=v_txn.id,
   payment_id=v_payment,confirmed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=v_req.id;
 UPDATE public.bank_transactions SET status='RECORDED',payment_id=v_payment,sale_id=v_sale.id,
   confirmed_at=clock_timestamp() WHERE id=v_txn.id;
 PERFORM private.audit('CREATE_PAYMENT','payments',v_payment,null,
   jsonb_build_object('sale_id',v_sale.id,'amount',v_req.amount,'payment_method','BANK_TRANSFER','bank_transaction_id',v_txn.id),v_req.vehicle_id);
 PERFORM private.audit('VERIFY_PAYMENT_RECEIPT','payment_receipts',v_txn.id,null,
   jsonb_build_object('status','RECORDED','payment_id',v_payment,'evidence_kind','BANK_TRANSACTION','verification_reference',v_proof),v_req.vehicle_id);
 PERFORM private.audit('BANK_TRANSACTION_RECORDED','bank_transactions',v_txn.id,null,
   jsonb_build_object('payment_id',v_payment,'qr_request_id',v_req.id,'reference',v_req.qr_reference,'sale_id',v_sale.id),v_req.vehicle_id);
 RETURN v_payment;
END $$;

CREATE OR REPLACE FUNCTION public.ingest_bank_transaction(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_settings public.system_settings; v_provider text; v_txn_id text; v_amount bigint; v_content text;
 v_account text; v_transfer_at timestamptz; v_req public.vietqr_requests; v_txn public.bank_transactions;
 v_code text; v_matches text[]; v_count integer; v_status text:='UNMATCHED'; v_reason text:='NO_REFERENCE';
BEGIN
 IF NOT private.is_service_role() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 v_provider:=upper(btrim(coalesce(p_data->>'provider',''))); v_txn_id:=btrim(coalesce(p_data->>'provider_txn_id',''));
 v_amount:=private.money_input(p_data,'amount'); v_content:=left(btrim(coalesce(p_data->>'transfer_content','')),240);
 v_account:=btrim(coalesce(p_data->>'account_number',''));
 v_transfer_at:=coalesce(nullif(p_data->>'transfer_at','')::timestamptz,clock_timestamp());
 IF v_provider NOT IN ('SEPAY','CASSO') OR length(v_txn_id) NOT BETWEEN 1 AND 80
   OR lower(coalesce(p_data->>'direction',''))<>'in' OR v_amount IS NULL OR v_amount<=0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 SELECT * INTO v_settings FROM public.system_settings WHERE id FOR SHARE;
 IF NOT FOUND OR NOT v_settings.bank_webhook_enabled OR v_settings.bank_provider='' OR v_settings.bank_account_no=''
   THEN RAISE EXCEPTION 'BANK_WEBHOOK_NOT_CONFIGURED'; END IF;
 IF v_provider<>v_settings.bank_provider THEN RAISE EXCEPTION 'BANK_PROVIDER_MISMATCH'; END IF;
 IF v_account<>btrim(v_settings.bank_account_no) THEN RAISE EXCEPTION 'BANK_ACCOUNT_MISMATCH'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_provider||':'||v_txn_id,20261014));
 SELECT * INTO v_txn FROM public.bank_transactions WHERE provider=v_provider AND provider_txn_id=v_txn_id;
 IF FOUND THEN RETURN jsonb_build_object('id',v_txn.id,'status',v_txn.status,'duplicate',true); END IF;
 SELECT count(*),min(m[1]) INTO v_count,v_code FROM regexp_matches(upper(v_content),
   'CAREM[[:space:]._-]*GD[[:space:]._-]*([0-9]{5,18})(?![0-9])','g') m;
 IF v_count=1 THEN
   v_code:='CAREM GD'||v_code;
   SELECT * INTO v_req FROM public.vietqr_requests WHERE qr_reference=v_code;
   IF FOUND THEN
     -- Use the same vehicle -> sale -> QR -> bank ordering as sale writes.
     PERFORM 1 FROM public.vehicles WHERE id=v_req.vehicle_id FOR UPDATE;
     IF v_req.sale_id IS NOT NULL THEN PERFORM 1 FROM public.sales WHERE id=v_req.sale_id FOR UPDATE; END IF;
     SELECT * INTO v_req FROM public.vietqr_requests WHERE id=v_req.id FOR UPDATE;
     v_status:='MANUAL_REVIEW';
     IF v_req.bank_account_no<>v_account OR v_req.bank_bin<>v_settings.bank_bin THEN v_reason:='ACCOUNT_SNAPSHOT_MISMATCH';
     ELSIF v_req.status NOT IN ('PENDING','EXPIRED') THEN v_reason:='REQUEST_NOT_PENDING';
     ELSIF v_transfer_at<date_trunc('second',v_req.created_at) OR v_transfer_at>=v_req.expires_at
       OR v_transfer_at>clock_timestamp()+interval '30 seconds' THEN v_reason:='TRANSFER_OUTSIDE_WINDOW';
     ELSIF v_req.amount<>v_amount THEN v_reason:='AMOUNT_MISMATCH';
     ELSIF EXISTS(SELECT 1 FROM public.bank_transactions WHERE qr_request_id=v_req.id AND status IN ('MATCHED_PENDING','RECEIVED','RECORDED'))
       THEN v_reason:='DUPLICATE_REQUEST_CREDIT';
     ELSIF NOT v_settings.bank_auto_match_enabled THEN v_reason:='AUTO_MATCH_DISABLED';
     ELSE v_status:='MATCHED_PENDING'; v_reason:='REFERENCE_AMOUNT_MATCH'; END IF;
   ELSE v_reason:='REFERENCE_FOUND_NO_REQUEST'; END IF;
 ELSIF v_count>1 THEN v_reason:='AMBIGUOUS_REFERENCE'; v_status:='MANUAL_REVIEW'; v_code:='';
 ELSE v_code:=''; END IF;
 INSERT INTO public.bank_transactions(provider,provider_txn_id,amount,transfer_at,reference,transfer_content,
   sender_name,sender_bank,status,match_reason,qr_request_id,sale_id,vehicle_id,raw_payload,account_number)
 VALUES(v_provider,v_txn_id,v_amount,v_transfer_at,coalesce(v_code,''),v_content,
   left(btrim(coalesce(p_data->>'sender_name','')),120),left(upper(btrim(coalesce(p_data->>'sender_bank',''))),40),
   v_status,v_reason,v_req.id,v_req.sale_id,v_req.vehicle_id,coalesce(p_data->'raw','{}'::jsonb),v_account)
 RETURNING * INTO v_txn;
 IF v_status='MATCHED_PENDING' THEN
   BEGIN
     PERFORM private.record_vietqr_bank_credit(v_req.id,v_txn.id);
   EXCEPTION WHEN OTHERS THEN
     -- Retain the actual credit even when the sale changed or evidence conflicts.
     UPDATE public.bank_transactions SET status='MANUAL_REVIEW',match_reason='RECORDING_REVIEW_REQUIRED' WHERE id=v_txn.id;
   END;
   SELECT * INTO v_txn FROM public.bank_transactions WHERE id=v_txn.id;
 ELSE
   PERFORM private.audit(CASE WHEN v_status='MANUAL_REVIEW' THEN 'BANK_TRANSACTION_REVIEW' ELSE 'BANK_TRANSACTION_UNMATCHED' END,
     'bank_transactions',v_txn.id,null,jsonb_build_object('status',v_txn.status,'match_reason',v_txn.match_reason,
       'qr_request_id',v_txn.qr_request_id,'reference',v_txn.reference),v_txn.vehicle_id);
 END IF;
 RETURN jsonb_build_object('id',v_txn.id,'status',v_txn.status);
END $$;

-- Legacy callers may acknowledge a verified receipt, but can never create one.
CREATE OR REPLACE FUNCTION public.confirm_vietqr_payment(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_req public.vietqr_requests;
BEGIN
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 SELECT * INTO v_req FROM public.vietqr_requests WHERE id=nullif(p_data->>'qr_request_id','')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'VIETQR_REQUEST_NOT_FOUND'; END IF;
 IF v_req.status NOT IN ('RECEIVED','CONFIRMED') OR v_req.bank_transaction_id IS NULL THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
 RETURN v_req.payment_id;
END $$;
CREATE OR REPLACE FUNCTION public.confirm_bank_transaction(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_txn public.bank_transactions; v_req public.vietqr_requests;
BEGIN
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 SELECT * INTO v_txn FROM public.bank_transactions WHERE id=nullif(p_data->>'id','')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND'; END IF;
 IF v_txn.status IN ('RECORDED','RECEIVED') THEN
   RETURN jsonb_build_object('id',v_txn.id,'status',v_txn.status,'payment_id',v_txn.payment_id);
 END IF;
 IF v_txn.qr_request_id IS NULL THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
 SELECT * INTO v_req FROM public.vietqr_requests WHERE id=v_txn.qr_request_id;
 PERFORM 1 FROM public.vehicles WHERE id=v_req.vehicle_id FOR UPDATE;
 IF v_req.sale_id IS NOT NULL THEN PERFORM 1 FROM public.sales WHERE id=v_req.sale_id FOR UPDATE; END IF;
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 IF v_txn.match_reason<>'REFERENCE_AMOUNT_MATCH' THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
 PERFORM private.record_vietqr_bank_credit(v_req.id,v_txn.id);
 SELECT * INTO v_txn FROM public.bank_transactions WHERE id=v_txn.id;
 RETURN jsonb_build_object('id',v_txn.id,'status',v_txn.status,'payment_id',v_txn.payment_id);
END $$;

-- Manual linking remains a review action and follows the common lock ordering.
ALTER FUNCTION public.link_bank_transaction(jsonb) RENAME TO link_bank_transaction_before_qr_lifecycle;
ALTER FUNCTION public.link_bank_transaction_before_qr_lifecycle(jsonb) SET SCHEMA private;
CREATE FUNCTION public.link_bank_transaction(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_req public.vietqr_requests;
BEGIN
 IF NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='ACCESS_DENIED'; END IF;
 SELECT * INTO v_req FROM public.vietqr_requests WHERE
   id=nullif(p_data->>'qr_request_id','')::uuid OR qr_reference=upper(nullif(btrim(p_data->>'reference'),''));
 IF v_req.id IS NOT NULL THEN
   PERFORM 1 FROM public.vehicles WHERE id=v_req.vehicle_id FOR UPDATE;
   IF v_req.sale_id IS NOT NULL THEN PERFORM 1 FROM public.sales WHERE id=v_req.sale_id FOR UPDATE; END IF;
 END IF;
 RETURN private.link_bank_transaction_before_qr_lifecycle(p_data);
END $$;

CREATE OR REPLACE FUNCTION public.get_vietqr_matching_status(p_qr_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_request jsonb; v_txn public.bank_transactions;
BEGIN
 v_request:=public.get_vietqr_payment_request(p_qr_request_id);
 SELECT * INTO v_txn FROM public.bank_transactions WHERE qr_request_id=p_qr_request_id AND status<>'IGNORED'
   ORDER BY (id=nullif(v_request->>'bank_transaction_id','')::uuid) DESC NULLS LAST,received_at DESC LIMIT 1;
 RETURN jsonb_build_object('state',CASE v_txn.status WHEN 'RECEIVED' THEN 'RECEIVED' WHEN 'RECORDED' THEN 'RECORDED'
     WHEN 'MATCHED_PENDING' THEN 'MATCHED' WHEN 'MANUAL_REVIEW' THEN 'REVIEW' ELSE 'NONE' END,
   'qr_status',v_request->>'status','bank_received',(v_request->>'status') IN ('RECEIVED','CONFIRMED') AND v_request->>'bank_transaction_id' IS NOT NULL,
   'monitoring_available',v_request->'monitoring_available','expires_at',v_request->'expires_at','server_now',v_request->'server_now',
   'bank_transaction_id',v_txn.id,'payment_id',v_request->'payment_id','sender_name',coalesce(v_txn.sender_name,''),'transfer_at',v_txn.transfer_at);
END $$;

-- Preserve the public sale operation receipt wrapper and all below-cost checks.
ALTER FUNCTION private.sell_vehicle_impl(jsonb) RENAME TO sell_vehicle_before_verified_qr_impl;
CREATE FUNCTION private.sell_vehicle_impl(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_qr uuid:=nullif(p_data->>'vietqr_request_id','')::uuid; v_req public.vietqr_requests; v_sale uuid;
BEGIN
 PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
 IF v_qr IS NULL THEN
   IF coalesce(p_data->>'payment_method','')='BANK_TRANSFER' AND private.money_input(p_data,'initial_payment',0)>0
     THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
   RETURN private.sell_vehicle_before_verified_qr_impl(p_data);
 END IF;
 PERFORM 1 FROM public.vehicles WHERE id=(p_data->>'vehicle_id')::uuid FOR UPDATE;
 SELECT * INTO v_req FROM public.vietqr_requests WHERE id=v_qr FOR UPDATE;
 IF v_req.id IS NULL OR v_req.status<>'RECEIVED' OR v_req.sale_id IS NOT NULL OR v_req.bank_transaction_id IS NULL
   THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
 IF v_req.vehicle_id IS DISTINCT FROM (p_data->>'vehicle_id')::uuid
   OR v_req.amount IS DISTINCT FROM private.money_input(p_data,'initial_payment')
   OR coalesce(p_data->>'payment_method','')<>'BANK_TRANSFER'
   OR private.vietqr_name_key(v_req.payer_name) IS DISTINCT FROM private.vietqr_name_key(p_data->>'customer_name')
   THEN RAISE EXCEPTION 'VIETQR_SALE_BINDING_MISMATCH'; END IF;
 v_sale:=private.sell_vehicle_before_verified_qr_impl(p_data||jsonb_build_object('initial_payment',0));
 UPDATE public.vietqr_requests SET sale_id=v_sale WHERE id=v_req.id;
 PERFORM private.record_vietqr_bank_credit(v_req.id,v_req.bank_transaction_id);
 RETURN v_sale;
END $$;

REVOKE ALL ON FUNCTION private.vietqr_name_key(text),private.vietqr_response(public.vietqr_requests),
  private.record_vietqr_bank_credit(uuid,uuid),private.sell_vehicle_before_verified_qr_impl(jsonb),
  private.sell_vehicle_impl(jsonb),private.link_bank_transaction_before_qr_lifecycle(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.replace_vietqr_payment_request(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.replace_vietqr_payment_request(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.link_bank_transaction(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_bank_transaction(jsonb) TO authenticated;
-- Retain ingest as the only trusted entry point for authenticated provider events.
REVOKE ALL ON FUNCTION public.ingest_bank_transaction(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_bank_transaction(jsonb) TO service_role;
COMMIT;
