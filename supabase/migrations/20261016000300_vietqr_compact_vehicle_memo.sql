-- Keep the payment reference unchanged; the bank memo contains only its vehicle type.
-- Existing open requests adopt the same format without changing identity or expiry.
BEGIN;

CREATE OR REPLACE FUNCTION private.vietqr_compact_transfer_content(p_reference text, p_vehicle_name text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_reference text := btrim(coalesce(p_reference, ''));
  v_name text := coalesce(nullif(btrim(p_vehicle_name), ''), 'xe');
  v_content text;
BEGIN
  LOOP
    v_content := v_reference || ' (' || v_name || ')';
    IF char_length(v_content) <= 130 AND octet_length(v_content) <= 95 THEN
      RETURN v_content;
    END IF;
    IF v_name = '' THEN RAISE EXCEPTION 'VIETQR_CONTENT_TOO_LONG'; END IF;
    v_name := rtrim(left(v_name, char_length(v_name) - 1));
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION private.vietqr_compact_transfer_content(text, text)
  FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.set_vietqr_compact_transfer_content()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text; v_content text;
BEGIN
  IF NEW.status IN ('PENDING', 'EXPIRED') THEN
    SELECT t.name INTO v_name
    FROM public.vehicles v JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    WHERE v.id = NEW.vehicle_id;
    v_content := private.vietqr_compact_transfer_content(NEW.qr_reference, v_name);
    IF NEW.transfer_content IS DISTINCT FROM v_content THEN
      NEW.transfer_content := v_content;
      NEW.qr_payload := '';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION private.set_vietqr_compact_transfer_content()
  FROM public, anon, authenticated;

CREATE TRIGGER vietqr_compact_transfer_content
  BEFORE INSERT OR UPDATE OF transfer_content ON public.vietqr_requests
  FOR EACH ROW EXECUTE FUNCTION private.set_vietqr_compact_transfer_content();

-- Payer, agreement, reference, timestamps and finalized financial history stay intact.
-- Clearing the optional cached payload prevents an old QR description being reused.
UPDATE public.vietqr_requests q
SET transfer_content = private.vietqr_compact_transfer_content(q.qr_reference, t.name),
    qr_payload = ''
FROM public.vehicles v JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
WHERE q.vehicle_id = v.id AND q.status IN ('PENDING', 'EXPIRED')
  AND (q.transfer_content IS DISTINCT FROM private.vietqr_compact_transfer_content(q.qr_reference, t.name)
       OR q.qr_payload <> '');

CREATE OR REPLACE FUNCTION private.vietqr_match_content(p_content text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_norm text;
BEGIN
  -- The generated memo has a literal space before its parenthesized vehicle name.
  -- Mark that boundary before removing separators so numeric names cannot join the code.
  v_norm := upper(regexp_replace(
    regexp_replace(coalesce(p_content, ''), '[[:space:]]+\(', 'X(', 'g'),
    '[^0-9A-Za-z(]', '', 'g'));
  -- Without that space, a parenthesis after a complete code could be either a
  -- vehicle suffix or a separator inside a longer code. Refuse to choose a request.
  -- Also recognize earlier separator parentheses so they cannot hide this ambiguity.
  IF v_norm ~ 'C\(*A\(*R\(*E\(*M\(*G\(*D\(*[0-9](?:\(*[0-9]){4,17}\(' THEN
    RETURN '';
  END IF;
  RETURN regexp_replace(v_norm, '[^0-9A-Z]', '', 'g');
END;
$$;

REVOKE ALL ON FUNCTION private.vietqr_match_content(text)
  FROM public, anon, authenticated;


-- Preserve the existing ingestion implementation; only memo normalization changes.
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
  v_norm text;
  v_digits text;
  v_count integer;
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
  -- Hòa giải verified-lifecycle: đếm MỌI mã trong memo và giữ nguyên dãy số
  -- (5–18 chữ số, không có chữ số nào nối sau). Cắt bớt digit thừa hay tham
  -- lam greedy bắt mã cuối khi memo có hai mã đều khớp sai, mà khớp sai thì
  -- tiền tự ghi nhầm vào yêu cầu của người khác.
  v_norm := private.vietqr_match_content(v_content);
  SELECT count(*), min(g[1]) INTO v_count, v_digits
    FROM regexp_matches(v_norm, 'CAREMGD([0-9]{5,18})(?![0-9])', 'g') AS g;
  IF v_count = 1 THEN
    v_code := 'CAREM GD' || v_digits;
  ELSE
    v_code := '';
  END IF;

  v_notes := 'Chuyển khoản ' || coalesce(nullif(v_sender_name, ''), 'khách')
             || coalesce(' · ' || nullif(v_code, ''), '');

  IF v_count > 1 THEN
    -- Một memo, hai mã khác nhau: không có quyền đoán tiền thuộc yêu cầu nào.
    v_status := 'MANUAL_REVIEW';
    v_reason := 'AMBIGUOUS_REFERENCE';
  ELSIF v_code <> '' THEN
    SELECT * INTO v_request FROM public.vietqr_requests
      WHERE qr_reference = v_code FOR UPDATE;
    IF FOUND THEN
      -- Hòa giải verified-lifecycle: hết hạn là hết hạn dù sweep chưa chạy.
      -- Đồng bộ trạng thái trước khi phân nhánh để PENDING trong ingest luôn
      -- nghĩa là còn trong cửa sổ, khớp hợp đồng 20261014000400.
      IF v_request.status = 'PENDING' AND v_request.expires_at <= clock_timestamp() THEN
        UPDATE public.vietqr_requests
          SET status = 'EXPIRED', updated_at = clock_timestamp()
          WHERE id = v_request.id;
        v_request.status := 'EXPIRED';
      END IF;
      IF v_request.status = 'PENDING' AND v_request.amount = v_amount
         AND coalesce(v_settings.bank_auto_match_enabled, true)
         AND v_request.bank_account_no IS NOT DISTINCT FROM
             btrim(coalesce(p_data->>'account_number', '')) THEN
        -- Khớp tuyệt đối. Tự ghi chỉ khi chính chủ tạo mã và mã gắn với một đơn.
        v_owner_created := EXISTS (SELECT 1 FROM public.profiles p
                                   WHERE p.id = v_request.created_by
                                     AND p.active AND p.role = 'OWNER');
        IF v_request.sale_id IS NULL THEN
          -- Hòa giải verified-lifecycle: đúng mã, đúng tiền nhưng đơn chưa ra đời
          -- (khách chuyển khoản trước lúc bán) → chỉ gắn bằng chứng, chưa ghi khoản
          -- thu. Hai bên nhận RECEIVED; sell_vehicle sẽ nối chứng từ này vào đơn
          -- đúng lúc lập đơn theo hợp đồng 20261014000400.
          v_status := 'RECEIVED';
          v_reason := 'REFERENCE_AMOUNT_MATCH';
        ELSIF v_owner_created THEN
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
              'request_id', md5(v_provider || ':' || v_txn_id || ':' || v_request.id::text),
              -- Danh tính bằng chứng cho phiếu thu RECORDED (xem record_service_bank_payment).
              'provider', v_provider, 'provider_txn_id', v_txn_id));
            UPDATE public.vietqr_requests
              SET status = 'CONFIRMED', payment_id = v_payment_id,
                  receipt_id = coalesce(receipt_id,
                    (SELECT pr.id FROM public.payment_receipts pr
                     WHERE pr.payment_id = v_payment_id LIMIT 1)),
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
      ELSIF v_request.status = 'EXPIRED' AND v_request.amount = v_amount
            AND coalesce(v_settings.bank_auto_match_enabled, true)
            AND v_request.bank_account_no IS NOT DISTINCT FROM
                btrim(coalesce(p_data->>'account_number', ''))
            AND v_transfer_at < v_request.expires_at
            AND v_request.sale_id IS NULL THEN
        -- Webhook giao muộn nhưng khách chuyển đúng trong đời mã QR: vẫn là bằng
        -- chứng thật → trả mã về RECEIVED (hợp đồng verified-lifecycle 00400).
        v_status := 'RECEIVED';
        v_reason := 'REFERENCE_AMOUNT_MATCH';
      ELSIF v_request.status IN ('PENDING', 'EXPIRED') AND v_request.amount = v_amount THEN
        -- Đúng mã, đúng tiền nhưng trượt một cánh cửa an toàn: chỉ vào hàng đợi xem lại.
        v_status := 'MANUAL_REVIEW';
        v_reason := CASE
          WHEN v_request.bank_account_no IS DISTINCT FROM
               btrim(coalesce(p_data->>'account_number', ''))
            THEN 'ACCOUNT_SNAPSHOT_MISMATCH'
          WHEN NOT coalesce(v_settings.bank_auto_match_enabled, true)
            THEN 'AUTO_MATCH_DISABLED'
          WHEN v_request.status = 'EXPIRED'
            THEN 'REQUEST_EXPIRED'
          ELSE 'REQUEST_NOT_PENDING' END;
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
      -- Ngoại lệ: yêu cầu đã chốt (CONFIRMED/RECEIVED/CANCELLED) mà tiền nữa
      -- vẫn rơi vào cùng mã — đó là khoản thứ hai nghi vấn, chỉ nằm ở hàng
      -- đợi xem lại, không tự mọc thêm phiếu thu trên đơn đã tất toán
      -- (đúng hợp đồng DUPLICATE_REQUEST_CREDIT của 20261014000400).
      IF v_status <> 'RECORDED' AND v_request.sale_id IS NOT NULL
         AND v_request.status IN ('PENDING', 'EXPIRED') THEN
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
    sender_name, sender_bank, account_number, status, match_reason,
    qr_request_id, sale_id, vehicle_id, payment_id, confirmed_by, confirmed_at, raw_payload
  ) VALUES (
    v_provider, v_txn_id, v_amount, v_transfer_at,
    CASE WHEN v_status = 'RECEIVED' AND v_request.id IS NOT NULL THEN v_request.qr_reference
         WHEN v_code <> '' THEN v_code ELSE '' END, v_content,
    v_sender_name, v_sender_bank,
    -- Hòa giải: bản 00400 lưu account_number để record_vietqr_bank_credit đối chiếu
    -- bằng chứng; thiếu cột này phiếu thu nối vào đơn bán sẽ bị từ chối.
    left(btrim(coalesce(p_data->>'account_number', '')), 40),
    v_status, v_reason,
    CASE WHEN v_status <> 'UNMATCHED' THEN v_request.id END,
    CASE WHEN v_status <> 'UNMATCHED' THEN v_request.sale_id END,
    CASE WHEN v_status <> 'UNMATCHED' THEN v_request.vehicle_id END,
    v_payment_id,
    CASE WHEN v_status = 'RECORDED' THEN v_request.created_by END,
    CASE WHEN v_status = 'RECORDED' THEN now() END,
    coalesce(p_data->'raw', '{}'::jsonb)
  ) RETURNING * INTO v_txn;

  -- Hòa giải nền mới: vòng theo dõi phía khách (useVietQrPaymentWatcher) chỉ tin
  -- bằng chứng ngân hàng gắn trên yêu cầu (bank_transaction_id). Tự ghi thành công
  -- thì nối đúng giao dịch vừa chèn vào mã QR tương ứng.
  IF v_status = 'RECORDED' AND v_request.id IS NOT NULL THEN
    UPDATE public.vietqr_requests
      SET bank_transaction_id = v_txn.id, updated_at = now()
      WHERE id = v_request.id AND bank_transaction_id IS NULL;
  END IF;

  -- Tiền về trước khi lập đơn: gắn bằng chứng + trạng thái RECEIVED lên yêu cầu
  -- (đúng hợp đồng verified-lifecycle để watcher và sell_vehicle cùng nhận ra).
  IF v_status = 'RECEIVED' AND v_request.id IS NOT NULL THEN
    UPDATE public.vietqr_requests
      SET status = 'RECEIVED', bank_transaction_id = v_txn.id,
          confirmed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = v_request.id;
  END IF;

  -- RECORDED không chuông riêng: CREATE_PAYMENT từ record_service_bank_payment
  -- đã báo "Thu tiền đơn …" rồi. Ghi audit vẫn có để lần theo dấu vết.
  PERFORM private.audit(
    CASE v_status
      WHEN 'RECORDED' THEN 'BANK_TRANSACTION_AUTO_RECORDED'
      WHEN 'MATCHED_PENDING' THEN 'BANK_TRANSACTION_MATCHED'
      WHEN 'RECEIVED' THEN 'BANK_TRANSACTION_MATCHED'
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

NOTIFY pgrst, 'reload schema';
COMMIT;
