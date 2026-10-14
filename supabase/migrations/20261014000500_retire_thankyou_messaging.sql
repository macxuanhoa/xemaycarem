-- =========================================================================
-- RETIRE THANK-YOU & CUSTOMER MESSAGING (CHĂM SÓC KHÁCH HÀNG) — CLEANUP
-- =========================================================================
-- ⚠️ THAO TÁC PHÁ HỦY — KHÔNG ÁP DỤNG (db push) KHI CHƯA CÓ:
--   1) Phê duyệt tường minh của OWNER cho việc DROP các bảng/RPC bên dưới,
--   2) Bản dump dữ liệu cùng ngày theo quy trình backup hiện hành
--      (carem-prod-<timestamp>-data.sql + storage),
--   3) Kế hoạch gỡ Edge Function `process-message` khỏi hosting trong cùng
--      cửa sổ release (xóa thư mục supabase/functions/process-message và
--      block [functions.process-message] trong supabase/config.toml),
--   4) Xóa các test backend đi kèm: tests/db/message-delivery-trust.test.mjs,
--      tests/db/message-leases.test.mjs, tests/unit/communication-provider.test.ts,
--      tests/unit/messageWorkerRecovery.test.ts và phần message/contact trong
--      tests/db/smart-sales-automation.test.mjs, tests/db/operational-features.test.mjs.
-- Frontend đã ngừng mọi luồng gọi xuống đây (bằng chứng: không còn consumer
-- trong src/ — toàn bộ UI lời cảm ơn/mẫu tin/liên hệ kênh đã được xóa).
--
-- Phạm vi: CHỈ gỡ lời cảm ơn sau bán + tin nhắn chăm sóc khách hàng.
-- KHÔNG đụng: VietQR, SePay webhook + HMAC, đối soát ngân hàng, ghi nhận
-- khoản thu, RLS/phân quyền, chống ghi nhận trùng, lịch sử giao dịch,
-- notification hệ thống (audit fan-out cho bán/ch thu/đối soát vẫn giữ).
-- Lịch sử cũ trong các bảng sẽ mất khi DROP — đó là lý do cần dump trước.
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1) save_settings: bỏ hoàn toàn cờ cảm ơn + kênh nhắn tin.
--    (Bản hiện hành = 20261014000100, cắt các trường: customer_messaging_enabled,
--     sale_thank_you_enabled, primary_message_channel, fallback_channel,
--     thankyou_manual_enabled. support_phone GIỮ LẠI — là thông tin cửa hàng.)
-- ---------------------------------------------------------------------
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

  -- Payment automation settings
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

  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;

  -- Nếu bật VietQR, yêu cầu phải có đủ thông tin ngân hàng
  IF coalesce(v_vietqr_enabled, (v_old->>'vietqr_enabled')::boolean, false) THEN
    IF nullif(coalesce(v_bank_bin, v_old->>'bank_bin', ''), '') IS NULL
       OR nullif(coalesce(v_account_no, v_old->>'bank_account_no', ''), '') IS NULL
       OR nullif(coalesce(v_account_name, v_old->>'bank_account_name', ''), '') IS NULL THEN
      RAISE EXCEPTION USING errcode='22023',message='VIETQR_CONFIG_REQUIRED';
    END IF;
  END IF;
  -- Webhook chi co nghia khi co tai khoan nhan tien.
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
      ELSE 'SETTINGS_CHANGED'
    END,
    'system_settings',null,v_old,v_new);
END $$;

-- ---------------------------------------------------------------------
-- 2) notify_from_audit: bỏ nhánh VERIFY_SALE_CONTACT (thay đổi hiện hành
--    duy nhất so với bản 20261014000100). Mọi nhánh notification hệ thống
--    (bán, thu tiền, đối soát ngân hàng, duyệt giá...) GIỮ NGUYÊN.
-- ---------------------------------------------------------------------
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
  r record;
BEGIN
  IF v_action NOT IN ('CREATE_ACQUISITION','CANCEL_ACQUISITION','CREATE_SALE','CANCEL_SALE',
                      'CREATE_PAYMENT','VOID_PAYMENT','CREATE_VEHICLE','UPDATE_VEHICLE',
                      'REQUEST_DELETE_VEHICLE',
                      'REQUEST_SALE_BELOW_COST','APPROVE_SALE_BELOW_COST',
                      'REJECT_SALE_BELOW_COST','CANCEL_SALE_BELOW_COST',
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

-- ---------------------------------------------------------------------
-- 3) sell_vehicle_impl: bỏ hoàn toàn khối QUEUED lời cảm ơn (outbox +
--    customer_communications + audit AUTO_MESSAGE_*). Giao dịch bán, khoản
--    thu đầu, snapshot giá vốn/chi phí, audit CREATE_SALE, anti-oracle gate
--    giữ nguyên 100% như bản 20261014000100.
-- ---------------------------------------------------------------------
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
  RETURN v_sale.id;
END $fn$;

-- ---------------------------------------------------------------------
-- 4) Gỡ RPC lời cảm ơn / liên hệ kênh / mẫu tin / outbox worker.
--    Mọi overload từng tồn tại được liệt kê đầy đủ; IF EXISTS để an toàn
--    với chuỗi migration đã apply.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_sale_communication(uuid);
DROP FUNCTION IF EXISTS public.list_customer_communications(text);
DROP FUNCTION IF EXISTS public.retry_sale_thank_you(uuid);
DROP FUNCTION IF EXISTS public.claim_message(uuid);
DROP FUNCTION IF EXISTS public.claim_message(uuid, text);
DROP FUNCTION IF EXISTS public.finish_mock_message(uuid, text);
DROP FUNCTION IF EXISTS public.finish_mock_message(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.fail_message(uuid, text, text, boolean);
DROP FUNCTION IF EXISTS public.fail_message(uuid, text, text, boolean, uuid);
DROP FUNCTION IF EXISTS public.skip_message(uuid, text, text);
DROP FUNCTION IF EXISTS public.skip_message(uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public.renew_message_lease(uuid, uuid);
DROP FUNCTION IF EXISTS public.finish_message(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.mark_message_delivered(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.resolve_message_delivery(uuid, text, text);
DROP FUNCTION IF EXISTS public.list_sale_contacts(uuid);
DROP FUNCTION IF EXISTS public.list_automation_contacts(integer);
DROP FUNCTION IF EXISTS public.save_sale_contact(jsonb);
DROP FUNCTION IF EXISTS public.verify_sale_contact(jsonb);
DROP FUNCTION IF EXISTS public.delete_sale_contact(uuid);
DROP FUNCTION IF EXISTS public.mark_thank_you_copied(uuid);
DROP FUNCTION IF EXISTS public.mark_personal_thank_you_sent(jsonb);
DROP FUNCTION IF EXISTS public.list_sale_thank_you_queue(uuid);
DROP FUNCTION IF EXISTS public.list_message_templates();
DROP FUNCTION IF EXISTS public.preview_message_template(jsonb);
DROP FUNCTION IF EXISTS public.save_message_template(jsonb);
DROP FUNCTION IF EXISTS private.lock_message_lease(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS private.lock_trusted_message_lease(uuid, uuid);

-- ---------------------------------------------------------------------
-- 5) Xóa bảng (kèm RLS policies/indexes/FK của chính chúng).
--    ⚠️ MẤT LỊCH SỬ tin đã gửi — cần dump trước khi apply.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS public.message_outbox CASCADE;
DROP TABLE IF EXISTS public.customer_communications CASCADE;
DROP TABLE IF EXISTS public.customer_contacts CASCADE;
DROP TABLE IF EXISTS public.message_templates CASCADE;

-- ---------------------------------------------------------------------
-- 6) Xóa cột cấu hình cảm ơn / kênh nhắn tin (kèm CHECK đi theo).
--    support_phone là thông tin liên hệ cửa hàng — GIỮ LẠI.
-- ---------------------------------------------------------------------
ALTER TABLE public.system_settings
  DROP COLUMN IF EXISTS thankyou_manual_enabled,
  DROP COLUMN IF EXISTS customer_messaging_enabled,
  DROP COLUMN IF EXISTS sale_thank_you_enabled,
  DROP COLUMN IF EXISTS primary_message_channel,
  DROP COLUMN IF EXISTS fallback_channel;
