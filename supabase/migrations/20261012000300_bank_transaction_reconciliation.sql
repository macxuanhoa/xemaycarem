-- Migration: 20261012000300_bank_transaction_reconciliation.sql
-- Smart Sales Automation V1 — đối soát giao dịch ngân hàng.
--   * Edge function `bank-webhook` (SePay/Casso adapter, verify HMAC trước khi chạm DB)
--     gọi public.ingest_bank_transaction bằng service_role. KHÔNG có đường ghi client.
--   * Giao dịch về khớp đúng mã tham chiếu VietQR đang chờ (CAREM GDxxxxx) + đúng số tiền
--     → MATCHED_PENDING, chuông cho người có quyền tài chính xác nhận. Mọi trường hợp
--     nghi ngờ (sai tiền, mã trỏ đơn đã chốt/cancel, không mã) → MANUAL_REVIEW/UNMATCHED
--     trung tính: phản hồi và trạng thái KHÔNG phân biệt "mã tồn tại" với "mã không tồn
--     tại" — chống dò (output invariance đã chốt ở docs/DECISIONS.md).
--   * Xác nhận tiền vào tái sử dụng đúng đường confirm_vietqr_payment →
--     private.add_payment_verified_impl (idempotency request_id, chống vượt số dư,
--     chặn giá OWNER-private qua PAYMENT_OWNER_REQUIRED). Không tự ghi tiền, không tự bán.
--   * Chống ghi tiền trùng: UNIQUE(provider, provider_txn_id) + trạng thái RECORDED.
--   * NOTIFY trigger mở rộng (forward-only, bản thay thế cuối chuỗi 20261010000300):
--     thêm nhánh chuông ngân hàng + mắc lỗi sao chép tin cảm ơn cá nhân khi chốt bán.
-- Cấm gọi private.audit bên trong notify_from_audit (đệ quy trigger).

BEGIN;

-- ============================================================
-- 1. Nhận diện service_role phía SQL (edge webhookOnly)
-- ============================================================

CREATE OR REPLACE FUNCTION private.is_service_role() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.pg_has_role(current_user, 'service_role'::regrole, 'usage')
$$;
REVOKE ALL ON FUNCTION private.is_service_role() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_service_role() TO service_role;

-- ============================================================
-- 2. Cấu hình system_settings cho automation
-- ============================================================

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS bank_provider text NOT NULL DEFAULT ''
    CHECK (bank_provider IN ('', 'SEPAY', 'CASSO')),
  ADD COLUMN IF NOT EXISTS bank_webhook_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_auto_match_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS thankyou_manual_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.system_settings.bank_provider IS 'Nhà cung cấp webhook ngân hàng (SEPAY/CASSO). Secret chỉ nằm trong env Edge Function, không bao giờ vào DB.';
COMMENT ON COLUMN public.system_settings.bank_webhook_enabled IS 'Chủ cửa hàng bật/tắt tiếp nhận giao dịch ngân hàng tự động.';
COMMENT ON COLUMN public.system_settings.bank_auto_match_enabled IS 'Tự gắn cờ MATCHED_PENDING khi giao dịch khớp đúng mã tham chiếu và số tiền đang chờ.';
COMMENT ON COLUMN public.system_settings.thankyou_manual_enabled IS 'Chuẩn bị lời cảm ơn thủ công (sao chép + gửi qua Zalo/Messenger cá nhân) sau khi chốt bán.';

-- save_settings: giữ nguyên toàn bộ logic VietQR/lịch làm việc (20261010000700) và
-- chỉ mở rộng cho các khóa mới. Secret webhook KHÔNG qua hàm này.
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
    -- Chỉ bật webhook khi đã chọn nhà cung cấp và có đủ thông tin tài khoản nhận tiền.
    IF v_bank_webhook_enabled AND (v_bank_provider IS NULL OR v_bank_provider = '') THEN
      RAISE EXCEPTION USING errcode='22023',message='BANK_PROVIDER_REQUIRED';
    END IF;
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

-- ============================================================
-- 3. Bảng giao dịch ngân hàng về từ webhook
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('SEPAY', 'CASSO')),
  provider_txn_id text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000000),
  transfer_at timestamptz NOT NULL DEFAULT now(),
  reference text NOT NULL DEFAULT '',
  transfer_content text NOT NULL DEFAULT '' CHECK (length(transfer_content) <= 240),
  sender_name text NOT NULL DEFAULT '' CHECK (length(sender_name) <= 120),
  sender_bank text NOT NULL DEFAULT '' CHECK (length(sender_bank) <= 40),
  status text NOT NULL DEFAULT 'UNMATCHED' CHECK (status IN (
    'UNMATCHED', 'MATCHED_PENDING', 'MANUAL_REVIEW', 'RECORDED', 'IGNORED')),
  match_reason text NOT NULL DEFAULT '' CHECK (match_reason IN (
    '', 'REFERENCE_AMOUNT_MATCH', 'AMOUNT_MISMATCH', 'REQUEST_NOT_PENDING',
    'REFERENCE_FOUND_NO_REQUEST', 'NO_REFERENCE', 'MANUAL_LINK', 'AUTO_MATCH_DISABLED')),
  qr_request_id uuid REFERENCES public.vietqr_requests(id),
  sale_id uuid REFERENCES public.sales(id),
  vehicle_id uuid REFERENCES public.vehicles(id),
  payment_id uuid REFERENCES public.payments(id),
  confirmed_by uuid REFERENCES public.profiles(id),
  confirmed_at timestamptz,
  ignored_by uuid REFERENCES public.profiles(id),
  ignored_at timestamptz,
  ignore_reason text CHECK (ignore_reason IS NULL OR length(ignore_reason) <= 240),
  linked_by uuid REFERENCES public.profiles(id),
  linked_at timestamptz,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Chống ghi tiền trùng: mỗi mã giao dịch của nhà cung cấp chỉ vào đúng một lần.
  UNIQUE (provider, provider_txn_id)
);

CREATE INDEX IF NOT EXISTS bank_transactions_status ON public.bank_transactions (status, received_at DESC);
CREATE INDEX IF NOT EXISTS bank_transactions_request ON public.bank_transactions (qr_request_id)
  WHERE qr_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_transactions_reference ON public.bank_transactions (reference)
  WHERE reference <> '';

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bank_transactions FROM public, anon, authenticated;

-- ============================================================
-- 4. RPC tiếp nhận webhook (chỉ service_role; mọi đầu khác chết với 42501)
-- ============================================================

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
  v_txn_id := left(btrim(coalesce(p_data->>'provider_txn_id', '')), 80);
  v_content := left(btrim(coalesce(p_data->>'transfer_content', '')), 240);
  v_sender_name := left(btrim(coalesce(p_data->>'sender_name', '')), 120);
  v_sender_bank := left(upper(btrim(coalesce(p_data->>'sender_bank', ''))), 40);
  -- private.money_input: chỉ chữ số, tối đa 13 ký tự, chặn > 1.000.000.000.000.
  v_amount := private.money_input(p_data, 'amount');
  v_transfer_at := coalesce(nullif(p_data->>'transfer_at', '')::timestamptz, clock_timestamp());
  IF v_provider NOT IN ('SEPAY', 'CASSO') OR v_txn_id = ''
     OR v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT * INTO v_settings FROM public.system_settings WHERE id;

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

-- ============================================================
-- 5. RPC đọc/đối soát (chỉ người có quyền tài chính — cùng mốc với VietQR)
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_bank_transactions(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_pending bigint;
  v_status text := nullif(btrim(coalesce(p_filters->>'status', '')), '');
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF jsonb_typeof(p_filters) IS DISTINCT FROM 'object'
     OR (v_status IS NOT NULL AND v_status NOT IN
       ('UNMATCHED','MATCHED_PENDING','MANUAL_REVIEW','RECORDED','IGNORED')) THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT count(*) INTO v_total FROM public.bank_transactions t
    WHERE (v_status IS NULL OR t.status = v_status);
  SELECT count(*) INTO v_pending FROM public.bank_transactions t
    WHERE t.status IN ('MATCHED_PENDING', 'MANUAL_REVIEW');

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'provider', t.provider, 'provider_txn_id', t.provider_txn_id,
      'amount', t.amount, 'transfer_at', t.transfer_at, 'reference', t.reference,
      'transfer_content', t.transfer_content, 'sender_name', t.sender_name,
      'sender_bank', t.sender_bank, 'status', t.status, 'match_reason', t.match_reason,
      'qr_request_id', t.qr_request_id, 'sale_id', t.sale_id, 'vehicle_id', t.vehicle_id,
      'sale_code', s.sale_code,
      'vehicle_label', private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code),
      'payment_id', t.payment_id, 'confirmed_by', t.confirmed_by, 'confirmed_at', t.confirmed_at,
      'received_at', t.received_at
    ) ORDER BY t.received_at DESC, t.id DESC), '[]'::jsonb) INTO v_items
  FROM (
    SELECT * FROM public.bank_transactions bt
    WHERE (v_status IS NULL OR bt.status = v_status)
    ORDER BY bt.received_at DESC, bt.id DESC
    LIMIT v_limit OFFSET v_offset
  ) t
  LEFT JOIN public.sales s ON s.id = t.sale_id
  LEFT JOIN public.vehicles v ON v.id = t.vehicle_id;

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'pending_count', v_pending);
END $$;

-- Xác nhận một giao dịch đã khớp: ghi nhận tiền thật qua đúng đường VietQR đã kiểm chứng.
CREATE OR REPLACE FUNCTION public.confirm_bank_transaction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_txn public.bank_transactions;
  v_payment_id uuid;
  v_request_id uuid;
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

-- Gán thủ công một giao dịch chưa khớp vào yêu cầu VietQR đang chờ (đường đối soát tay).
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

-- Loại khỏi đối soát (tiền không liên quan cửa hàng, chuyển nhầm…). Không ghi nhận gì.
CREATE OR REPLACE FUNCTION public.ignore_bank_transaction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_txn public.bank_transactions;
  v_reason text;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  v_actor := auth.uid();
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  v_reason := left(btrim(coalesce(p_data->>'reason', '')), 240);
  IF v_reason = '' THEN
    RAISE EXCEPTION USING errcode='22023', message='REASON_REQUIRED';
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions
    WHERE id = nullif(p_data->>'id', '')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='BANK_TRANSACTION_NOT_FOUND';
  END IF;
  IF v_txn.status IN ('RECORDED', 'IGNORED') THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_NOT_LINKABLE';
  END IF;

  UPDATE public.bank_transactions
    SET status = 'IGNORED', ignore_reason = v_reason,
        ignored_by = v_actor, ignored_at = now()
    WHERE id = v_txn.id RETURNING * INTO v_txn;

  PERFORM private.audit('BANK_TRANSACTION_IGNORED', 'bank_transactions', v_txn.id,
    null, jsonb_build_object('reason', v_reason, 'reference', v_txn.reference),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status);
END $$;

-- Trạng thái đối soát của một yêu cầu VietQR — để modal VietQR hiển thị "tiền đã về".
-- Chỉ trả trạng thái + id giao dịch, không trả số tiền (modal đã biết tiền; chống suy luận).
CREATE OR REPLACE FUNCTION public.get_vietqr_matching_status(p_qr_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_txn public.bank_transactions;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF p_qr_request_id IS NULL OR NOT EXISTS
     (SELECT 1 FROM public.vietqr_requests r WHERE r.id = p_qr_request_id) THEN
    RAISE EXCEPTION USING errcode='P0002', message='VIETQR_REQUEST_NOT_FOUND';
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions
    WHERE qr_request_id = p_qr_request_id AND status <> 'IGNORED'
    ORDER BY received_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'NONE');
  END IF;
  RETURN jsonb_build_object(
    'state', CASE v_txn.status
               WHEN 'MATCHED_PENDING' THEN 'MATCHED'
               WHEN 'MANUAL_REVIEW' THEN 'REVIEW'
               WHEN 'RECORDED' THEN 'RECORDED'
               ELSE 'NONE' END,
    'bank_transaction_id', v_txn.id,
    'sender_name', CASE WHEN v_txn.status IN ('MATCHED_PENDING','MANUAL_REVIEW','RECORDED')
                        THEN v_txn.sender_name ELSE '' END,
    'transfer_at', v_txn.transfer_at);
END $$;

-- Bảng điều khiển Settings: webhook đã được cấu hình thật chưa (đọc từ Edge, không lộ secret).
CREATE OR REPLACE FUNCTION public.get_bank_webhook_state()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_settings public.system_settings;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER']::public.user_role[]);
  SELECT * INTO v_settings FROM public.system_settings WHERE id;
  RETURN jsonb_build_object(
    'provider', v_settings.bank_provider,
    'webhook_enabled', v_settings.bank_webhook_enabled,
    'auto_match_enabled', v_settings.bank_auto_match_enabled,
    'account_configured', nullif(v_settings.bank_account_no, '') IS NOT NULL);
END $$;

-- ============================================================
-- 6. Mở rộng fan-out thông báo (bản thay thế cuối chuỗi 20261010000300)
--    Thêm 3 nhánh ngân hàng + chuẩn bị lời cảm ơn thủ công sau CREATE_SALE.
--    CẤM gọi private.audit trong hàm này (đệ quy trigger).
-- ============================================================

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
    IF r.role = 'OWNER' OR (r.role = 'MANAGER' AND r.can_view_financials) OR r.id = v_actor THEN
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

-- ============================================================
-- 7. Phân quyền RPC
-- ============================================================

REVOKE ALL ON FUNCTION
  public.ingest_bank_transaction(jsonb), public.list_bank_transactions(jsonb),
  public.confirm_bank_transaction(jsonb), public.link_bank_transaction(jsonb),
  public.ignore_bank_transaction(jsonb), public.get_vietqr_matching_status(uuid),
  public.get_bank_webhook_state()
  FROM public, anon;

-- Ingest: chỉ service_role (GRANT thu hồi khỏi authenticated ở dưới bằng REVOKE riêng).
REVOKE ALL ON FUNCTION public.ingest_bank_transaction(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_bank_transaction(jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION
  public.list_bank_transactions(jsonb), public.confirm_bank_transaction(jsonb),
  public.link_bank_transaction(jsonb), public.ignore_bank_transaction(jsonb),
  public.get_vietqr_matching_status(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_bank_webhook_state() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
