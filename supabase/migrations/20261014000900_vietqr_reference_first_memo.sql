-- Nội dung chuyển khoản VietQR: ĐẶT MÃ ĐỐI SOÁT LÊN ĐẦU để tự động hoàn tất trên UI.
--
-- Lý do: phiên bản trước để "Mã giao dịch là: CAREM GDxxxx" ở CUỐI một memo dài ~98 ký tự.
-- Nhiều ngân hàng (và đường truyền webhook SePay) cắt gọn memo xuống còn ~70 ký tự đầu,
-- nên phần mã nằm cuối bị mất → ingest_bank_transaction không trích được "CAREM GD<digits>"
-- → giao dịch về đúng tiền, đúng tài khoản nhưng rơi vào UNMATCHED → UI không bao giờ
-- "Đã nhận tiền". Đây chính là lỗi "SePay đã nhận nhưng không hoàn tất trên giao diện".
--
-- Cách sửa: mã đối soát luôn đứng ĐẦU nên sống sót qua mọi lần cắt memo; webhook khớp mã
-- bằng regex tìm "CAREM[...]*GD[...]<digits>" ở BẤT KỲ vị trí, nên đặt đầu là an toàn tuyệt
-- đối. Phần đọc được (tên người trả + tên xe + mã xe) vẫn giữ, chỉ bị cắt bớt khi vượt trần
-- 130 ký tự Napas — và không bao giờ ăn vào mã ở đầu. Số tiền KHÔNG cần nằm trong memo vì
-- ingest đã đối chiếu amount riêng (v_req.amount <> v_amount).
CREATE OR REPLACE FUNCTION public.create_vietqr_payment_request(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_actor uuid; v_vehicle public.vehicles; v_sale public.sales; v_settings public.system_settings;
 v_existing public.vietqr_requests; v_request public.vietqr_requests;
 v_vehicle_id uuid; v_sale_id uuid; v_replace uuid; v_amount bigint; v_paid bigint;
 v_ref text; v_payer text; v_contract text; v_content text; v_now timestamptz;
 v_name text; v_code_part text; v_tail text; v_payer_text text;
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
 -- Memo BẮT ĐẦU bằng mã đối soát. Phần đọc được theo sau và chỉ bị rút gọn khi vượt trần,
 -- không bao giờ cắt vào mã ở đầu — nhờ đó webhook luôn trích được "CAREM GD<digits>".
 v_name:=left(coalesce(
   nullif(btrim((SELECT name FROM public.vehicle_types WHERE id=v_vehicle.vehicle_type_id)),''),
   nullif(btrim(v_vehicle.license_plate),''),
   nullif(btrim(v_vehicle.internal_code),''),'xe'),40);
 v_code_part:=CASE WHEN nullif(btrim(coalesce(v_vehicle.internal_code,'')),'') IS NOT NULL
   THEN ' - '||btrim(v_vehicle.internal_code) ELSE '' END;
 v_payer_text:=coalesce(nullif(v_payer,''),'Khách mua xe');
 v_tail:=' thanh toán tiền xe '||v_name||v_code_part;
 IF length(v_ref)+1+length(v_payer_text)+length(v_tail)>130 THEN
   v_payer_text:=btrim(left(v_payer_text,greatest(0,130-length(v_ref)-1-length(v_tail))));
 END IF;
 v_content:=regexp_replace(v_ref||' '||v_payer_text||v_tail,'  +',' ','g');
 IF length(v_content)>130 THEN RAISE EXCEPTION 'VIETQR_CONTENT_TOO_LONG'; END IF;
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
