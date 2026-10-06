-- Prevent new claims for already cancelled sales. No automatic replay of ambiguous provider delivery.
BEGIN;
CREATE OR REPLACE FUNCTION private.sell_vehicle_impl(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
  v_sale public.sales;
  v_purchase bigint;
  v_expenses bigint;
  v_price bigint := private.money_input(p_data, 'sale_price');
  v_initial bigint := private.money_input(p_data, 'initial_payment', 0);
  v_date date := coalesce((p_data->>'sale_date')::date, private.today());
  v_due_date date := nullif(p_data->>'due_date', '')::date;
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
  IF v_date < v_vehicle.purchase_date OR v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SALE_DATE'; END IF;
  IF v_due_date IS NOT NULL AND v_due_date < v_date THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE'; END IF;
  IF v_price IS NULL OR v_initial > v_price THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT'; END IF;
  IF EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE' AND expense_date > v_date) THEN RAISE EXCEPTION USING errcode = '22023', message = 'SALE_BEFORE_EXPENSE'; END IF;
  SELECT purchase_price INTO v_purchase FROM public.vehicle_financials WHERE vehicle_id = v_vehicle.id;
  IF v_purchase IS NULL THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_COST_REQUIRED'; END IF;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE';
  PERFORM private.safe_money(v_purchase::numeric + v_expenses);
  INSERT INTO public.sales (vehicle_id, customer_name, customer_phone, sale_price, sale_date, due_date, sold_by, notes)
  VALUES (v_vehicle.id, btrim(p_data->>'customer_name'), btrim(coalesce(p_data->>'customer_phone', '')), v_price, v_date, v_due_date, v_actor, coalesce(p_data->>'notes', '')) RETURNING * INTO v_sale;
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

  -- The outbox is atomic in the normal path. An outbox/schema failure rolls back
  -- only this nested block, never the already validated sale transaction.
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
    -- Keep the financial transaction successful; record only a safe code and IDs.
    BEGIN
      PERFORM private.audit('AUTO_MESSAGE_QUEUE_FAILED','sales',v_sale.id,NULL,
        jsonb_build_object('error_code',SQLSTATE),v_vehicle.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'AUTO_MESSAGE_QUEUE_FAILED sale_id=% code=%', v_sale.id, SQLSTATE;
    END;
  END;
  RETURN v_sale.id;
END $$;

CREATE OR REPLACE FUNCTION public.claim_message(p_message_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]); v_job public.message_outbox;
BEGIN
  UPDATE public.message_outbox SET status='PROCESSING',attempt_count=attempt_count+1,last_attempt_at=now()
  WHERE id=p_message_id AND status='QUEUED' AND coalesce(next_attempt_at,now())<=now()
    AND attempt_count<max_attempts
    AND EXISTS (SELECT 1 FROM public.sales s WHERE s.id=message_outbox.sale_id AND s.status='COMPLETED')
    RETURNING * INTO v_job;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  UPDATE public.customer_communications SET status='PROCESSING' WHERE sale_id=v_job.sale_id AND message_type='THANK_YOU';
  RETURN to_jsonb(v_job);
END $$;
COMMIT;
