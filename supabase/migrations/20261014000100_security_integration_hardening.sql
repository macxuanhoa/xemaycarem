-- Forward-only integration repairs: privacy projections, bank verification,

-- approval paging and isolated outbox diagnostics. No business rows are deleted.

BEGIN;

CREATE OR REPLACE FUNCTION public.save_settings(p_data jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old jsonb; v_new jsonb;
  v_from time; v_until time; v_days integer[];
  v_bank_bin text;
  v_bank_name text;
  v_account_no text;
  v_account_name text;
  v_vietqr_enabled boolean;
  v_bank_provider text;
  v_bank_webhook_enabled boolean;
  v_bank_auto_match_enabled boolean;
  v_thankyou_manual_enabled boolean;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
  END IF;

  -- Validate the shared working-time fields before touching the row.
  IF p_data ? 'staff_allowed_from' AND nullif(btrim(coalesce(p_data->>'staff_allowed_from','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_from')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_from := (p_data->>'staff_allowed_from')::time;
  ELSIF p_data ? 'staff_allowed_from' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_allowed_until' AND nullif(btrim(coalesce(p_data->>'staff_allowed_until','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_until')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_until := (p_data->>'staff_allowed_until')::time;
  ELSIF p_data ? 'staff_allowed_until' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_working_days' THEN
    IF jsonb_typeof(p_data->'staff_working_days') <> 'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_data->'staff_working_days') e WHERE e !~ '^[1-7]$') THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (e)::int), ARRAY[]::integer[]) INTO v_days
      FROM jsonb_array_elements_text(p_data->'staff_working_days') e;
  END IF;

  -- Validate VietQR bank settings
  IF p_data ? 'vietqr_enabled' THEN
    v_vietqr_enabled := (p_data->>'vietqr_enabled')::boolean;
  END IF;

  IF p_data ? 'bank_bin' THEN
    v_bank_bin := btrim(coalesce(p_data->>'bank_bin', ''));
    IF length(v_bank_bin) > 10 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_BANK_BIN';
    END IF;
  END IF;

  IF p_data ? 'bank_name' THEN
    v_bank_name := btrim(coalesce(p_data->>'bank_name', ''));
    IF length(v_bank_name) > 100 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_BANK_NAME';
    END IF;
  END IF;

  IF p_data ? 'bank_account_no' THEN
    v_account_no := btrim(coalesce(p_data->>'bank_account_no', ''));
    IF length(v_account_no) > 40 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_ACCOUNT_NO';
    END IF;
  END IF;

  IF p_data ? 'bank_account_name' THEN
    v_account_name := upper(btrim(coalesce(p_data->>'bank_account_name', '')));
    IF length(v_account_name) > 120 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_ACCOUNT_NAME';
    END IF;
  END IF;

  -- Smart Sales Automation settings (V1)
  IF p_data ? 'bank_provider' THEN
    v_bank_provider := upper(btrim(coalesce(p_data->>'bank_provider', '')));
    IF v_bank_provider NOT IN ('', 'SEPAY', 'CASSO') THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_BANK_PROVIDER';
    END IF;
  END IF;
  IF p_data ? 'bank_webhook_enabled' THEN
    v_bank_webhook_enabled := (p_data->>'bank_webhook_enabled')::boolean;
    -- Validate the merged saved configuration after acquiring its row lock below.
  END IF;
  IF p_data ? 'bank_auto_match_enabled' THEN
    v_bank_auto_match_enabled := (p_data->>'bank_auto_match_enabled')::boolean;
  END IF;
  IF p_data ? 'thankyou_manual_enabled' THEN
    v_thankyou_manual_enabled := (p_data->>'thankyou_manual_enabled')::boolean;
  END IF;

  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;

  -- Nếu bật VietQR, yêu cầu phải có đủ thông tin ngân hàng
  IF coalesce(v_vietqr_enabled, (v_old->>'vietqr_enabled')::boolean, false) THEN
    IF nullif(coalesce(v_bank_bin, v_old->>'bank_bin', ''), '') IS NULL
       OR nullif(coalesce(v_account_no, v_old->>'bank_account_no', ''), '') IS NULL
       OR nullif(coalesce(v_account_name, v_old->>'bank_account_name', ''), '') IS NULL THEN
      RAISE EXCEPTION USING errcode='22023',message='VIETQR_CONFIG_REQUIRED';
    END IF;
  END IF;
  -- Webhook chỉ có nghĩa khi webhook VietQR-enabled store có tài khoản nhận tiền.
  IF coalesce(v_bank_webhook_enabled, (v_old->>'bank_webhook_enabled')::boolean, false) THEN
    IF nullif(coalesce(v_bank_provider, v_old->>'bank_provider', ''), '') IS NULL
       OR nullif(coalesce(v_account_no, v_old->>'bank_account_no', ''), '') IS NULL THEN
      RAISE EXCEPTION USING errcode='22023',message='BANK_WEBHOOK_CONFIG_REQUIRED';
    END IF;
  END IF;

  UPDATE public.system_settings SET
    store_name=btrim(coalesce(p_data->>'store_name',store_name)),
    phone=btrim(coalesce(p_data->>'phone',phone)),
    address=btrim(coalesce(p_data->>'address',address)),
    low_stock_threshold=coalesce((p_data->>'low_stock_threshold')::integer,low_stock_threshold),
    high_stock_threshold=coalesce((p_data->>'high_stock_threshold')::integer,high_stock_threshold),
    customer_messaging_enabled=coalesce((p_data->>'customer_messaging_enabled')::boolean,customer_messaging_enabled),
    sale_thank_you_enabled=coalesce((p_data->>'sale_thank_you_enabled')::boolean,sale_thank_you_enabled),
    primary_message_channel=coalesce(p_data->>'primary_message_channel',primary_message_channel),
    fallback_channel=coalesce(p_data->>'fallback_channel',fallback_channel),
    support_phone=btrim(coalesce(p_data->>'support_phone',support_phone)),
    staff_allowed_from=coalesce(v_from,staff_allowed_from),
    staff_allowed_until=coalesce(v_until,staff_allowed_until),
    staff_working_days=coalesce(v_days,staff_working_days),
    bank_bin=coalesce(v_bank_bin, bank_bin),
    bank_name=coalesce(v_bank_name, bank_name),
    bank_account_no=coalesce(v_account_no, bank_account_no),
    bank_account_name=coalesce(v_account_name, bank_account_name),
    vietqr_enabled=coalesce(v_vietqr_enabled, vietqr_enabled),
    bank_provider=coalesce(v_bank_provider, bank_provider),
    bank_webhook_enabled=coalesce(v_bank_webhook_enabled, bank_webhook_enabled),
    bank_auto_match_enabled=coalesce(v_bank_auto_match_enabled, bank_auto_match_enabled),
    thankyou_manual_enabled=coalesce(v_thankyou_manual_enabled, thankyou_manual_enabled),
    updated_by=v_actor,updated_at=now()
  WHERE id RETURNING to_jsonb(system_settings) INTO v_new;

  PERFORM private.audit(
    CASE
      WHEN (v_old->>'bank_bin') IS DISTINCT FROM (v_new->>'bank_bin')
        OR (v_old->>'bank_account_no') IS DISTINCT FROM (v_new->>'bank_account_no')
        OR (v_old->>'bank_account_name') IS DISTINCT FROM (v_new->>'bank_account_name')
        OR (v_old->>'vietqr_enabled') IS DISTINCT FROM (v_new->>'vietqr_enabled')
        OR (v_old->>'bank_provider') IS DISTINCT FROM (v_new->>'bank_provider')
        OR (v_old->>'bank_webhook_enabled') IS DISTINCT FROM (v_new->>'bank_webhook_enabled')
        THEN 'BANK_ACCOUNT_CHANGED'
      WHEN (v_old->>'staff_allowed_from') <> (v_new->>'staff_allowed_from')
        OR (v_old->>'staff_allowed_until') <> (v_new->>'staff_allowed_until')
        OR (v_old->'staff_working_days') <> (v_new->'staff_working_days')
        THEN 'STAFF_SCHEDULE_CHANGED'
      ELSE 'MESSAGE_SETTING_CHANGED'
    END,
    'system_settings',null,v_old,v_new);
END $$;

CREATE OR REPLACE FUNCTION private.is_service_role() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  -- current_user is the function owner under SECURITY DEFINER. SET ROLE survives.
  SELECT current_setting('role', true) = 'service_role' AND auth.role() = 'service_role'
$$;

CREATE OR REPLACE FUNCTION public.ingest_bank_transaction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_settings public.system_settings;
  v_provider text;
  v_txn_id text;
  v_amount bigint;
  v_content text;
  v_sender_name text;
  v_sender_bank text;
  v_transfer_at timestamptz;
  v_existing public.bank_transactions;
  v_txn public.bank_transactions;
  v_request public.vietqr_requests;
  v_code text;
  v_status text := 'UNMATCHED';
  v_reason text := 'NO_REFERENCE';
BEGIN
  IF NOT private.is_service_role() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  v_provider := upper(btrim(coalesce(p_data->>'provider', '')));
  v_txn_id := btrim(coalesce(p_data->>'provider_txn_id', ''));
  v_content := left(btrim(coalesce(p_data->>'transfer_content', '')), 240);
  v_sender_name := left(btrim(coalesce(p_data->>'sender_name', '')), 120);
  v_sender_bank := left(upper(btrim(coalesce(p_data->>'sender_bank', ''))), 40);
  -- private.money_input: chỉ chữ số, tối đa 13 ký tự, chặn > 1.000.000.000.000.
  v_amount := private.money_input(p_data, 'amount');
  v_transfer_at := coalesce(nullif(p_data->>'transfer_at', '')::timestamptz, clock_timestamp());
  IF v_provider NOT IN ('SEPAY', 'CASSO') OR v_txn_id = ''
     OR length(v_txn_id) > 80 OR lower(coalesce(p_data->>'direction', '')) <> 'in'
     OR v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT * INTO v_settings FROM public.system_settings WHERE id FOR SHARE;
  IF NOT FOUND OR NOT v_settings.bank_webhook_enabled
     OR nullif(v_settings.bank_provider, '') IS NULL
     OR nullif(btrim(v_settings.bank_account_no), '') IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_WEBHOOK_NOT_CONFIGURED';
  END IF;
  IF v_provider <> v_settings.bank_provider THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_PROVIDER_MISMATCH';
  END IF;
  IF btrim(coalesce(p_data->>'account_number', '')) <> btrim(v_settings.bank_account_no) THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_ACCOUNT_MISMATCH';
  END IF;
  -- Serialize provider identity before lookup so simultaneous delivery is replayable.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_provider || ':' || v_txn_id, 20261014));

  -- Idempotency chống ghi trùng: giao dịch cùng mã provider đã vào thì trả nguyên trạng.
  SELECT * INTO v_existing FROM public.bank_transactions
    WHERE provider = v_provider AND provider_txn_id = v_txn_id;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_existing.id, 'status', v_existing.status,
                              'duplicate', true);
  END IF;

  -- Trích mã tham chiếu CAREM GDxxxxx từ nội dung chuyển khoản (bỏ mọi ký tự phân tách).
  -- Bắt buộc có tiền tố CAREMGD trong nội dung nén — một mã GD thuần 5 số (rất phổ
  -- biến trong chuyển khoản ngân hàng) không được phép khớp nhầm với yêu cầu VietQR.
  v_code := upper(regexp_replace(v_content, '[^0-9A-Za-z]', '', 'g'));
  IF v_code LIKE '%CAREMGD%' THEN
    v_code := btrim(regexp_replace(v_code, '.*CAREMGD([0-9]{5}).*', '\1'));
    IF v_code ~ '^[0-9]{5}$' THEN
      v_code := 'CAREM GD' || v_code;
    ELSE
      v_code := '';
    END IF;
  ELSE
    v_code := '';
  END IF;

  IF v_code <> '' THEN
    -- Khóa yêu cầu để không hai webhook cùng lúc tranh một QR (đối thủ ghi tiền).
    SELECT * INTO v_request FROM public.vietqr_requests
      WHERE qr_reference = v_code FOR UPDATE;
    IF FOUND THEN
      IF v_request.status = 'PENDING' AND v_request.amount = v_amount
         AND coalesce(v_settings.bank_auto_match_enabled, true) THEN
        v_status := 'MATCHED_PENDING';
        v_reason := 'REFERENCE_AMOUNT_MATCH';
      ELSIF v_request.status = 'PENDING' AND v_request.amount <> v_amount THEN
        -- Đúng mã, sai tiền: Manual Nghi ngờ. Không tiết lộ tiền đúng là bao nhiêu.
        v_status := 'MANUAL_REVIEW';
        v_reason := 'AMOUNT_MISMATCH';
      ELSIF v_request.status = 'PENDING' THEN
        v_status := 'MANUAL_REVIEW';
        v_reason := 'AUTO_MATCH_DISABLED';
      ELSE
        -- Mã từng tồn tại nhưng đã CONFIRMED/CANCELLED: trung tính chờ người kiểm tra.
        v_status := 'MANUAL_REVIEW';
        v_reason := 'REQUEST_NOT_PENDING';
      END IF;
    ELSE
      -- Không tìm ra mã: cùng một trạng thái UNMATCHED như mọi giao dịch lạ khác.
      v_status := 'UNMATCHED';
      v_reason := 'REFERENCE_FOUND_NO_REQUEST';
    END IF;
  END IF;

  INSERT INTO public.bank_transactions (
    provider, provider_txn_id, amount, transfer_at, reference, transfer_content,
    sender_name, sender_bank, status, match_reason,
    qr_request_id, sale_id, vehicle_id, raw_payload
  ) VALUES (
    v_provider, v_txn_id, v_amount, v_transfer_at,
    CASE WHEN v_code <> '' THEN v_code ELSE '' END, v_content,
    v_sender_name, v_sender_bank, v_status, v_reason,
    CASE WHEN v_status IN ('MATCHED_PENDING', 'MANUAL_REVIEW') THEN v_request.id END,
    CASE WHEN v_status IN ('MATCHED_PENDING', 'MANUAL_REVIEW') THEN v_request.sale_id END,
    CASE WHEN v_status IN ('MATCHED_PENDING', 'MANUAL_REVIEW') THEN v_request.vehicle_id END,
    coalesce(p_data->'raw', '{}'::jsonb)
  ) RETURNING * INTO v_txn;

  -- Audit KHÔNG chứa secret; action nằm ngoài whitelist NOTIFY nên fan-out do
  -- notify_from_audit đảm nhiệm riêng theo từng action ngân hàng.
  PERFORM private.audit(
    CASE v_status
      WHEN 'MATCHED_PENDING' THEN 'BANK_TRANSACTION_MATCHED'
      WHEN 'MANUAL_REVIEW' THEN 'BANK_TRANSACTION_REVIEW'
      ELSE 'BANK_TRANSACTION_UNMATCHED'
    END,
    'bank_transactions', v_txn.id, null,
    jsonb_build_object(
      'provider', v_txn.provider, 'amount', v_txn.amount, 'reference', v_txn.reference,
      'status', v_txn.status, 'match_reason', v_txn.match_reason,
      'qr_request_id', v_txn.qr_request_id, 'sale_id', v_txn.sale_id,
      'vehicle_id', v_txn.vehicle_id
    ),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status);
END $$;

CREATE OR REPLACE FUNCTION public.confirm_bank_transaction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_txn public.bank_transactions;
  v_payment_id uuid;
  v_request_id uuid;
  v_qr public.vietqr_requests;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  v_actor := auth.uid();
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions
    WHERE id = nullif(p_data->>'id', '')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='BANK_TRANSACTION_NOT_FOUND';
  END IF;

  -- Idempotent: đã ghi nhận thì trả nguyên kết quả cũ, không ghi lần hai.
  IF v_txn.status = 'RECORDED' THEN
    RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                              'payment_id', v_txn.payment_id);
  END IF;
  IF v_txn.status NOT IN ('MATCHED_PENDING', 'MANUAL_REVIEW') OR v_txn.qr_request_id IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_NOT_CONFIRMABLE';
  END IF;

  SELECT * INTO v_qr FROM public.vietqr_requests WHERE id=v_txn.qr_request_id FOR UPDATE;
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF v_qr.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='VIETQR_REQUEST_NOT_PENDING';
  END IF;
  IF v_qr.amount IS DISTINCT FROM v_txn.amount THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_AMOUNT_MISMATCH';
  END IF;
  v_request_id := nullif(p_data->>'request_id', '')::uuid;

  -- Toàn bộ quy tắc an toàn (số dư, provenance giá OWNER-private, request idempotency)
  -- nằm trong confirm_vietqr_payment → private.add_payment_verified_impl.
  v_payment_id := public.confirm_vietqr_payment(jsonb_build_object(
    'qr_request_id', v_txn.qr_request_id,
    'request_id', coalesce(v_request_id::text, gen_random_uuid()::text),
    'payment_date', coalesce(nullif(p_data->>'payment_date', '')::text, private.today()::text),
    'notes', coalesce(p_data->>'notes',
                      'Đối soát chuyển khoản ' || coalesce(nullif(v_txn.reference, ''), v_txn.provider_txn_id))
  ));

  UPDATE public.bank_transactions
    SET status = 'RECORDED', payment_id = v_payment_id,
        confirmed_by = v_actor, confirmed_at = now()
    WHERE id = v_txn.id RETURNING * INTO v_txn;

  PERFORM private.audit('BANK_TRANSACTION_RECORDED', 'bank_transactions', v_txn.id,
    null, jsonb_build_object('payment_id', v_payment_id, 'qr_request_id', v_txn.qr_request_id,
                             'reference', v_txn.reference, 'sale_id', v_txn.sale_id),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                            'payment_id', v_payment_id);
END $$;

CREATE OR REPLACE FUNCTION public.link_bank_transaction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_txn public.bank_transactions;
  v_request public.vietqr_requests;
  v_ref text;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  v_actor := auth.uid();
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions
    WHERE id = nullif(p_data->>'id', '')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='BANK_TRANSACTION_NOT_FOUND';
  END IF;
  IF v_txn.status NOT IN ('UNMATCHED', 'MANUAL_REVIEW') THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_NOT_LINKABLE';
  END IF;

  -- Cho phép gán theo uuid yêu cầu HOẶC mã tham chiếu người dùng nhìn thấy trên QR.
  -- Mã CAREM GDxxxxx đã hiển thị công khai trên QR khách quét nên không lộ giá;
  -- vẫn bắt buộc can_financials để chỉ người được phép đối soát mới gán được.
  v_ref := nullif(btrim(coalesce(p_data->>'reference', '')), '');
  IF nullif(p_data->>'qr_request_id', '') IS NOT NULL THEN
    SELECT * INTO v_request FROM public.vietqr_requests
      WHERE id = nullif(p_data->>'qr_request_id', '')::uuid FOR UPDATE;
  ELSIF v_ref IS NOT NULL THEN
    SELECT * INTO v_request FROM public.vietqr_requests
      WHERE qr_reference = upper(v_ref) AND status = 'PENDING' FOR UPDATE;
  ELSE
    RAISE EXCEPTION USING errcode='22023', message='VIETQR_LINK_TARGET_REQUIRED';
  END IF;
  IF v_request.id IS NULL THEN
    RAISE EXCEPTION USING errcode='P0002', message='VIETQR_REQUEST_NOT_FOUND';
  END IF;
  IF v_request.status <> 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='VIETQR_REQUEST_NOT_PENDING';
  END IF;
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF v_request.amount IS DISTINCT FROM v_txn.amount THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_AMOUNT_MISMATCH';
  END IF;
  -- Một yêu cầu chỉ được một giao dịch ghi tiền; chống hai webhook trỏ cùng QR.
  IF EXISTS (SELECT 1 FROM public.bank_transactions bt
             WHERE bt.qr_request_id = v_request.id AND bt.status <> 'IGNORED' AND bt.id <> v_txn.id) THEN
    RAISE EXCEPTION USING errcode='23505', message='BANK_TRANSACTION_ALREADY_LINKED';
  END IF;

  UPDATE public.bank_transactions
    SET status = 'MANUAL_REVIEW', match_reason = 'MANUAL_LINK',
        qr_request_id = v_request.id, sale_id = v_request.sale_id,
        vehicle_id = v_request.vehicle_id, linked_by = v_actor, linked_at = now()
    WHERE id = v_txn.id RETURNING * INTO v_txn;

  PERFORM private.audit('BANK_TRANSACTION_LINKED', 'bank_transactions', v_txn.id,
    null, jsonb_build_object('qr_request_id', v_request.id, 'reference', v_request.qr_reference,
                             'sale_id', v_txn.sale_id),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                            'qr_request_id', v_txn.qr_request_id);
END $$;

CREATE OR REPLACE FUNCTION public.list_payment_receipts(p_sale_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_sale public.sales;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  SELECT * INTO v_sale FROM public.sales WHERE id=p_sale_id;
  IF NOT FOUND OR NOT private.money_disclosable(v_sale.sale_price_visibility) THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at)
    FROM public.payment_receipts r WHERE sale_id=p_sale_id),'[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.list_pending_approvals(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 50)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_status text := upper(btrim(coalesce(nullif(p_filters->>'status', ''), 'PENDING')));
  v_kind text := nullif(btrim(coalesce(p_filters->>'kind', '')), '');
  v_exclude_kind text := nullif(btrim(coalesce(p_filters->>'exclude_kind', '')), '');
  v_items jsonb; v_total bigint;
BEGIN
  IF v_status NOT IN ('PENDING','APPROVED','REJECTED') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT count(*) INTO v_total FROM public.approval_requests ar
    WHERE ar.status = v_status AND (v_kind IS NULL OR ar.kind = v_kind)
      AND (v_exclude_kind IS NULL OR ar.kind <> v_exclude_kind);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'kind', x.kind, 'subject_id', x.subject_id, 'reason', x.reason,
      'status', x.status, 'payload', x.payload,
      'requested_by', x.requested_by, 'requester_name', x.requester_name, 'created_at', x.created_at,
      'resolved_at', x.resolved_at, 'resolution_note', x.resolution_note,
      'resolved_by_name', x.resolved_by_name,
      'vehicle_code', x.vehicle_code, 'vehicle_title', x.vehicle_title,
      'vehicle_subtitle', x.vehicle_subtitle, 'license_plate', x.license_plate,
      'frame_number', x.frame_number, 'vehicle_status', x.vehicle_status
    ) ORDER BY x.rn), '[]'::jsonb) INTO v_items
  FROM (
    SELECT row_number() OVER (ORDER BY ar.created_at DESC, ar.id DESC) AS rn,
      ar.id, ar.kind, ar.subject_id, ar.requested_by, ar.reason, ar.status, ar.payload,
      ar.created_at, ar.resolved_at, ar.resolution_note,
      req.full_name AS requester_name,
      res.full_name AS resolved_by_name,
      v.internal_code AS vehicle_code,
      private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) AS vehicle_title,
      private.vehicle_display(v) ->> 'vehicle_subtitle' AS vehicle_subtitle,
      v.license_plate, v.frame_number, v.status::text AS vehicle_status
    FROM public.approval_requests ar
    LEFT JOIN public.profiles req ON req.id = ar.requested_by
    LEFT JOIN public.profiles res ON res.id = ar.resolved_by
    LEFT JOIN public.vehicles v ON v.id = ar.subject_id
    WHERE ar.status = v_status AND (v_kind IS NULL OR ar.kind = v_kind)
      AND (v_exclude_kind IS NULL OR ar.kind <> v_exclude_kind)
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT v_limit OFFSET v_offset
  ) x;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

CREATE OR REPLACE FUNCTION private.notify_from_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text := NEW.action;
  v_actor uuid := coalesce(NEW.user_id, auth.uid());
  v_new jsonb := coalesce(NEW.new_data, '{}'::jsonb);
  v_actor_name text;
  v_label text;
  v_sale uuid;
  v_sale_code text;
  v_vehicle uuid;
  v_extra uuid;               -- entity owner to include beyond actor + bosses
  v_title text;
  v_body_money text;          -- copy shown to finance-visible recipients
  v_body_plain text;          -- copy shown to everyone else
  v_link text;
  v_amount bigint;
  v_reason text;
  v_customer text;
  v_seller text;
  v_requester uuid;
  v_settings public.system_settings;
  v_phone text;
  r record;
BEGIN
  IF v_action NOT IN ('CREATE_ACQUISITION','CANCEL_ACQUISITION','CREATE_SALE','CANCEL_SALE',
                      'CREATE_PAYMENT','VOID_PAYMENT','CREATE_VEHICLE','UPDATE_VEHICLE',
                      'REQUEST_DELETE_VEHICLE',
                      'REQUEST_SALE_BELOW_COST','APPROVE_SALE_BELOW_COST',
                      'REJECT_SALE_BELOW_COST','CANCEL_SALE_BELOW_COST',
                      'VERIFY_SALE_CONTACT',
                      'BANK_TRANSACTION_MATCHED','BANK_TRANSACTION_REVIEW',
                      'BANK_TRANSACTION_UNMATCHED') THEN
    RETURN NEW;
  END IF;

  -- Dedup: CREATE_VEHICLE issued inside acquire_vehicle (CREATE_ACQUISITION audited
  -- first, same transaction, same vehicle id) must not double-notify.
  IF v_action = 'CREATE_VEHICLE' AND EXISTS (
    SELECT 1 FROM public.audit_logs al
    WHERE al.action = 'CREATE_ACQUISITION'
      AND al.created_at = NEW.created_at
      AND al.new_data -> 'vehicle' ->> 'id' = NEW.entity_id::text
  ) THEN
    RETURN NEW;
  END IF;

  v_actor_name := coalesce(
    (SELECT p.full_name FROM public.profiles p WHERE p.id = v_actor), 'Hệ thống');

  -- ============ Nhánh đối soát ngân hàng (Smart Sales Automation V1) ============
  IF v_action IN ('BANK_TRANSACTION_MATCHED','BANK_TRANSACTION_REVIEW','BANK_TRANSACTION_UNMATCHED') THEN
    v_vehicle := nullif(v_new ->> 'vehicle_id', '')::uuid;
    v_sale := nullif(v_new ->> 'sale_id', '')::uuid;
    v_amount := nullif(v_new ->> 'amount', '')::bigint;
    v_requester := CASE WHEN v_new ? 'qr_request_id' AND nullif(v_new ->> 'qr_request_id', '') IS NOT NULL
      THEN (SELECT vr.created_by FROM public.vietqr_requests vr
            WHERE vr.id = (v_new ->> 'qr_request_id')::uuid) END;
    IF v_vehicle IS NOT NULL THEN
      SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
        INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
      v_label := coalesce(v_label, 'xe trong kho');
    END IF;

    IF v_action = 'BANK_TRANSACTION_MATCHED' THEN
      v_title := left('Tiền chuyển khoản đã về — chờ xác nhận', 160);
      v_body_money := 'Giao dịch ' || private.money_text(v_amount)
        || coalesce(' khớp mã ' || nullif(v_new ->> 'reference', ''), '')
        || coalesce(' (' || nullif(v_new ->> 'sender_name', '') || ')', '')
        || ' — chờ nhân viên xác nhận tiền vào.';
      -- STAFF ngoài cuộc chỉ nhận tin không tiền, không đơn, không mã.
      v_body_plain := 'Một giao dịch chuyển khoản đã về, đang chờ xác nhận.';
      v_link := '/bank-reconciliation';
    ELSIF v_action = 'BANK_TRANSACTION_REVIEW' THEN
      v_title := left('Giao dịch ngân hàng cần đối soát', 160);
      v_body_money := 'Giao dịch ' || private.money_text(v_amount)
        || coalesce(' có nội dung "' || nullif(v_new ->> 'reference', '') || '"', '')
        || ' cần kiểm tra thủ công.';
      v_body_plain := 'Một giao dịch chuyển khoản cần đối soát thủ công.';
      v_link := '/bank-reconciliation';
    ELSE -- BANK_TRANSACTION_UNMATCHED: bản sao trung tính, KHÔNG số tiền cho non-finance.
      v_title := left('Giao dịch ngân hàng chưa khớp đơn', 160);
      v_body_money := 'Giao dịch ' || private.money_text(v_amount)
        || ' chưa tìm thấy đơn phù hợp — xem danh sách đối soát.';
      v_body_plain := 'Có giao dịch ngân hàng mới chưa khớp đơn.';
      v_link := '/bank-reconciliation';
    END IF;

    -- Người nhận: OWNER/MANAGER active (bản tiền theo quyền), người tạo QR liên quan,
    -- và người bán của đơn nếu khớp. Service_role ingest → actor NULL → "Hệ thống".
    FOR r IN
      SELECT p.id, p.role, p.can_view_financials FROM public.profiles p
      WHERE (p.role IN ('OWNER', 'MANAGER') AND p.active)
         OR (v_requester IS NOT NULL AND p.id = v_requester AND p.active)
         OR (v_sale IS NOT NULL AND p.active AND p.id =
             (SELECT s.sold_by FROM public.sales s WHERE s.id = v_sale))
      GROUP BY p.id, p.role, p.can_view_financials
    LOOP
      IF r.role = 'OWNER' OR (r.role = 'MANAGER' AND r.can_view_financials) THEN
        INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                          vehicle_id, title, body, deep_link)
        VALUES (r.id, NULL, v_action, NEW.entity_type, NEW.entity_id,
                v_vehicle, v_title, left(v_body_money, 400), v_link);
      ELSE
        INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                          vehicle_id, title, body, deep_link)
        VALUES (r.id, NULL, v_action, NEW.entity_type, NEW.entity_id,
                v_vehicle, v_title, left(v_body_plain, 400), v_link);
      END IF;
    END LOOP;

    -- Chuông cho chính người ghi nhận xác nhận (RECORDED) do CREATE_PAYMENT đã có.
    RETURN NEW;
  END IF;

  -- ============ Lời cảm ơn thủ công qua kênh cá nhân đã xác minh ============
  -- Enqueue khi liên hệ được DUYỆT (không phải lúc CREATE_SALE: liên hệ có FK
  -- sale_id NOT NULL nên chưa thể tồn tại trước khi đơn bán được tạo). Bật theo
  -- setting thankyou_manual_enabled. CHỈ chuẩn bị bản nháp cho nhân viên tự gửi;
  -- không API không chính thức, không cookie scraping, không bot. Kênh chính thức
  -- (ZALO_OA/FB_MESSENGER/SMS) do queue V2 đảm nhận, không rơi vào nhánh này.
  -- Insert trực tiếp, KHÔNG audit (đệ quy trigger).
  IF v_action = 'VERIFY_SALE_CONTACT' THEN
    IF coalesce((v_new ->> 'verified')::boolean, false)
       AND (v_new ->> 'channel') IN ('ZALO_PERSONAL', 'MESSENGER_PERSONAL') THEN
      SELECT * INTO v_settings FROM public.system_settings WHERE id;
      v_sale := nullif(v_new ->> 'sale_id', '')::uuid;
      IF v_settings.thankyou_manual_enabled AND v_sale IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.sales s WHERE s.id = v_sale AND s.status = 'COMPLETED'
      ) THEN
        SELECT s.customer_name INTO v_customer FROM public.sales s WHERE s.id = v_sale;
        v_phone := coalesce(nullif(v_new ->> 'phone', ''), '');
        INSERT INTO public.message_outbox (
          event_type, channel, sale_id, recipient_phone, template_code,
          template_variables, status, next_attempt_at, created_by, processed_at, last_error_code)
        VALUES (
          'SALE_THANK_YOU_PERSONAL', (v_new ->> 'channel'), v_sale,
          CASE WHEN v_phone <> '' THEN '+' || substr(v_phone, 2) ELSE '' END,
          'sale_thank_you_personal_v1',
          jsonb_build_object('customer_name', coalesce(v_customer, 'Quý khách'),
                             'store_name', coalesce(v_settings.store_name, '')),
          'QUEUED', NULL, v_actor, NULL, 'MANUAL_CHANNEL')
        ON CONFLICT (event_type, sale_id, channel) DO NOTHING;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF v_action = 'CREATE_ACQUISITION' THEN
    v_vehicle := (v_new -> 'vehicle' ->> 'id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thu');
    v_seller := nullif(btrim(coalesce(v_new ->> 'seller_name', '')), '');
    -- purchase_price 0 means "chờ giá vốn" (cost pending), not a real price.
    v_amount := NULLIF((v_new ->> 'purchase_price')::bigint, 0);
    v_title := left('Thu vào xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã thu vào xe ' || v_label
      || coalesce(' từ ' || v_seller, '')
      || coalesce(', giá vốn ' || private.money_text(v_amount), '');
    v_body_plain := v_actor_name || ' đã thu vào xe ' || v_label;
    v_link := '/acquisitions';
  ELSIF v_action = 'CANCEL_ACQUISITION' THEN
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã thu');
    v_extra := (v_new ->> 'created_by')::uuid;
    v_reason := nullif(btrim(coalesce(v_new ->> 'cancellation_reason', '')), '');
    v_title := left('Hủy thu xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã hủy phiếu thu xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '');
    v_body_plain := v_body_money;
    v_link := '/acquisitions';
  ELSIF v_action = 'CREATE_SALE' THEN
    v_sale := NEW.entity_id;
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã bán');
    v_customer := nullif(btrim(coalesce(v_new ->> 'customer_name', '')), '');
    v_amount := (v_new ->> 'sale_price')::bigint;
    v_extra := (SELECT v2.created_by FROM public.vehicles v2 WHERE v2.id = v_vehicle);
    v_title := left('Bán xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã bán xe ' || v_label
      || coalesce(' cho ' || v_customer, '')
      || coalesce(', giá bán ' || private.money_text(v_amount), '');
    v_body_plain := v_actor_name || ' đã bán xe ' || v_label
      || coalesce(' cho ' || v_customer, '');
    v_link := '/sales/' || v_sale;
    -- The initial payment recorded inside sell_vehicle shares this transaction;
    -- its standalone notification is redundant noise. now() is stable per txn.
    DELETE FROM public.notifications n
    WHERE n.action = 'CREATE_PAYMENT'
      AND n.created_at = NEW.created_at
      AND n.deep_link = '/sales/' || v_sale::text;
  ELSIF v_action = 'CANCEL_SALE' THEN
    v_sale := NEW.entity_id;
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã bán');
    v_extra := (v_new ->> 'sold_by')::uuid;
    v_reason := nullif(btrim(coalesce(v_new ->> 'cancellation_reason', '')), '');
    v_title := left('Hủy bán xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã hủy giao dịch bán xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '');
    v_body_plain := v_body_money;
    v_link := '/sales/' || v_sale;
    -- Same-transaction VOID_PAYMENT rows come from the cancel cascade, not a
    -- standalone correction; the CANCEL_SALE notice covers them.
    DELETE FROM public.notifications n
    WHERE n.action = 'VOID_PAYMENT'
      AND n.created_at = NEW.created_at
      AND n.deep_link = '/sales/' || v_sale::text;
  ELSIF v_action = 'CREATE_PAYMENT' OR v_action = 'VOID_PAYMENT' THEN
    v_sale := (v_new ->> 'sale_id')::uuid;
    v_amount := (v_new ->> 'amount')::bigint;
    SELECT s.sale_code, s.sold_by,
           private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_sale_code, v_extra, v_label
    FROM public.sales s
    JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE s.id = v_sale;
    v_vehicle := (SELECT s2.vehicle_id FROM public.sales s2 WHERE s2.id = v_sale);
    v_label := coalesce(v_label, 'xe đã bán');
    IF v_action = 'CREATE_PAYMENT' THEN
      v_title := left('Thu tiền đơn ' || coalesce(v_sale_code, 'bán xe'), 160);
      v_body_money := v_actor_name || ' đã ghi nhận thu ' || private.money_text(v_amount)
        || ' cho đơn bán xe ' || v_label;
      v_body_plain := v_actor_name || ' đã ghi nhận một khoản thu cho đơn bán xe ' || v_label;
    ELSE
      v_title := left('Hủy khoản thu đơn ' || coalesce(v_sale_code, 'bán xe'), 160);
      v_body_money := v_actor_name || ' đã hủy khoản thu ' || private.money_text(v_amount)
        || ' của đơn bán xe ' || v_label;
      v_body_plain := v_actor_name || ' đã hủy một khoản thu của đơn bán xe ' || v_label;
    END IF;
    v_link := '/sales/' || v_sale;
  ELSIF v_action = 'CREATE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thêm');
    v_title := left('Thêm xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã thêm xe ' || v_label || ' vào tồn kho';
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  ELSIF v_action = 'REQUEST_DELETE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_reason := nullif(btrim(coalesce(v_new ->> 'reason', '')), '');
    v_title := left('Yêu cầu xóa xe ' || v_label, 160);
    v_body_money := v_actor_name || ' gửi yêu cầu xóa xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '') || ' — đang chờ chủ cửa hàng duyệt.';
    v_body_plain := v_body_money;
    v_link := '/approvals';
  ELSIF v_action IN ('REQUEST_SALE_BELOW_COST','APPROVE_SALE_BELOW_COST',
                     'REJECT_SALE_BELOW_COST','CANCEL_SALE_BELOW_COST') THEN
    -- Đơn bán dưới giá thu: người gửi luôn nằm trong danh sách nhận (v_extra)
    -- để nhân viên biết chủ đã quyết định, dù chủ là người bấm nút.
    v_vehicle := NEW.entity_id;
    v_extra := nullif(v_new ->> 'requested_by', '')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_reason := nullif(btrim(coalesce(v_new ->> 'note', '')), '');
    v_link := '/approvals';
    IF v_action = 'REQUEST_SALE_BELOW_COST' THEN
      v_amount := NULLIF(v_new ->> 'shortfall', '')::bigint;
      v_title := left('Chờ duyệt: bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' xin bán dưới giá thu xe ' || v_label
        || coalesce(', thiếu ' || private.money_text(v_amount), '')
        || ' — chờ chủ cửa hàng duyệt.';
      v_body_plain := v_actor_name || ' xin bán dưới giá thu xe ' || v_label
        || ' — đang chờ chủ cửa hàng duyệt.';
    ELSIF v_action = 'APPROVE_SALE_BELOW_COST' THEN
      v_sale := NULLIF(v_new ->> 'sale_id', '')::uuid;
      v_amount := NULLIF(v_new ->> 'sale_price', '')::bigint;
      v_title := left('Đã duyệt bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' đã duyệt và ghi nhận bán xe ' || v_label
        || coalesce(' với giá ' || private.money_text(v_amount), '')
        || coalesce('. Ghi chú: ' || v_reason, '');
      v_body_plain := v_actor_name || ' đã duyệt cho bán xe ' || v_label
        || coalesce('. Ghi chú: ' || v_reason, '');
      v_link := coalesce('/sales/' || v_sale::text, '/approvals');
    ELSIF v_action = 'REJECT_SALE_BELOW_COST' THEN
      v_title := left('Từ chối bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' đã từ chối yêu cầu bán dưới giá thu xe ' || v_label
        || coalesce('. Lý do: ' || v_reason, '');
      v_body_plain := v_actor_name || ' đã từ chối yêu cầu bán xe ' || v_label
        || coalesce('. Lý do: ' || v_reason, '');
    ELSE -- CANCEL_SALE_BELOW_COST: rút đơn là tin không con số với mọi người.
      v_title := left('Đã rút yêu cầu bán dưới giá thu xe ' || v_label, 160);
      v_body_money := v_actor_name || ' đã rút yêu cầu duyệt bán xe ' || v_label
        || coalesce('. Lý do: ' || v_reason, '');
      v_body_plain := v_body_money;
    END IF;
  ELSE -- UPDATE_VEHICLE
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_extra := (v_new ->> 'created_by')::uuid;
    v_title := left('Cập nhật xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã cập nhật thông tin xe ' || v_label;
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  END IF;

  -- Recipients: the actor (all roles, self-confirmation), every active
  -- OWNER/MANAGER, plus the non-acting owner of the affected transaction.
  FOR r IN
    SELECT p.id, p.role, p.can_view_financials FROM public.profiles p
    WHERE p.id = v_actor
       OR (p.role IN ('OWNER', 'MANAGER') AND p.active)
       OR (v_extra IS NOT NULL AND p.id = v_extra AND p.active
           AND (v_actor IS NULL OR p.id <> v_actor))
    GROUP BY p.id, p.role, p.can_view_financials
  LOOP
    -- Money copy only for OWNER, finance-visible MANAGERs, and the actor itself.
    IF r.role = 'OWNER' OR (r.role = 'MANAGER' AND r.can_view_financials)
       OR (r.id = v_actor AND (v_action <> 'REQUEST_SALE_BELOW_COST'
         OR EXISTS (SELECT 1 FROM public.vehicle_financials vf
                    WHERE vf.vehicle_id=v_vehicle AND vf.purchase_price_visibility='PUBLIC'))) THEN
      INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                        vehicle_id, title, body, deep_link)
      VALUES (r.id, v_actor, v_action, NEW.entity_type, NEW.entity_id,
              v_vehicle, v_title, left(v_body_money, 400), v_link);
    ELSE
      INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                        vehicle_id, title, body, deep_link)
      VALUES (r.id, v_actor, v_action, NEW.entity_type, NEW.entity_id,
              v_vehicle, v_title, left(v_body_plain, 400), v_link);
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION private.sell_vehicle_impl(p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
  v_sale public.sales;
  v_purchase bigint;
  v_cost_vis public.money_visibility;
  v_expenses bigint;
  v_price bigint := private.money_input(p_data, 'sale_price');
  v_initial bigint := private.money_input(p_data, 'initial_payment', 0);
  v_date date := coalesce((p_data->>'sale_date')::date, private.today());
  v_due_date date := nullif(p_data->>'due_date', '')::date;
  v_sold_by uuid := nullif(p_data->>'sold_by', '')::uuid;
  v_payment public.payments;
  v_settings public.system_settings;
  v_phone text;
  v_channel text;
  v_status text;
  v_preview text;
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = (p_data->>'vehicle_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_vehicle.status NOT IN ('IN_STOCK', 'RESERVED') THEN RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_NOT_AVAILABLE'; END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETE_PENDING';
  END IF;
  -- A pending below-cost request means the OWNER must decide first.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'SALE_BELOW_COST' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_APPROVAL_PENDING';
  END IF;
  IF v_date < v_vehicle.purchase_date OR v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SALE_DATE'; END IF;
  IF v_due_date IS NOT NULL AND v_due_date < v_date THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE'; END IF;
  IF v_price IS NULL OR v_price <= 0 OR v_initial > v_price THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT'; END IF;
  IF EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE' AND expense_date > v_date) THEN RAISE EXCEPTION USING errcode = '22023', message = 'SALE_BEFORE_EXPENSE'; END IF;
  SELECT purchase_price, purchase_price_visibility INTO v_purchase, v_cost_vis FROM public.vehicle_financials WHERE vehicle_id = v_vehicle.id;
  IF v_purchase IS NULL THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_COST_REQUIRED'; END IF;
  -- Anti-oracle below-cost gate. When the cost is OWNER-private/legacy (not disclosable
  -- to this actor) a non-OWNER sale is ALWAYS routed to OWNER confirmation, so the
  -- response never reveals whether the offered price is above or below the hidden cost.
  IF private.current_role() <> 'OWNER'::public.user_role THEN
    IF NOT private.money_disclosable(v_cost_vis) THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'SALE_OWNER_CONFIRMATION_REQUIRED';
    ELSIF v_price < v_purchase THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'SALE_BELOW_COST_APPROVAL_REQUIRED';
    END IF;
  END IF;
  -- sold_by only honored internally (OWNER approving a staff request) and only if active.
  IF v_sold_by IS NOT NULL AND (private.current_role() <> 'OWNER'::public.user_role
      OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_sold_by AND p.active)) THEN
    v_sold_by := NULL;
  END IF;
  v_sold_by := coalesce(v_sold_by, v_actor);
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE';
  PERFORM private.safe_money(v_purchase::numeric + v_expenses);
  INSERT INTO public.sales (vehicle_id, customer_name, customer_phone, sale_price, sale_date, due_date, sold_by, notes, sale_price_visibility)
  VALUES (v_vehicle.id, btrim(p_data->>'customer_name'), btrim(coalesce(p_data->>'customer_phone', '')), v_price, v_date, v_due_date, v_sold_by, coalesce(p_data->>'notes', ''), private.price_visibility_for(v_sold_by)) RETURNING * INTO v_sale;
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
    -- Keep the primary sale and retain a safe incident without provider/PII details.
    BEGIN
      PERFORM private.audit('AUTO_MESSAGE_QUEUE_FAILED', 'sales', v_sale.id, null,
        jsonb_build_object('error_code','MESSAGE_QUEUE_UNAVAILABLE'), v_vehicle.id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN v_sale.id;
END $fn$;

-- Redact old UI copies; business prices, sales and immutable audit history are unchanged.
UPDATE public.notifications n
   SET body=regexp_replace(n.body, ', thiếu [^—]+ —', ' —')
 WHERE n.action='REQUEST_SALE_BELOW_COST'
   AND EXISTS (SELECT 1 FROM public.vehicle_financials vf
               WHERE vf.vehicle_id=n.vehicle_id AND vf.purchase_price_visibility<>'PUBLIC')
   AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=n.user_id
                   AND p.active AND (p.role='OWNER' OR (p.role='MANAGER' AND p.can_view_financials)));

COMMIT;
