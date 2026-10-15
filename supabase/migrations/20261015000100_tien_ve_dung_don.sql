-- Migration: 20261015000100_tien_ve_dung_don.sql
-- Tiền về rơi thẳng vào đơn — bỏ khái niệm "đối soát" khỏi luồng nghiệp vụ.
--
-- Nguyên tắc đã chốt (docs/DECISIONS.md, mục "Tiền về rơi thẳng vào đơn"):
--   * Máy chắc chắn thì máy làm: giao dịch khớp đúng mã + đúng tiền VÀ mã do chính
--     OWNER tạo → tự ghi nhận khoản thu, không chờ ai bấm nút.
--   * Máy không chắc thì hỏi đúng chỗ: mọi trường hợp còn mà xác định được đơn
--     (lệch tiền, mã đã huỷ, mã đã ghi nhận, tắt tự khớp) → ném vào hàng đợi
--     public.payment_receipts của chính đơn đó. Hàng đợi này ĐÃ có UI trên trang
--     đơn bán (PaymentReceiptReview) và đã có đường duyệt an toàn qua
--     public.add_payment (bắt buộc OWNER/MANAGER + bằng chứng xác minh).
--     → Không dựng màn hình mới, không dựng hàng đợi mới.
--   * Không có auth.uid() trong webhook, nên mọi hàm ghi tiền hiện có
--     (private.require_role) đều chết với 42501. Vì vậy cần đúng MỘT đường ghi mới
--     private.record_service_bank_payment, chỉ service_role gọi được, tự tái lập
--     toàn bộ chốt chặn của private.add_payment_verified_impl. Không nới hàm cũ.
--   * Chủ trương phân tách trách nhiệm vẫn sống: mã do STAFF/MANAGER tạo thì tiền
--     về KHÔNG tự vào sổ — người tạo mã không được là người tự duyệt tiền của mình.
--   * Forward-only: không xoá cột, không đổi ngữ nghĩa giá trị cũ, chỉ thêm.

BEGIN;

-- ============================================================
-- 1. Thêm hai lý do khớp mới (giữ nguyên mọi giá trị cũ)
-- ============================================================

ALTER TABLE public.bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_match_reason_check;
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_match_reason_check CHECK (match_reason IN (
    '', 'REFERENCE_AMOUNT_MATCH', 'AMOUNT_MISMATCH', 'REQUEST_NOT_PENDING',
    'REFERENCE_FOUND_NO_REQUEST', 'NO_REFERENCE', 'MANUAL_LINK', 'AUTO_MATCH_DISABLED',
    'AUTO_RECORDED', 'PENDING_OWNER_APPROVAL'));

COMMENT ON COLUMN public.bank_transactions.match_reason IS
  'AUTO_RECORDED = tiền đã tự vào sổ (khớp tuyệt đối, mã do OWNER tạo); PENDING_OWNER_APPROVAL = khớp tuyệt đối nhưng mã do nhân viên tạo nên phải chờ chủ duyệt.';

-- ============================================================
-- 2. Đường ghi tiền riêng cho webhook (chỉ service_role)
-- ============================================================
-- Tái lập đúng các chốt chặn của private.add_payment_verified_impl:
--   khóa vehicle -> sale (thứ tự chống deadlock như mọi writer tài chính),
--   đơn phải COMPLETED, ngày trong khoảng [sale_date, today],
--   số dư không được vượt giá bán, audit CREATE_PAYMENT.
-- Khác biệt có chủ đích: không có private.require_role (webhook vô danh), thay vào
-- đó bắt buộc p_actor là một OWNER đang active — nên tiền chỉ tự vào sổ khi chính
-- chủ tạo mã, và dấu vết vẫn trỏ về một người thật.

CREATE OR REPLACE FUNCTION private.record_service_bank_payment(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_sale_id uuid := nullif(p_data->>'sale_id', '')::uuid;
  v_payment_id uuid := nullif(p_data->>'request_id', '')::uuid;
  v_vehicle uuid;
  v_sale public.sales;
  v_payment public.payments;
  v_paid bigint;
  v_amount bigint := private.money_input(p_data, 'amount');
  v_date date := coalesce(nullif(p_data->>'payment_date', '')::date, private.today());
  v_reference text := left(btrim(coalesce(p_data->>'reference', '')), 200);
  v_notes text := left(coalesce(p_data->>'notes', ''), 2000);
BEGIN
  IF NOT private.is_service_role() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR v_sale_id IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  v_actor := nullif(p_data->>'actor', '')::uuid;
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p
                                    WHERE p.id = v_actor AND p.active AND p.role = 'OWNER') THEN
    RAISE EXCEPTION USING errcode='42501', message='PAYMENT_OWNER_REQUIRED';
  END IF;

  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id = v_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='SALE_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.vehicles WHERE id = v_vehicle FOR UPDATE;
  SELECT * INTO v_sale FROM public.sales WHERE id = v_sale_id FOR UPDATE;

  -- Idempotency theo request_id: cùng một lần ghi không tạo hai khoản thu.
  IF v_payment_id IS NOT NULL THEN
    SELECT * INTO v_payment FROM public.payments WHERE id = v_payment_id;
    IF FOUND THEN
      IF v_payment.sale_id IS DISTINCT FROM v_sale_id
         OR v_payment.amount IS DISTINCT FROM v_amount
         OR v_payment.created_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION USING errcode='22023', message='PAYMENT_REQUEST_CONFLICT';
      END IF;
      RETURN v_payment.id;
    END IF;
  END IF;

  IF v_sale.status <> 'COMPLETED' THEN
    RAISE EXCEPTION USING errcode='22023', message='SALE_CANCELLED';
  END IF;
  IF v_date < v_sale.sale_date OR v_date > private.today() THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_PAYMENT_DATE';
  END IF;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_paid
    FROM public.payments WHERE sale_id = v_sale_id AND status = 'ACTIVE';
  IF v_amount IS NULL OR v_amount <= 0 OR v_paid + v_amount > v_sale.sale_price THEN
    RAISE EXCEPTION USING errcode='22023', message='PAYMENT_EXCEEDS_BALANCE';
  END IF;

  INSERT INTO public.payments(id, sale_id, amount, payment_method, payment_date,
                              reference, notes, created_by)
  VALUES (coalesce(v_payment_id, gen_random_uuid()), v_sale_id, v_amount, 'BANK_TRANSFER',
          v_date, v_reference, v_notes, v_actor)
  RETURNING * INTO v_payment;

  PERFORM private.audit('CREATE_PAYMENT', 'payments', v_payment.id, null,
                        to_jsonb(v_payment), v_vehicle);
  RETURN v_payment.id;
END $$;

REVOKE ALL ON FUNCTION private.record_service_bank_payment(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.record_service_bank_payment(jsonb) TO service_role;

-- ============================================================
-- 3. Đưa một khoản tiền về vào hàng đợi phiếu thu của đơn
-- ============================================================
-- public.payment_receipts là hàng đợi "chờ xác minh" sẵn có (migration
-- 20261006001100). Phiếu thu KHÔNG đụng số dư — chỉ là đề xuất — nên ghi vô điều
-- kiện an toàn; người duyệt vẫn là add_payment (OWNER/MANAGER + verification_reference).
-- Danh tính nghiệp vụ (BANK_TRANSACTION, provider, provider_txn_id) có UNIQUE index
-- nên một giao dịch ngân hàng chỉ tạo tối đa một phiếu thu.
-- Hai đường gọi: webhook (vô danh, service_role) và link_bank_transaction (người thật,
-- can_financials) — nên quyền nằm ở chính hàm gọi, hàm này chỉ là công cụ nội bộ
-- trong schema private, đã REVOKE khỏi anon/authenticated.

CREATE OR REPLACE FUNCTION private.enqueue_bank_receipt(
  p_sale_id uuid,
  p_amount bigint,
  p_transfer_at timestamptz,
  p_reference text,
  p_notes text,
  p_provider text,
  p_provider_txn_id text,
  p_author uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_sale public.sales;
  v_receipt public.payment_receipts;
  v_id uuid := gen_random_uuid();
  v_date date;
  v_scope text := upper(btrim(coalesce(p_provider, '')));
  v_evidence text := btrim(coalesce(p_provider_txn_id, ''));
  v_author uuid;
BEGIN
  IF p_sale_id IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR length(v_scope) NOT BETWEEN 1 AND 120 OR length(v_evidence) NOT BETWEEN 3 AND 200 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND OR v_sale.status <> 'COMPLETED' THEN RETURN NULL; END IF;

  -- Một lần ghi duy nhất cho một giao dịch ngân hàng.
  SELECT * INTO v_receipt FROM public.payment_receipts
    WHERE evidence_kind = 'BANK_TRANSACTION' AND evidence_scope = v_scope
      AND evidence_reference = v_evidence AND status <> 'REJECTED';
  IF FOUND THEN RETURN v_receipt.id; END IF;

  -- Ngày thu: kẹp vào khoảng hợp lệ của đơn để lúc duyệt không bị INVALID_PAYMENT_DATE.
  v_date := least(greatest(coalesce(p_transfer_at, clock_timestamp())::date,
                           v_sale.sale_date), private.today());

  -- Tác giả phiếu phải là người còn tồn tại: người tạo mã -> người bán -> một OWNER.
  v_author := COALESCE(
    (SELECT p.id FROM public.profiles p WHERE p.id = p_author AND p.active),
    (SELECT p.id FROM public.profiles p WHERE p.id = v_sale.sold_by AND p.active),
    (SELECT p.id FROM public.profiles p WHERE p.role = 'OWNER' AND p.active
     ORDER BY p.created_at LIMIT 1));
  IF v_author IS NULL THEN RETURN NULL; END IF;

  BEGIN
    INSERT INTO public.payment_receipts(id, sale_id, amount, payment_method, payment_date,
                                        reference, notes, evidence_kind, evidence_scope,
                                        evidence_reference, created_by)
    VALUES (v_id, p_sale_id, p_amount, 'BANK_TRANSFER', v_date,
            left(btrim(coalesce(p_reference, '')), 200),
            left(coalesce(p_notes, ''), 2000),
            'BANK_TRANSACTION', v_scope, v_evidence, v_author)
    RETURNING * INTO v_receipt;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_receipt FROM public.payment_receipts
      WHERE evidence_kind = 'BANK_TRANSACTION' AND evidence_scope = v_scope
        AND evidence_reference = v_evidence AND status <> 'REJECTED';
    RETURN v_receipt.id;
  END;

  PERFORM private.audit('PREPARE_PAYMENT_RECEIPT', 'payment_receipts', v_receipt.id, null,
                        to_jsonb(v_receipt), v_sale.vehicle_id);
  RETURN v_receipt.id;
END $$;

REVOKE ALL ON FUNCTION private.enqueue_bank_receipt(uuid, bigint, timestamptz, text, text,
                                                    text, text, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.enqueue_bank_receipt(uuid, bigint, timestamptz, text, text,
                                                       text, text, uuid) TO service_role;

-- ============================================================
-- 4. Phân loại lại giao dịch về: tự ghi hoặc rơi đúng vào đơn
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
  v_payment_id uuid;
  v_receipt_id uuid;
  v_owner_created boolean := false;
  v_notes text;
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

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_provider || ':' || v_txn_id, 20261014));

  SELECT * INTO v_existing FROM public.bank_transactions
    WHERE provider = v_provider AND provider_txn_id = v_txn_id;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_existing.id, 'status', v_existing.status,
                              'duplicate', true);
  END IF;

  -- Trích mã CAREM GDxxxxx (bỏ mọi ký tự phân tách; bắt buộc tiền tố CAREMGD).
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

  v_notes := 'Chuyển khoản ' || coalesce(nullif(v_sender_name, ''), 'khách')
             || coalesce(' · ' || nullif(v_code, ''), '');

  IF v_code <> '' THEN
    SELECT * INTO v_request FROM public.vietqr_requests
      WHERE qr_reference = v_code FOR UPDATE;
    IF FOUND THEN
      IF v_request.status = 'PENDING' AND v_request.amount = v_amount
         AND coalesce(v_settings.bank_auto_match_enabled, true) THEN
        -- Khớp tuyệt đối. Tự ghi chỉ khi chính chủ tạo mã và mã gắn với một đơn.
        v_owner_created := EXISTS (SELECT 1 FROM public.profiles p
                                   WHERE p.id = v_request.created_by
                                     AND p.active AND p.role = 'OWNER');
        IF v_owner_created AND v_request.sale_id IS NOT NULL THEN
          BEGIN
            v_payment_id := private.record_service_bank_payment(jsonb_build_object(
              'sale_id', v_request.sale_id,
              'amount', v_amount,
              'payment_date', v_transfer_at::date,
              'reference', v_request.qr_reference,
              'notes', v_notes,
              'actor', v_request.created_by,
              -- request_id phải là uuid: md5() cho 32 ký tự hex, cast thẳng được uuid.
              -- Deterministic theo từng giao dịch ngân hàng → webhook gửi lại không tạo
              -- khoản thu thứ hai.
              'request_id', md5(v_provider || ':' || v_txn_id || ':' || v_request.id::text)));
            UPDATE public.vietqr_requests
              SET status = 'CONFIRMED', payment_id = v_payment_id,
                  confirmed_by = v_request.created_by, confirmed_at = now(),
                  updated_at = now()
              WHERE id = v_request.id;
            PERFORM private.audit('CONFIRM_VIETQR_PAYMENT', 'vietqr_requests', v_request.id,
                                  null, jsonb_build_object('payment_id', v_payment_id,
                                                           'auto', true), v_request.vehicle_id);
            v_status := 'RECORDED';
            v_reason := 'AUTO_RECORDED';
          EXCEPTION WHEN OTHERS THEN
            -- Không ghi được (vượt số dư, ngày ngoài khoảng, đơn đã huỷ…) → subtransaction
            -- rollback nên không thể có khoản thu nửa vời. Tiền vẫn được đưa về đúng đơn
            -- dưới dạng phiếu chờ, chủ bấm duyệt.
            v_payment_id := NULL;
            v_status := 'MATCHED_PENDING';
            v_reason := 'PENDING_OWNER_APPROVAL';
          END;
        ELSE
          v_status := 'MATCHED_PENDING';
          v_reason := 'PENDING_OWNER_APPROVAL';
        END IF;
      ELSIF v_request.status = 'PENDING' AND v_request.amount <> v_amount THEN
        -- Đúng mã, sai tiền: không tiết lộ số đúng là bao nhiêu.
        v_status := 'MANUAL_REVIEW';
        v_reason := 'AMOUNT_MISMATCH';
      ELSIF v_request.status = 'PENDING' THEN
        v_status := 'MANUAL_REVIEW';
        v_reason := 'AUTO_MATCH_DISABLED';
      ELSE
        v_status := 'MANUAL_REVIEW';
        v_reason := 'REQUEST_NOT_PENDING';
      END IF;

      -- Mọi ca chưa tự ghi mà biết đơn → phiếu chờ ngay trên đơn đó.
      IF v_status <> 'RECORDED' AND v_request.sale_id IS NOT NULL THEN
        v_receipt_id := private.enqueue_bank_receipt(
          v_request.sale_id, v_amount, v_transfer_at,
          coalesce(nullif(v_code, ''), v_request.qr_reference), v_notes,
          v_provider, v_txn_id, v_request.created_by);
      END IF;
    ELSE
      v_status := 'UNMATCHED';
      v_reason := 'REFERENCE_FOUND_NO_REQUEST';
    END IF;
  END IF;

  INSERT INTO public.bank_transactions (
    provider, provider_txn_id, amount, transfer_at, reference, transfer_content,
    sender_name, sender_bank, status, match_reason,
    qr_request_id, sale_id, vehicle_id, payment_id, confirmed_by, confirmed_at, raw_payload
  ) VALUES (
    v_provider, v_txn_id, v_amount, v_transfer_at,
    CASE WHEN v_code <> '' THEN v_code ELSE '' END, v_content,
    v_sender_name, v_sender_bank, v_status, v_reason,
    CASE WHEN v_status <> 'UNMATCHED' THEN v_request.id END,
    CASE WHEN v_status <> 'UNMATCHED' THEN v_request.sale_id END,
    CASE WHEN v_status <> 'UNMATCHED' THEN v_request.vehicle_id END,
    v_payment_id,
    CASE WHEN v_status = 'RECORDED' THEN v_request.created_by END,
    CASE WHEN v_status = 'RECORDED' THEN now() END,
    coalesce(p_data->'raw', '{}'::jsonb)
  ) RETURNING * INTO v_txn;

  -- RECORDED không chuông riêng: CREATE_PAYMENT từ record_service_bank_payment
  -- đã báo "Thu tiền đơn …" rồi. Ghi audit vẫn có để lần theo dấu vết.
  PERFORM private.audit(
    CASE v_status
      WHEN 'RECORDED' THEN 'BANK_TRANSACTION_AUTO_RECORDED'
      WHEN 'MATCHED_PENDING' THEN 'BANK_TRANSACTION_MATCHED'
      WHEN 'MANUAL_REVIEW' THEN 'BANK_TRANSACTION_REVIEW'
      ELSE 'BANK_TRANSACTION_UNMATCHED'
    END,
    'bank_transactions', v_txn.id, null,
    jsonb_build_object(
      'provider', v_txn.provider, 'amount', v_txn.amount, 'reference', v_txn.reference,
      'status', v_txn.status, 'match_reason', v_txn.match_reason,
      'qr_request_id', v_txn.qr_request_id, 'sale_id', v_txn.sale_id,
      'vehicle_id', v_txn.vehicle_id, 'payment_receipt_id', v_receipt_id,
      'payment_id', v_txn.payment_id
    ),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                            'payment_id', v_txn.payment_id);
END $$;

-- ============================================================
-- 5. Chuông báo dẫn thẳng về đơn, không dẫn vào mục đối soát
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
  v_extra uuid;
  v_title text;
  v_body_money text;
  v_body_plain text;
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

  -- ============ Tiền về từ ngân hàng ============
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

    -- Tiền đã biết đơn thì dẫn về đơn. Chỉ khoản không nhận diện được mới ở trang chủ.
    v_link := CASE WHEN v_sale IS NOT NULL THEN '/sales/' || v_sale::text ELSE '/dashboard' END;

    IF v_action = 'BANK_TRANSACTION_MATCHED' THEN
      v_title := left('Tiền đã về — chờ ghi nhận', 160);
      v_body_money := 'Nhận ' || private.money_text(v_amount)
        || coalesce(' cho đơn ' || v_label, '')
        || coalesce(' (' || nullif(v_new ->> 'reference', '') || ')', '')
        || ' — bạn duyệt để ghi vào sổ.';
      v_body_plain := 'Một khoản chuyển khoản đã về, đang chờ ghi nhận.';
    ELSIF v_action = 'BANK_TRANSACTION_REVIEW' THEN
      v_title := left('Tiền về chưa khớp, cần xem lại', 160);
      v_body_money := 'Nhận ' || private.money_text(v_amount)
        || coalesce(' cho đơn ' || v_label, '')
        || coalesce(' (nội dung "' || nullif(v_new ->> 'reference', '') || '")', '')
        || ' — chưa khớp số tiền cần ghi nhận.';
      v_body_plain := 'Một khoản chuyển khoản về chưa khớp, cần người xem lại.';
    ELSE -- BANK_TRANSACTION_UNMATCHED: không nhận diện được đơn nào.
      v_title := left('Tiền về chưa rõ của đơn nào', 160);
      v_body_money := 'Nhận ' || private.money_text(v_amount)
        || ' nhưng chưa tìm ra đơn phù hợp — xem ở trang chủ.';
      v_body_plain := 'Có khoản chuyển khoản mới chưa rõ của đơn nào.';
    END IF;

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

    RETURN NEW;
  END IF;

  -- ============ Lời cảm ơn thủ công qua kênh cá nhân đã xác minh ============
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
    ELSE
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

  FOR r IN
    SELECT p.id, p.role, p.can_view_financials FROM public.profiles p
    WHERE p.id = v_actor
       OR (p.role IN ('OWNER', 'MANAGER') AND p.active)
       OR (v_extra IS NOT NULL AND p.id = v_extra AND p.active
           AND (v_actor IS NULL OR p.id <> v_actor))
    GROUP BY p.id, p.role, p.can_view_financials
  LOOP
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
-- 6. Bản ghi đối soát còn sót: bỏ chữ "đối soát" trong câu chữ, dẫn về đơn
-- ============================================================

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

  IF v_txn.status = 'RECORDED' THEN
    RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                              'payment_id', v_txn.payment_id);
  END IF;
  IF v_txn.status NOT IN ('MATCHED_PENDING', 'MANUAL_REVIEW') OR v_txn.qr_request_id IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_NOT_CONFIRMABLE';
  END IF;

  SELECT * INTO v_qr FROM public.vietqr_requests WHERE id=v_txn.qr_request_id FOR UPDATE;
  IF v_qr.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='VIETQR_REQUEST_NOT_PENDING';
  END IF;
  IF v_qr.amount IS DISTINCT FROM v_txn.amount THEN
    RAISE EXCEPTION USING errcode='22023', message='BANK_TRANSACTION_AMOUNT_MISMATCH';
  END IF;
  v_request_id := nullif(p_data->>'request_id', '')::uuid;

  v_payment_id := public.confirm_vietqr_payment(jsonb_build_object(
    'qr_request_id', v_txn.qr_request_id,
    'request_id', coalesce(v_request_id::text, gen_random_uuid()::text),
    'payment_date', coalesce(nullif(p_data->>'payment_date', '')::text, private.today()::text),
    'notes', coalesce(p_data->>'notes',
                      'Chuyển khoản ' || coalesce(nullif(v_txn.reference, ''), v_txn.provider_txn_id))
  ));

  UPDATE public.bank_transactions
    SET status = 'RECORDED', payment_id = v_payment_id,
        confirmed_by = v_actor, confirmed_at = now()
    WHERE id = v_txn.id RETURNING * INTO v_txn;

  -- Phiếu chờ do webhook tạo ra nay đã có khoản thu thật → đóng nó, tránh trùng lặp.
  UPDATE public.payment_receipts
    SET status = 'RECORDED', payment_id = v_payment_id, verified_by = v_actor,
        verification_reference = 'Ghi nhận từ khoản tiền về ' || v_txn.provider_txn_id,
        verified_at = clock_timestamp()
    WHERE evidence_kind = 'BANK_TRANSACTION' AND evidence_scope = v_txn.provider
      AND evidence_reference = v_txn.provider_txn_id AND status = 'PENDING';

  PERFORM private.audit('BANK_TRANSACTION_RECORDED', 'bank_transactions', v_txn.id,
    null, jsonb_build_object('payment_id', v_payment_id, 'qr_request_id', v_txn.qr_request_id,
                             'reference', v_txn.reference, 'sale_id', v_txn.sale_id),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                            'payment_id', v_payment_id);
END $$;

-- ============================================================
-- 7. Đóng vòng tiền: duyệt một phiếu thu thì khoản đó biến mất khỏi mọi hàng đợi
-- ============================================================
-- Trang đối soát đã bỏ nên hàng đợi phiếu thu trên đơn là chỗ DUY NHẤT chủ quán bấm
-- duyệt. add_payment chỉ ghi payments; nếu bank_transactions/vietqr_requests ở lại
-- trạng thái chờ thì modal QR mãi hiện "đang chờ tiền về" và một lần bấm nữa dễ thành
-- khoản thu thứ hai. Trigger này gắn đúng phần còn thiếu, không sửa add_payment.

CREATE OR REPLACE FUNCTION private.close_bank_loop_for_recorded_receipt()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_txn public.bank_transactions;
BEGIN
  IF NEW.status <> 'RECORDED' OR OLD.status = 'RECORDED'
     OR NEW.evidence_kind IS DISTINCT FROM 'BANK_TRANSACTION' OR NEW.payment_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions
    WHERE upper(btrim(provider)) = NEW.evidence_scope
      AND provider_txn_id = NEW.evidence_reference
      AND status NOT IN ('RECORDED', 'IGNORED')
    FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE public.bank_transactions
    SET status = 'RECORDED', payment_id = NEW.payment_id,
        confirmed_by = NEW.verified_by, confirmed_at = clock_timestamp()
    WHERE id = v_txn.id;

  IF v_txn.qr_request_id IS NOT NULL THEN
    UPDATE public.vietqr_requests
      SET status = 'CONFIRMED', payment_id = NEW.payment_id,
          confirmed_by = NEW.verified_by, confirmed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = v_txn.qr_request_id AND status = 'PENDING';
  END IF;

  PERFORM private.audit('BANK_TRANSACTION_RECORDED', 'bank_transactions', v_txn.id,
    jsonb_build_object('status', v_txn.status, 'match_reason', v_txn.match_reason),
    jsonb_build_object('status', 'RECORDED', 'payment_id', NEW.payment_id,
                       'payment_receipt_id', NEW.id, 'source', 'RECEIPT_APPROVAL'),
    v_txn.vehicle_id);
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION private.close_bank_loop_for_recorded_receipt()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS payment_receipts_close_bank_loop ON public.payment_receipts;
CREATE TRIGGER payment_receipts_close_bank_loop
  AFTER UPDATE OF status ON public.payment_receipts
  FOR EACH ROW EXECUTE FUNCTION private.close_bank_loop_for_recorded_receipt();

-- Gán tay một khoản về vào mã QR: từ đây nó cũng hiện trên đơn, không còn nằm ở
-- đâu đó người duyệt không nhìn thấy.
CREATE OR REPLACE FUNCTION public.link_bank_transaction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_txn public.bank_transactions;
  v_request public.vietqr_requests;
  v_ref text;
  v_receipt_id uuid;
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

  -- Người gán vẫn phải duyệt ở đơn: link chỉ đề xuất, không tự đụng số dư.
  v_receipt_id := private.enqueue_bank_receipt(
    v_request.sale_id, v_txn.amount, v_txn.transfer_at, v_request.qr_reference,
    'Chuyển khoản ' || coalesce(nullif(v_txn.reference, ''), v_txn.provider_txn_id),
    v_txn.provider, v_txn.provider_txn_id, v_actor);

  PERFORM private.audit('BANK_TRANSACTION_LINKED', 'bank_transactions', v_txn.id,
    null, jsonb_build_object('qr_request_id', v_request.id, 'reference', v_request.qr_reference,
                             'sale_id', v_txn.sale_id, 'payment_receipt_id', v_receipt_id),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status,
                            'qr_request_id', v_txn.qr_request_id);
END $$;

-- Bỏ một khoản khỏi hàng đợi: phiếu chờ sinh từ nó phải đóng theo, không để nó
-- treo mãi trên đơn của khách.
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

  UPDATE public.payment_receipts
    SET status = 'REJECTED', verified_by = v_actor, rejection_reason = v_reason,
        verified_at = clock_timestamp()
    WHERE evidence_kind = 'BANK_TRANSACTION' AND evidence_scope = upper(btrim(v_txn.provider))
      AND evidence_reference = v_txn.provider_txn_id AND status = 'PENDING';

  PERFORM private.audit('BANK_TRANSACTION_IGNORED', 'bank_transactions', v_txn.id,
    null, jsonb_build_object('reason', v_reason, 'reference', v_txn.reference),
    v_txn.vehicle_id);

  RETURN jsonb_build_object('id', v_txn.id, 'status', v_txn.status);
END $$;

COMMENT ON COLUMN public.system_settings.bank_auto_match_enabled IS
  'Bật: giao dịch khớp tuyệt đối trên mã do OWNER tạo sẽ tự ghi nhận vào đơn. Tắt: mọi khoản về đều thành phiếu chờ trên đơn để người duyệt.';

NOTIFY pgrst, 'reload schema';
COMMIT;
