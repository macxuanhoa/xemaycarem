-- 16/10/2026: Chuông thông báo hiển thị tên cửa hàng thay vì tên nhân viên
-- trong dòng body các sự kiện nghiệp vụ (thu, bán, hủy, cập nhật xe).
-- Chủ quán đọc chuông muốn biết "Cà Rem đã thu vào xe…" (sự việc của cửa hàng)
-- thay vì "Nguyễn Văn A đã thu vào xe…" — ai làm đã có hồ sơ audit riêng.
--
-- Giữ nguyên v_actor_name cho nhánh phê duyệt (REQUEST/APPROVE/REJECT/CANCEL
-- _SALE_BELOW_COST, REQUEST_DELETE_VEHICLE) vì ở đó danh tính người quyết định
-- là thông tin bắt buộc.
--
-- Forward-only: CREATE OR REPLACE, không xóa dữ liệu, không đổi schema.
-- Notification cũ vẫn giữ body nguyên văn lúc ghi — chỉ tin mới đổi format.

CREATE OR REPLACE FUNCTION private.notify_from_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text := NEW.action;
  v_actor uuid := coalesce(NEW.user_id, auth.uid());
  v_new jsonb := coalesce(NEW.new_data, '{}'::jsonb);
  v_actor_name text;
  v_store_name text;
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

  -- Dedup: CREATE_VEHICLE issued inside acquire_vehicle must not double-notify.
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
  -- Tên cửa hàng dùng làm "chủ thể" trong body thông báo nghiệp vụ.
  SELECT coalesce(store_name, 'Cà Rem') INTO v_store_name
    FROM public.system_settings WHERE id LIMIT 1;
  v_store_name := coalesce(v_store_name, 'Cà Rem');

  -- ============ Nhánh đối soát ngân hàng ============
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
      v_body_plain := 'Một giao dịch chuyển khoản đã về, đang chờ xác nhận.';
      v_link := '/bank-reconciliation';
    ELSIF v_action = 'BANK_TRANSACTION_REVIEW' THEN
      v_title := left('Giao dịch ngân hàng cần đối soát', 160);
      v_body_money := 'Giao dịch ' || private.money_text(v_amount)
        || coalesce(' có nội dung "' || nullif(v_new ->> 'reference', '') || '"', '')
        || ' cần kiểm tra thủ công.';
      v_body_plain := 'Một giao dịch chuyển khoản cần đối soát thủ công.';
      v_link := '/bank-reconciliation';
    ELSE
      v_title := left('Giao dịch ngân hàng chưa khớp đơn', 160);
      v_body_money := 'Giao dịch ' || private.money_text(v_amount)
        || ' chưa tìm thấy đơn phù hợp — xem danh sách đối soát.';
      v_body_plain := 'Có giao dịch ngân hàng mới chưa khớp đơn.';
      v_link := '/bank-reconciliation';
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

  -- ============ VERIFY_SALE_CONTACT (thank-you enqueue) ============
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

  -- ============ Sự kiện nghiệp vụ: body dùng tên cửa hàng ============
  IF v_action = 'CREATE_ACQUISITION' THEN
    v_vehicle := (v_new -> 'vehicle' ->> 'id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thu');
    v_seller := nullif(btrim(coalesce(v_new ->> 'seller_name', '')), '');
    v_amount := NULLIF((v_new ->> 'purchase_price')::bigint, 0);
    v_title := left('Thu vào xe ' || v_label, 160);
    v_body_money := v_store_name || ' đã thu vào xe ' || v_label
      || coalesce(' từ ' || v_seller, '')
      || coalesce(', giá vốn ' || private.money_text(v_amount), '');
    v_body_plain := v_store_name || ' đã thu vào xe ' || v_label;
    v_link := '/acquisitions';
  ELSIF v_action = 'CANCEL_ACQUISITION' THEN
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã thu');
    v_extra := (v_new ->> 'created_by')::uuid;
    v_reason := nullif(btrim(coalesce(v_new ->> 'cancellation_reason', '')), '');
    v_title := left('Hủy thu xe ' || v_label, 160);
    v_body_money := v_store_name || ' đã hủy phiếu thu xe ' || v_label
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
    v_body_money := v_store_name || ' đã bán xe ' || v_label
      || coalesce(' cho ' || v_customer, '')
      || coalesce(', giá bán ' || private.money_text(v_amount), '');
    v_body_plain := v_store_name || ' đã bán xe ' || v_label
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
    v_body_money := v_store_name || ' đã hủy giao dịch bán xe ' || v_label
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
      v_body_money := v_store_name || ' đã ghi nhận thu ' || private.money_text(v_amount)
        || ' cho đơn bán xe ' || v_label;
      v_body_plain := v_store_name || ' đã ghi nhận một khoản thu cho đơn bán xe ' || v_label;
    ELSE
      v_title := left('Hủy khoản thu đơn ' || coalesce(v_sale_code, 'bán xe'), 160);
      v_body_money := v_store_name || ' đã hủy khoản thu ' || private.money_text(v_amount)
        || ' của đơn bán xe ' || v_label;
      v_body_plain := v_store_name || ' đã hủy một khoản thu của đơn bán xe ' || v_label;
    END IF;
    v_link := '/sales/' || v_sale;
  ELSIF v_action = 'CREATE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thêm');
    v_title := left('Thêm xe ' || v_label, 160);
    v_body_money := v_store_name || ' đã thêm xe ' || v_label || ' vào tồn kho';
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  ELSIF v_action = 'REQUEST_DELETE_VEHICLE' THEN
    -- Phê duyệt: giữ tên người gửi vì danh tính người yêu cầu xóa là thông tin bắt buộc.
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
    -- Phê duyệt: giữ tên người thực hiện.
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
    v_body_money := v_store_name || ' đã cập nhật thông tin xe ' || v_label;
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  END IF;

  -- Recipients fan-out.
  FOR r IN
    SELECT p.id, p.role, p.can_view_financials FROM public.profiles p
    WHERE p.id = v_actor
       OR (p.role IN ('OWNER', 'MANAGER') AND p.active)
       OR (v_extra IS NOT NULL AND p.id = v_extra AND p.active
           AND (v_actor IS NULL OR p.id <> v_actor))
    GROUP BY p.id, p.role, p.can_view_financials
  LOOP
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
