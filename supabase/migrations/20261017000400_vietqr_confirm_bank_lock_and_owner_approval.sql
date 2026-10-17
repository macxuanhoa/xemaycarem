-- Migration: 20261017000400_vietqr_confirm_bank_lock_and_owner_approval.sql
-- Mảnh còn thiếu của chốt B (20261017000300 chỉ đặt cổng confirm_vietqr_payment).
--
-- 1) confirm_bank_transaction: bản 20261015000200 bỏ bước giành khóa vehicle→sale
--    trước khi kiểm chứng cứ, nên một khoản lệch tiền "chết sớm" trước cả khi chạm
--    khóa — test "financial access revoked while confirmation waits is rechecked
--    after the database lock" (security-integration) không còn gì để đợi. Phục hồi
--    đúng thứ tự an toàn của 20261014000400: khóa vehicle → sale → qr, KIỂM LẠI
--    quyền tài chính sau khi chờ khóa, rồi mới xét bằng chứng.
-- 2) Cổng bằng chứng phía đối soát: nút "Xác nhận thu tiền" chỉ chấp nhận hai lý do
--    do chính ingest cấp — REFERENCE_AMOUNT_MATCH và PENDING_OWNER_APPROVAL (tiền
--    thật đã về đủ mã + đủ tiền, chỉ khác mã do nhân viên tạo; chủ duyệt là đường
--    nghiệp vụ đã thiết kế). MANUAL_LINK/lệch tiền/hết hạn/trùng → VIETQR_BANK_EVIDENCE_REQUIRED;
--    ghi các khoản đó vẫn đi đường thu thường của đơn (add_payment), chủ quyết + audit.
-- 3) record_vietqr_bank_credit: mở đúng một chốt match_reason cho PENDING_OWNER_APPROVAL
--    để (2) ghi được tiền; mọi kiểm tra còn nguyên (account, reference, số tiền,
--    cửa sổ thời gian, đơn COMPLETED, số dư).
-- Forward-only; chữ ký hàm giữ nguyên nên GRANTS/REVOKE cũ vẫn y hiệu lực.

-- ============================================================
-- 1+2. confirm_bank_transaction: khóa trước, kiểm quyền sau khóa, cổng bằng chứng.
-- ============================================================
CREATE OR REPLACE FUNCTION public.confirm_bank_transaction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_txn public.bank_transactions;
  v_req public.vietqr_requests;
  v_vehicle uuid;
  v_sale uuid;
  v_payment uuid;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions
    WHERE id = nullif(p_data->>'id','')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='BANK_TRANSACTION_NOT_FOUND';
  END IF;

  -- Idempotent: khoản đã ngã ngũ trả nguyên kết quả cũ, không ghi lần hai.
  IF v_txn.status IN ('RECORDED','RECEIVED') THEN
    RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                              'payment_id', v_txn.payment_id);
  END IF;
  IF v_txn.status NOT IN ('MATCHED_PENDING','MANUAL_REVIEW') OR v_txn.qr_request_id IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_NOT_CONFIRMABLE';
  END IF;

  -- Đúng thứ tự khóa mọi writer tài chính: vehicle → sale → qr (chống deadlock).
  SELECT vehicle_id, sale_id INTO v_vehicle, v_sale
    FROM public.vietqr_requests WHERE id = v_txn.qr_request_id;
  PERFORM 1 FROM public.vehicles WHERE id = v_vehicle FOR UPDATE;
  IF v_sale IS NOT NULL THEN
    PERFORM 1 FROM public.sales WHERE id = v_sale FOR UPDATE;
  END IF;
  SELECT * INTO v_req FROM public.vietqr_requests WHERE id = v_txn.qr_request_id FOR UPDATE;
  -- Quyền thu hồi trong lúc chờ khóa phải nhận ACCESS_DENIED, không được ghi tiền.
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;

  IF v_txn.match_reason NOT IN ('REFERENCE_AMOUNT_MATCH','PENDING_OWNER_APPROVAL')
     OR v_txn.amount IS DISTINCT FROM v_req.amount
     OR v_req.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='VIETQR_BANK_EVIDENCE_REQUIRED';
  END IF;

  v_payment := private.record_vietqr_bank_credit(v_req.id, v_txn.id);
  SELECT * INTO v_txn FROM public.bank_transactions WHERE id = v_txn.id;
  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                            'payment_id', coalesce(v_txn.payment_id, v_payment));
END $$;

-- ============================================================
-- 3. record_vietqr_bank_credit: chấp nhận thêm PENDING_OWNER_APPROVAL (webhook đã
--    chứng minh đủ mã + đủ tiền; chỉ khác mã do nhân viên tạo nên không tự ghi).
--    Toàn bộ chốt còn lại giữ nguyên từng chữ so với 20261014000400.
-- ============================================================
CREATE OR REPLACE FUNCTION private.record_vietqr_bank_credit(p_qr_id uuid,p_transaction_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_req public.vietqr_requests; v_txn public.bank_transactions; v_sale public.sales;
 v_actor uuid; v_paid bigint; v_payment uuid; v_date date; v_proof text;
BEGIN
 SELECT * INTO v_req FROM public.vietqr_requests WHERE id=p_qr_id FOR UPDATE;
 SELECT * INTO v_txn FROM public.bank_transactions WHERE id=p_transaction_id FOR UPDATE;
 IF v_req.id IS NULL OR v_txn.id IS NULL OR v_txn.qr_request_id IS DISTINCT FROM v_req.id
   OR v_txn.amount<>v_req.amount OR v_txn.account_number<>v_req.bank_account_no
   OR v_txn.reference<>v_req.qr_reference
   OR v_txn.match_reason NOT IN ('REFERENCE_AMOUNT_MATCH','PENDING_OWNER_APPROVAL')
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
