-- Recheck access after business row lock waits; reject stale versioned vehicle edits.
-- Existing RPC contracts and sale/payment accounting remain unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.save_vehicle(p_data jsonb, p_id uuid default null) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.vehicles; v_new public.vehicles; v_purchase bigint; v_old_purchase bigint;
  v_status public.vehicle_status; v_date date; v_old_json jsonb;
  v_frame text;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT'; END IF;
  IF p_data ? 'purchase_price' AND NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501', message='FINANCIAL_ACCESS_DENIED'; END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.vehicles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='VEHICLE_NOT_FOUND'; END IF;
    PERFORM private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
    IF p_data ? 'expected_updated_at' AND v_old.updated_at IS DISTINCT FROM (p_data->>'expected_updated_at')::timestamptz THEN
      RAISE EXCEPTION USING errcode='40001', message='VEHICLE_EDIT_CONFLICT';
    END IF;
    IF p_data ? 'purchase_price' AND NOT private.can_financials() THEN
      RAISE EXCEPTION USING errcode='42501', message='FINANCIAL_ACCESS_DENIED';
    END IF;
    SELECT purchase_price INTO v_old_purchase FROM public.vehicle_financials WHERE vehicle_id = p_id;
  END IF;
  v_status := COALESCE((p_data->>'status')::public.vehicle_status, v_old.status, 'IN_STOCK');
  IF v_status = 'SOLD' AND (p_id IS NULL OR v_old.status <> 'SOLD') THEN RAISE EXCEPTION USING errcode='22023', message='USE_SELL_VEHICLE'; END IF;
  IF (v_status = 'CANCELLED' OR v_old.status = 'CANCELLED') AND private.current_role() = 'STAFF' THEN RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED'; END IF;
  v_purchase := private.money_input(p_data, 'purchase_price', v_old_purchase);
  v_date := COALESCE((p_data->>'purchase_date')::date, v_old.purchase_date, private.today());
  IF v_date > private.today() THEN RAISE EXCEPTION USING errcode='22023', message='FUTURE_DATE'; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = p_id AND status = 'ACTIVE' AND expense_date < v_date) THEN
    RAISE EXCEPTION USING errcode='22023', message='PURCHASE_AFTER_EXPENSE';
  END IF;
  IF v_old.status = 'SOLD' AND (v_status <> 'SOLD' OR v_purchase IS DISTINCT FROM v_old_purchase
      OR v_date <> v_old.purchase_date OR private.money_input(p_data, 'asking_price', v_old.asking_price) <> v_old.asking_price) THEN
    RAISE EXCEPTION USING errcode='22023', message='SOLD_VEHICLE_LOCKED';
  END IF;

  v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), 'GEN-' || substr(gen_random_uuid()::text, 1, 12));

  IF p_id IS NULL THEN
    INSERT INTO public.vehicles(
      license_plate, brand, model, variant, year, color, frame_number, engine_number,
      odometer, purchase_date, asking_price, status, supplier_name, supplier_phone, notes, created_by
    ) VALUES (
      btrim(COALESCE(p_data->>'license_plate', '')), btrim(COALESCE(p_data->>'brand', '')), btrim(p_data->>'model'), btrim(COALESCE(p_data->>'variant', '')),
      NULLIF(p_data->>'year', '')::integer, btrim(COALESCE(p_data->>'color', '')), v_frame, btrim(COALESCE(p_data->>'engine_number', '')),
      COALESCE(NULLIF(p_data->>'odometer', '')::integer, 0), v_date, private.money_input(p_data, 'asking_price'), v_status,
      btrim(COALESCE(p_data->>'supplier_name', '')), btrim(COALESCE(p_data->>'supplier_phone', '')), COALESCE(p_data->>'notes', ''), v_actor
    ) RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by) VALUES (v_new.id, v_purchase, v_actor);
    PERFORM private.audit('CREATE_VEHICLE', 'vehicles', v_new.id, NULL, to_jsonb(v_new) || jsonb_build_object('purchase_price', v_purchase), v_new.id);
  ELSE
    v_old_json := to_jsonb(v_old) || jsonb_build_object('purchase_price', v_old_purchase);
    UPDATE public.vehicles SET
      license_plate = btrim(COALESCE(p_data->>'license_plate', license_plate)),
      brand = btrim(COALESCE(p_data->>'brand', brand)),
      model = btrim(COALESCE(p_data->>'model', model)),
      variant = btrim(COALESCE(p_data->>'variant', variant)),
      year = CASE WHEN p_data ? 'year' THEN NULLIF(p_data->>'year', '')::integer ELSE year END,
      color = btrim(COALESCE(p_data->>'color', color)),
      frame_number = COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), frame_number),
      engine_number = btrim(COALESCE(p_data->>'engine_number', engine_number)),
      odometer = COALESCE(NULLIF(p_data->>'odometer', '')::integer, odometer),
      purchase_date = v_date,
      asking_price = private.money_input(p_data, 'asking_price', asking_price),
      status = v_status,
      supplier_name = btrim(COALESCE(p_data->>'supplier_name', supplier_name)),
      supplier_phone = btrim(COALESCE(p_data->>'supplier_phone', supplier_phone)),
      notes = COALESCE(p_data->>'notes', notes),
      updated_at = now()
    WHERE id = p_id RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by)
      VALUES (p_id, v_purchase, v_actor)
      ON CONFLICT (vehicle_id) DO UPDATE
        SET purchase_price = EXCLUDED.purchase_price, updated_by = EXCLUDED.updated_by, updated_at = now();

    PERFORM private.audit('UPDATE_VEHICLE', 'vehicles', v_new.id, v_old_json, to_jsonb(v_new) || jsonb_build_object('purchase_price', v_purchase), v_new.id);
  END IF;
  RETURN v_new.id;
END $$;

CREATE OR REPLACE FUNCTION public.sell_vehicle(p_data jsonb) RETURNS uuid
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
    NULL;
  END;
  RETURN v_sale.id;
END $$;

CREATE OR REPLACE FUNCTION public.add_payment(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_sale_id uuid := (p_data->>'sale_id')::uuid;
  v_request uuid := nullif(p_data->>'request_id', '')::uuid;
  v_vehicle uuid;
  v_sale public.sales;
  v_payment public.payments;
  v_paid bigint;
  v_amount bigint := private.money_input(p_data, 'amount');
  v_date date := coalesce(nullif(p_data->>'payment_date', '')::date, private.today());
  v_method public.payment_method := (p_data->>'payment_method')::public.payment_method;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;
  SELECT vehicle_id INTO v_vehicle FROM public.sales WHERE id = v_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.vehicles WHERE id = v_vehicle FOR UPDATE;
  SELECT * INTO v_sale FROM public.sales WHERE id = v_sale_id FOR UPDATE;
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF v_request IS NOT NULL THEN
    SELECT * INTO v_payment FROM public.payments WHERE id = v_request;
    IF FOUND THEN
      IF v_payment.sale_id IS DISTINCT FROM v_sale_id OR v_payment.created_by IS DISTINCT FROM v_actor
        OR v_payment.amount IS DISTINCT FROM v_amount OR v_payment.payment_date IS DISTINCT FROM v_date
        OR v_payment.payment_method IS DISTINCT FROM v_method
        OR v_payment.reference IS DISTINCT FROM coalesce(p_data->>'reference', '')
        OR v_payment.notes IS DISTINCT FROM coalesce(p_data->>'notes', '') THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'PAYMENT_REQUEST_CONFLICT';
      END IF;
      RETURN v_payment.id;
    END IF;
  END IF;
  IF v_sale.status <> 'COMPLETED' THEN RAISE EXCEPTION USING errcode = '22023', message = 'SALE_CANCELLED'; END IF;
  IF v_date < v_sale.sale_date OR v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT_DATE'; END IF;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_paid FROM public.payments WHERE sale_id = v_sale_id AND status = 'ACTIVE';
  IF v_amount IS NULL OR v_amount <= 0 OR v_paid + v_amount > v_sale.sale_price THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PAYMENT_EXCEEDS_BALANCE';
  END IF;
  INSERT INTO public.payments(id, sale_id, amount, payment_method, payment_date, reference, notes, created_by)
  VALUES (coalesce(v_request, gen_random_uuid()), v_sale_id, v_amount, v_method, v_date,
    coalesce(p_data->>'reference', ''), coalesce(p_data->>'notes', ''), v_actor) RETURNING * INTO v_payment;
  PERFORM private.audit('CREATE_PAYMENT', 'payments', v_payment.id, null, to_jsonb(v_payment), v_vehicle);
  RETURN v_payment.id;
END $$;

COMMIT;
