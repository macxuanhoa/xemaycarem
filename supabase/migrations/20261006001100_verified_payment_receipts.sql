BEGIN;

-- Proposals never change balances. A manager verifies physical evidence before
-- recording money. No backfill or inference from equal amounts/dates.
CREATE TABLE public.payment_receipts (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES public.sales(id),
  amount bigint NOT NULL CHECK (amount > 0),
  payment_method public.payment_method NOT NULL,
  payment_date date NOT NULL,
  reference text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  evidence_kind text CHECK (evidence_kind IN ('BANK_TRANSACTION','CASH_VOUCHER','MANUAL_RECONCILIATION')),
  evidence_scope text NOT NULL DEFAULT '',
  evidence_reference text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RECORDED','REJECTED')),
  payment_id uuid UNIQUE REFERENCES public.payments(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  verified_by uuid REFERENCES public.profiles(id),
  verification_reference text,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz,
  CHECK ((evidence_kind IS NULL AND evidence_scope='' AND evidence_reference='') OR
    (evidence_kind IS NOT NULL AND length(evidence_scope) BETWEEN 1 AND 120 AND length(evidence_reference) BETWEEN 3 AND 200)),
  CHECK ((status='RECORDED') = (payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX payment_receipts_business_identity ON public.payment_receipts(evidence_kind,evidence_scope,evidence_reference) WHERE evidence_kind IS NOT NULL AND status<>'REJECTED';
CREATE INDEX payment_receipts_sale ON public.payment_receipts(sale_id,created_at);
ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_receipts FROM PUBLIC,anon,authenticated;

CREATE TABLE private.payment_receipt_requests (
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  request_id uuid NOT NULL,
  receipt_id uuid NOT NULL REFERENCES public.payment_receipts(id),
  payload_hash bytea NOT NULL,
  PRIMARY KEY(actor_id,request_id)
);
ALTER TABLE private.payment_receipt_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.payment_receipt_requests FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.prepare_payment_receipt(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_id uuid := nullif(p_data->>'request_id','')::uuid;
  v_sale_id uuid := (p_data->>'sale_id')::uuid;
  v_amount bigint := private.money_input(p_data,'amount');
  v_method public.payment_method := (p_data->>'payment_method')::public.payment_method;
  v_date date := coalesce(nullif(p_data->>'payment_date','')::date,private.today());
  v_kind text := nullif(p_data->>'evidence_kind','');
  v_scope text := upper(btrim(coalesce(p_data->>'evidence_scope','')));
  v_reference text := upper(btrim(coalesce(p_data->>'evidence_reference','')));
  v_sale public.sales;
  v_receipt public.payment_receipts;
  v_alias private.payment_receipt_requests;
  v_hash bytea;
BEGIN
  IF v_id IS NULL THEN RAISE EXCEPTION 'CLIENT_UPGRADE_REQUIRED'; END IF;
  IF v_kind IS NULL THEN v_scope := ''; v_reference := ''; END IF;
  IF v_kind IS NOT NULL AND (v_kind NOT IN ('BANK_TRANSACTION','CASH_VOUCHER','MANUAL_RECONCILIATION') OR length(v_scope) NOT BETWEEN 1 AND 120 OR length(v_reference) NOT BETWEEN 3 AND 200) THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_REQUIRED'; END IF;
  IF (v_kind='BANK_TRANSACTION' AND v_method IS DISTINCT FROM 'BANK_TRANSFER') OR (v_kind='CASH_VOUCHER' AND v_method IS DISTINCT FROM 'CASH') THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_REQUIRED'; END IF;
  -- Global business identity serializes across sales without table-wide locks.
  -- Advisory keys are internal: authenticated roles cannot write the registry.
  v_hash := sha256(convert_to(jsonb_build_object('sale_id',v_sale_id,'amount',v_amount,'method',v_method,'date',v_date,'kind',v_kind,'scope',v_scope,'evidence',v_reference,'reference',coalesce(p_data->>'reference',''),'notes',coalesce(p_data->>'notes',''))::text,'UTF8'));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_id::text,0));
  SELECT * INTO v_alias FROM private.payment_receipt_requests WHERE actor_id=v_actor AND request_id=v_id;
  IF FOUND THEN
    PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
    IF v_alias.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CONFLICT'; END IF;
    SELECT * INTO v_receipt FROM public.payment_receipts WHERE id=v_alias.receipt_id;
    RETURN to_jsonb(v_receipt);
  END IF;
  IF v_kind IS NOT NULL THEN PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_kind||':'||v_scope||':'||v_reference,1)); END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  SELECT * INTO v_receipt FROM public.payment_receipts WHERE id=v_id;
  IF NOT FOUND AND v_kind IS NOT NULL THEN
    SELECT * INTO v_receipt FROM public.payment_receipts WHERE evidence_kind=v_kind AND evidence_scope=v_scope AND evidence_reference=v_reference AND status<>'REJECTED';
  END IF;
  IF v_receipt.id IS NOT NULL THEN
    IF v_receipt.sale_id IS DISTINCT FROM v_sale_id OR v_receipt.amount IS DISTINCT FROM v_amount OR v_receipt.payment_method IS DISTINCT FROM v_method OR v_receipt.payment_date IS DISTINCT FROM v_date OR v_receipt.evidence_kind IS DISTINCT FROM v_kind OR v_receipt.evidence_scope IS DISTINCT FROM v_scope OR v_receipt.evidence_reference IS DISTINCT FROM v_reference THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CONFLICT'; END IF;
    INSERT INTO private.payment_receipt_requests VALUES(v_actor,v_id,v_receipt.id,v_hash);
    RETURN to_jsonb(v_receipt);
  END IF;
  SELECT * INTO v_sale FROM public.sales WHERE id=v_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SALE_NOT_FOUND'; END IF;
  IF v_sale.status <> 'COMPLETED' THEN RAISE EXCEPTION 'SALE_CANCELLED'; END IF;
  IF v_date < v_sale.sale_date OR v_date > private.today() THEN RAISE EXCEPTION 'INVALID_PAYMENT_DATE'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'INVALID_PAYMENT_AMOUNT'; END IF;
  INSERT INTO public.payment_receipts(id,sale_id,amount,payment_method,payment_date,reference,notes,evidence_kind,evidence_scope,evidence_reference,created_by)
    VALUES(v_id,v_sale_id,v_amount,v_method,v_date,coalesce(p_data->>'reference',''),coalesce(p_data->>'notes',''),v_kind,v_scope,v_reference,v_actor) RETURNING * INTO v_receipt;
  PERFORM private.audit('PREPARE_PAYMENT_RECEIPT','payment_receipts',v_id,null,to_jsonb(v_receipt),v_sale.vehicle_id);
  INSERT INTO private.payment_receipt_requests VALUES(v_actor,v_id,v_receipt.id,v_hash);
  RETURN to_jsonb(v_receipt);
END $$;

ALTER FUNCTION public.add_payment(jsonb) RENAME TO add_payment_verified_impl;
ALTER FUNCTION public.add_payment_verified_impl(jsonb) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.add_payment_verified_impl(jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.add_payment(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_request uuid := nullif(p_data->>'request_id','')::uuid;
  v_id uuid := nullif(p_data->>'receipt_id','')::uuid;
  v_receipt public.payment_receipts;
  v_vehicle uuid;
  v_result uuid;
  v_proof text := btrim(coalesce(p_data->>'verification_reference',''));
  v_kind text;
  v_scope text;
  v_reference text;
BEGIN
  IF v_request IS NULL OR v_id IS NULL THEN RAISE EXCEPTION 'CLIENT_UPGRADE_REQUIRED'; END IF;
  SELECT s.vehicle_id INTO v_vehicle FROM public.payment_receipts r JOIN public.sales s ON s.id=r.sale_id WHERE r.id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_NOT_FOUND'; END IF;
  -- Same vehicle -> sale -> receipt order as financial mutations/cancellation.
  PERFORM 1 FROM public.vehicles WHERE id=v_vehicle FOR UPDATE;
  PERFORM 1 FROM public.sales s JOIN public.payment_receipts r ON r.sale_id=s.id WHERE r.id=v_id FOR UPDATE OF s;
  SELECT * INTO v_receipt FROM public.payment_receipts WHERE id=v_id FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF (p_data ? 'sale_id' AND (p_data->>'sale_id')::uuid IS DISTINCT FROM v_receipt.sale_id) OR
    (p_data ? 'amount' AND private.money_input(p_data,'amount') IS DISTINCT FROM v_receipt.amount) OR
    (p_data ? 'payment_method' AND (p_data->>'payment_method')::public.payment_method IS DISTINCT FROM v_receipt.payment_method) OR
    (p_data ? 'payment_date' AND (p_data->>'payment_date')::date IS DISTINCT FROM v_receipt.payment_date) THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CONFLICT'; END IF;
  IF v_receipt.status='RECORDED' THEN RETURN v_receipt.payment_id; END IF;
  IF v_receipt.status='REJECTED' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_REJECTED'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  IF length(v_proof) NOT BETWEEN 5 AND 1000 THEN RAISE EXCEPTION 'PAYMENT_VERIFICATION_REQUIRED'; END IF;
  v_kind := coalesce(v_receipt.evidence_kind,nullif(p_data->>'evidence_kind',''));
  v_scope := CASE WHEN v_receipt.evidence_kind IS NOT NULL THEN v_receipt.evidence_scope ELSE upper(btrim(coalesce(p_data->>'evidence_scope',''))) END;
  v_reference := CASE WHEN v_receipt.evidence_kind IS NOT NULL THEN v_receipt.evidence_reference ELSE upper(btrim(coalesce(p_data->>'evidence_reference',''))) END;
  IF v_kind IS NULL OR v_kind NOT IN ('BANK_TRANSACTION','CASH_VOUCHER','MANUAL_RECONCILIATION') OR length(v_scope) NOT BETWEEN 1 AND 120 OR length(v_reference) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_REQUIRED'; END IF;
  IF (v_kind='BANK_TRANSACTION' AND v_receipt.payment_method IS DISTINCT FROM 'BANK_TRANSFER') OR (v_kind='CASH_VOUCHER' AND v_receipt.payment_method IS DISTINCT FROM 'CASH') THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.payment_receipts WHERE evidence_kind=v_kind AND evidence_scope=v_scope AND evidence_reference=v_reference AND id<>v_id AND status<>'REJECTED') THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CONFLICT'; END IF;
  -- Bind before insert: unique business identity wins even across different sales.
  BEGIN
    UPDATE public.payment_receipts SET evidence_kind=v_kind,evidence_scope=v_scope,evidence_reference=v_reference WHERE id=v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CONFLICT';
  END;
  v_result := private.add_payment_verified_impl(jsonb_build_object('sale_id',v_receipt.sale_id,'amount',v_receipt.amount,'payment_method',v_receipt.payment_method,'payment_date',v_receipt.payment_date,'reference',v_reference,'notes',v_receipt.notes,'request_id',v_id));
  UPDATE public.payment_receipts SET status='RECORDED',payment_id=v_result,verified_by=v_actor,verification_reference=v_proof,verified_at=clock_timestamp() WHERE id=v_id RETURNING * INTO v_receipt;
  PERFORM private.audit('VERIFY_PAYMENT_RECEIPT','payment_receipts',v_id,null,to_jsonb(v_receipt),v_vehicle);
  RETURN v_result;
END $$;

CREATE FUNCTION public.list_payment_receipts(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at) FROM public.payment_receipts r WHERE sale_id=p_sale_id),'[]'::jsonb);
END $$;

CREATE FUNCTION public.get_payment_receipt_request(p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_receipt jsonb;
BEGIN
  SELECT to_jsonb(r) INTO v_receipt FROM private.payment_receipt_requests q JOIN public.payment_receipts r ON r.id=q.receipt_id WHERE q.actor_id=v_actor AND q.request_id=p_request_id;
  RETURN jsonb_build_object('confirmed',v_receipt IS NOT NULL,'receipt',v_receipt);
END $$;

CREATE FUNCTION public.reject_payment_receipt(p_id uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]); v_receipt public.payment_receipts;
BEGIN
  IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 5 AND 1000 THEN RAISE EXCEPTION 'PAYMENT_VERIFICATION_REQUIRED'; END IF;
  SELECT * INTO v_receipt FROM public.payment_receipts WHERE id=p_id FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  IF NOT FOUND OR v_receipt.id IS NULL THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_NOT_FOUND'; END IF;
  IF v_receipt.status<>'PENDING' THEN RAISE EXCEPTION 'PAYMENT_RECEIPT_CONFLICT'; END IF;
  UPDATE public.payment_receipts SET status='REJECTED',verified_by=v_actor,rejection_reason=btrim(p_reason),verified_at=clock_timestamp() WHERE id=p_id;
  PERFORM private.audit('REJECT_PAYMENT_RECEIPT','payment_receipts',p_id,to_jsonb(v_receipt),jsonb_build_object('reason',btrim(p_reason)),null);
END $$;

REVOKE ALL ON FUNCTION public.prepare_payment_receipt(jsonb),public.add_payment(jsonb),public.list_payment_receipts(uuid),public.reject_payment_receipt(uuid,text),public.get_payment_receipt_request(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.prepare_payment_receipt(jsonb),public.add_payment(jsonb),public.list_payment_receipts(uuid),public.reject_payment_receipt(uuid,text),public.get_payment_receipt_request(uuid) TO authenticated;
COMMIT;
