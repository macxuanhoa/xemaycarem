-- Migration: 20261008000200_staff_vehicle_parity_and_delete_approval.sql
-- Description: STAFF vehicle-management parity with MANAGER + a delete-approval workflow.
--   * STAFF now performs every vehicle operation a (non-financial) MANAGER can:
--     create/edit/cancel-restore a vehicle, add/edit/cancel VEHICLE expenses, and
--     sell. Business expenses and financial viewing stay gated exactly as before
--     (requirement: system/financial admin boundaries unchanged).
--   * The single STAFF exception: "Xóa xe" no longer purges directly. A STAFF
--     delete becomes a REQUEST: the vehicle is hidden from inventory (list_vehicles)
--     and waits for the OWNER to APPROVE (hard purge via private.purge_vehicle) or
--     RESTORE (return to inventory). MANAGER/OWNER keep the direct delete_vehicle.
--   * A generic public.approval_requests queue backs the flow so future approval
--     kinds plug in without schema change. All writes go through SECURITY DEFINER
--     RPCs; the browser only ever gets SELECT (RLS: OWNER sees all, requester sees
--     their own).
--   * Every request/decision is recorded through private.audit (immutable trail)
--     and the audit fan-out notifies the OWNER (bell -> deep_link /approvals).

-- ============================================================
-- STEP 1: Generic approval-request queue
-- ============================================================

CREATE TABLE IF NOT EXISTS public.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 60),
  subject_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES public.profiles(id),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  resolved_by uuid REFERENCES public.profiles(id),
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one open request per subject+kind (prevents duplicate delete requests).
CREATE UNIQUE INDEX IF NOT EXISTS approval_open_unique
  ON public.approval_requests (kind, subject_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS approval_pending_kind
  ON public.approval_requests (kind, created_at DESC) WHERE status = 'PENDING';

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approvals_read ON public.approval_requests;
CREATE POLICY approvals_read ON public.approval_requests
  FOR SELECT TO authenticated
  USING (private.current_role() = 'OWNER' OR requested_by = auth.uid());

REVOKE ALL ON public.approval_requests FROM public, anon, authenticated;
GRANT SELECT ON public.approval_requests TO authenticated;

-- ============================================================
-- STEP 2: STAFF parity — save_vehicle (drop STAFF cancel block, block queued edits).
-- Only the inner implementation is replaced so the creation-receipt wrapper
-- public.save_vehicle keeps its request_id protocol.
-- ============================================================

CREATE OR REPLACE FUNCTION private.save_vehicle_impl(p_data jsonb, p_id uuid default null) RETURNS uuid
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
    IF EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
      RAISE EXCEPTION USING errcode='22023', message='DELETE_PENDING';
    END IF;
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

-- ============================================================
-- STEP 3: STAFF parity — save_expense (vehicle kind opens to STAFF, business stays MANAGER+)
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_expense(p_kind text, p_data jsonb, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_id uuid; v_vehicle_id uuid; v_vehicle public.vehicles; v_old jsonb; v_new jsonb; v_date date;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT'; END IF;
  IF p_kind = 'vehicle' THEN
    IF p_id IS NOT NULL THEN
      SELECT vehicle_id INTO v_vehicle_id FROM public.vehicle_expenses WHERE id = p_id;
      IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='EXPENSE_NOT_FOUND'; END IF;
    ELSE v_vehicle_id := (p_data->>'vehicle_id')::uuid;
    END IF;
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='VEHICLE_NOT_FOUND'; END IF;
    PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
    IF v_vehicle.status NOT IN ('IN_STOCK','RESERVED') THEN RAISE EXCEPTION USING errcode='22023', message='VEHICLE_EXPENSE_LOCKED'; END IF;
    IF EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_id = v_vehicle_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
      RAISE EXCEPTION USING errcode='22023', message='DELETE_PENDING';
    END IF;
    IF p_data ? 'vehicle_id' AND (p_data->>'vehicle_id')::uuid <> v_vehicle_id THEN RAISE EXCEPTION USING errcode='22023', message='EXPENSE_VEHICLE_IMMUTABLE'; END IF;
    IF p_id IS NOT NULL THEN
      SELECT to_jsonb(e) INTO v_old FROM public.vehicle_expenses e WHERE id = p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='EXPENSE_NOT_FOUND'; END IF;
      PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
      IF v_old->>'status' <> 'ACTIVE' THEN RAISE EXCEPTION USING errcode='22023', message='EXPENSE_CANCELLED'; END IF;
      IF nullif(btrim(p_data->>'expected_updated_at'),'') IS NULL THEN
        RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED';
      END IF;
      IF (p_data->>'expected_updated_at')::timestamptz IS DISTINCT FROM (v_old->>'updated_at')::timestamptz THEN
        RAISE EXCEPTION USING errcode='40001', message='EXPENSE_EDIT_CONFLICT';
      END IF;
    END IF;
    v_date := coalesce((p_data->>'expense_date')::date, (v_old->>'expense_date')::date, private.today());
    IF v_date > private.today() OR v_date < v_vehicle.purchase_date THEN RAISE EXCEPTION USING errcode='22023', message='INVALID_EXPENSE_DATE'; END IF;
    IF p_id IS NULL THEN
      INSERT INTO public.vehicle_expenses(vehicle_id, expense_type, description, amount, expense_date, created_by)
      VALUES (v_vehicle_id, (p_data->>'expense_type')::public.vehicle_expense_type, btrim(p_data->>'description'), private.money_input(p_data,'amount'), v_date, v_actor)
      RETURNING id, to_jsonb(vehicle_expenses) INTO v_id, v_new;
    ELSE
      UPDATE public.vehicle_expenses SET expense_type = coalesce((p_data->>'expense_type')::public.vehicle_expense_type, expense_type),
        description = btrim(coalesce(p_data->>'description', description)), amount = private.money_input(p_data,'amount',amount), expense_date = v_date,
        updated_at = greatest(clock_timestamp(), (v_old->>'updated_at')::timestamptz + interval '1 microsecond')
      WHERE id = p_id RETURNING id, to_jsonb(vehicle_expenses) INTO v_id, v_new;
    END IF;
  ELSIF p_kind = 'business' THEN
    -- Business expenses are financial administration: MANAGER+ only.
    PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
    IF p_id IS NOT NULL THEN
      SELECT to_jsonb(e) INTO v_old FROM public.business_expenses e WHERE id = p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='EXPENSE_NOT_FOUND'; END IF;
      PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
      IF v_old->>'status' <> 'ACTIVE' THEN RAISE EXCEPTION USING errcode='22023', message='EXPENSE_CANCELLED'; END IF;
      IF nullif(btrim(p_data->>'expected_updated_at'),'') IS NULL THEN
        RAISE EXCEPTION USING errcode='22023', message='CLIENT_UPGRADE_REQUIRED';
      END IF;
      IF (p_data->>'expected_updated_at')::timestamptz IS DISTINCT FROM (v_old->>'updated_at')::timestamptz THEN
        RAISE EXCEPTION USING errcode='40001', message='EXPENSE_EDIT_CONFLICT';
      END IF;
    END IF;
    v_date := coalesce((p_data->>'expense_date')::date, (v_old->>'expense_date')::date, private.today());
    IF v_date > private.today() THEN RAISE EXCEPTION USING errcode='22023', message='FUTURE_DATE'; END IF;
    IF p_id IS NULL THEN
      INSERT INTO public.business_expenses(category, description, amount, expense_date, created_by)
      VALUES ((p_data->>'category')::public.business_expense_category, btrim(p_data->>'description'), private.money_input(p_data,'amount'), v_date, v_actor)
      RETURNING id, to_jsonb(business_expenses) INTO v_id, v_new;
    ELSE
      UPDATE public.business_expenses SET category = coalesce((p_data->>'category')::public.business_expense_category, category),
        description = btrim(coalesce(p_data->>'description', description)), amount = private.money_input(p_data,'amount',amount), expense_date = v_date,
        updated_at = greatest(clock_timestamp(), (v_old->>'updated_at')::timestamptz + interval '1 microsecond')
      WHERE id = p_id RETURNING id, to_jsonb(business_expenses) INTO v_id, v_new;
    END IF;
  ELSE RAISE EXCEPTION USING errcode='22023', message='INVALID_EXPENSE_KIND';
  END IF;
  PERFORM private.audit(CASE WHEN p_id IS NULL THEN 'ADD_EXPENSE' ELSE 'UPDATE_EXPENSE' END, p_kind||'_expenses', v_id, v_old, v_new, v_vehicle_id);
  RETURN v_id;
END $$;

-- ============================================================
-- STEP 4: STAFF parity — cancel_expense (vehicle kind opens to STAFF, business stays MANAGER+)
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_expense(p_kind text, p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle uuid; v_status public.vehicle_status; v_old jsonb; v_new jsonb;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION USING errcode='22023', message='CANCELLATION_REASON_REQUIRED'; END IF;
  IF p_kind = 'vehicle' THEN
    SELECT vehicle_id INTO v_vehicle FROM public.vehicle_expenses WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='EXPENSE_NOT_FOUND'; END IF;
    SELECT status INTO v_status FROM public.vehicles WHERE id = v_vehicle FOR UPDATE;
    IF v_status NOT IN ('IN_STOCK','RESERVED') THEN RAISE EXCEPTION USING errcode='22023', message='VEHICLE_EXPENSE_LOCKED'; END IF;
    IF EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_id = v_vehicle AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
      RAISE EXCEPTION USING errcode='22023', message='DELETE_PENDING';
    END IF;
    SELECT to_jsonb(e) INTO v_old FROM public.vehicle_expenses e WHERE id = p_id FOR UPDATE;
    IF v_old->>'status' <> 'ACTIVE' THEN RAISE EXCEPTION USING errcode='22023', message='EXPENSE_CANCELLED'; END IF;
    UPDATE public.vehicle_expenses SET status='CANCELLED', cancellation_reason=btrim(p_reason), cancelled_at=now(), cancelled_by=v_actor, updated_at=now()
    WHERE id = p_id RETURNING to_jsonb(vehicle_expenses) INTO v_new;
  ELSIF p_kind = 'business' THEN
    -- Business expenses are financial administration: MANAGER+ only.
    PERFORM private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
    SELECT to_jsonb(e) INTO v_old FROM public.business_expenses e WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='EXPENSE_NOT_FOUND'; END IF;
    IF v_old->>'status' <> 'ACTIVE' THEN RAISE EXCEPTION USING errcode='22023', message='EXPENSE_CANCELLED'; END IF;
    UPDATE public.business_expenses SET status='CANCELLED', cancellation_reason=btrim(p_reason), cancelled_at=now(), cancelled_by=v_actor, updated_at=now()
    WHERE id = p_id RETURNING to_jsonb(business_expenses) INTO v_new;
  ELSE RAISE EXCEPTION USING errcode='22023', message='INVALID_EXPENSE_KIND';
  END IF;
  PERFORM private.audit('CANCEL_EXPENSE', p_kind||'_expenses', p_id, v_old, v_new, v_vehicle);
END $$;

-- ============================================================
-- STEP 5: Block selling a vehicle queued for deletion. Only the inner
-- implementation (private.sell_vehicle_impl) is replaced so the receipt
-- wrapper public.sell_vehicle keeps its idempotent request_id protocol.
-- ============================================================

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
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETE_PENDING';
  END IF;
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

-- ============================================================
-- STEP 6: Delete-request lifecycle RPCs
-- ============================================================

-- STAFF (and any active role, though only STAFF is offered this in the UI) files a
-- delete request. Mirrors private.purge_vehicle's guards so nothing unsellable is queued.
CREATE OR REPLACE FUNCTION public.request_delete_vehicle(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode='22023', message='DELETION_REASON_REQUIRED';
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='VEHICLE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE vehicle_id = p_id) THEN
    RAISE EXCEPTION USING errcode='22023', message='SALE_HISTORY_EXISTS';
  END IF;
  IF v_vehicle.status NOT IN ('IN_STOCK','RESERVED') THEN
    RAISE EXCEPTION USING errcode='22023', message='VEHICLE_NOT_AVAILABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode='22023', message='ALREADY_PENDING';
  END IF;
  INSERT INTO public.approval_requests(kind, subject_id, requested_by, reason)
  VALUES ('VEHICLE_DELETION', p_id, v_actor, btrim(p_reason));
  PERFORM private.audit('REQUEST_DELETE_VEHICLE', 'vehicles', p_id, null,
    jsonb_build_object('reason', btrim(p_reason), 'requested_by', v_actor), p_id);
END $$;

-- OWNER resolves a queued deletion: APPROVE purges the vehicle, RESTORE returns it.
CREATE OR REPLACE FUNCTION public.resolve_vehicle_deletion(p_request_id uuid, p_action text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_req public.approval_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_action NOT IN ('APPROVE','RESTORE') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_APPROVAL_ACTION';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  SELECT * INTO v_req FROM public.approval_requests WHERE id = p_request_id AND kind = 'VEHICLE_DELETION' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='APPROVAL_NOT_FOUND'; END IF;
  IF v_req.status <> 'PENDING' THEN RAISE EXCEPTION USING errcode='22023', message='ALREADY_RESOLVED'; END IF;

  IF p_action = 'APPROVE' THEN
    -- purge_vehicle re-checks sale history and removes the full record set.
    PERFORM private.purge_vehicle(v_req.subject_id);
    UPDATE public.approval_requests
      SET status='APPROVED', resolved_by=v_actor, resolved_at=now(), resolution_note=v_note, updated_at=now()
      WHERE id = p_request_id;
    PERFORM private.audit('APPROVE_VEHICLE_DELETION', 'vehicles', v_req.subject_id, null,
      jsonb_build_object('request_id', p_request_id, 'reason', v_req.reason, 'requested_by', v_req.requested_by, 'note', v_note, 'approved_by', v_actor));
  ELSE
    UPDATE public.approval_requests
      SET status='REJECTED', resolved_by=v_actor, resolved_at=now(), resolution_note=v_note, updated_at=now()
      WHERE id = p_request_id;
    PERFORM private.audit('RESTORE_VEHICLE_DELETION', 'vehicles', v_req.subject_id, null,
      jsonb_build_object('request_id', p_request_id, 'reason', v_req.reason, 'requested_by', v_req.requested_by, 'note', v_note, 'restored_by', v_actor));
  END IF;
END $$;

-- OWNER reads the open approval queue (grouped generically by kind).
CREATE OR REPLACE FUNCTION public.list_pending_approvals(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 50)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb; v_total bigint;
BEGIN
  SELECT count(*) INTO v_total FROM public.approval_requests ar WHERE ar.status = 'PENDING';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'kind', x.kind, 'subject_id', x.subject_id, 'reason', x.reason,
      'requested_by', x.requested_by, 'requester_name', x.requester_name, 'created_at', x.created_at,
      'vehicle_code', x.vehicle_code, 'vehicle_name', x.vehicle_name, 'license_plate', x.license_plate,
      'vehicle_status', x.vehicle_status
    ) ORDER BY x.rn), '[]'::jsonb) INTO v_items
  FROM (
    SELECT row_number() OVER (ORDER BY ar.created_at DESC, ar.id DESC) AS rn,
      ar.id, ar.kind, ar.subject_id, ar.reason, ar.requested_by, ar.created_at,
      req.full_name AS requester_name,
      v.internal_code AS vehicle_code,
      private.vehicle_label_text(v.brand, v.model, v.internal_code, v.license_plate) AS vehicle_name,
      v.license_plate, v.status::text AS vehicle_status
    FROM public.approval_requests ar
    LEFT JOIN public.profiles req ON req.id = ar.requested_by
    LEFT JOIN public.vehicles v ON v.id = ar.subject_id
    WHERE ar.status = 'PENDING'
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT v_limit OFFSET v_offset
  ) x;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

-- ============================================================
-- STEP 7: Direct delete stays OWNER/MANAGER but must not race a queued request
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_vehicle(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_old public.vehicles;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETION_REASON_REQUIRED';
  END IF;
  -- A vehicle already queued for approval is resolved through the approvals page,
  -- not by a parallel direct purge.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETE_PENDING';
  END IF;
  v_old := private.purge_vehicle(p_id);
  PERFORM private.audit(
    'DELETE_VEHICLE', 'vehicles', p_id, to_jsonb(v_old),
    jsonb_build_object('reason', btrim(p_reason), 'deleted_by', v_actor, 'deleted_at', now()),
    NULL
  );
END $$;

-- ============================================================
-- STEP 8: Hide queued vehicles from inventory + expose pending flag on detail
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_vehicles(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_sort text:=coalesce(p_filters->>'sort','newest');
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if nullif(p_filters->>'min_days','') is not null and (p_filters->>'min_days')::integer not between 0 and 36500 then raise exception using errcode='22023',message='INVALID_STOCK_AGE'; end if;
  if v_sort='highest_cost' and not private.can_financials() then raise exception using errcode='42501',message='FINANCIAL_ACCESS_DENIED'; end if;
  with matching as (
    select v.* from public.vehicles v where
      not exists (select 1 from public.approval_requests ar
                  where ar.subject_id = v.id and ar.kind = 'VEHICLE_DELETION' and ar.status = 'PENDING') and
      (nullif(p_filters->>'status','') is null or p_filters->>'status'='ALL' or v.status::text=p_filters->>'status' or (p_filters->>'status' in ('AVAILABLE','UNSOLD') and v.status in ('IN_STOCK','RESERVED'))) and
      (nullif(p_filters->>'min_days','') is null or (v.status in ('IN_STOCK','RESERVED') and private.today()-v.purchase_date >= (p_filters->>'min_days')::integer)) and
      (not coalesce(nullif(p_filters->>'cost_pending','')::boolean,false) or exists(select 1 from public.vehicle_financials vf where vf.vehicle_id=v.id and vf.purchase_price is null)) and
      (nullif(p_filters->>'brand','') is null or v.brand=p_filters->>'brand') and
      (nullif(p_filters->>'year','') is null or v.year=(p_filters->>'year')::integer) and
      (nullif(p_filters->>'min_price','') is null or v.asking_price>=(p_filters->>'min_price')::bigint) and
      (nullif(p_filters->>'max_price','') is null or v.asking_price<=(p_filters->>'max_price')::bigint) and
      (nullif(p_filters->>'date_from','') is null or v.purchase_date>=(p_filters->>'date_from')::date) and
      (nullif(p_filters->>'date_to','') is null or v.purchase_date<=(p_filters->>'date_to')::date) and
      (v_search='' or concat_ws(' ',v.internal_code,v.license_plate,v.brand,v.model,v.frame_number,v.engine_number) ilike '%'||v_search||'%'
        or exists(select 1 from public.sales s where s.vehicle_id=v.id and s.customer_phone ilike '%'||v_search||'%'))
  ), ordered as (
    select m.id,row_number() over(order by
      case when v_sort='oldest' then m.created_at end asc,
      case when v_sort='longest_stock' then case when m.status in ('IN_STOCK','RESERVED') then m.purchase_date end end asc nulls last,
      case when v_sort='highest_price' then m.asking_price end desc nulls last,
      case when v_sort='highest_cost' then f.purchase_price+(select coalesce(sum(amount),0) from public.vehicle_expenses e where e.vehicle_id=m.id and e.status='ACTIVE') end desc nulls last,
      m.created_at desc,m.id) as ord
    from matching m left join public.vehicle_financials f on f.vehicle_id=m.id
    order by ord
    limit v_limit offset v_offset
  )
  select (select count(*) from matching),coalesce((select jsonb_agg(private.vehicle_json(v) order by o.ord) from ordered o join public.vehicles v on v.id=o.id),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

CREATE OR REPLACE FUNCTION public.get_vehicle(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles; v_images jsonb; v_expenses jsonb:='[]'; v_sales jsonb; v_activity jsonb;
  v_pending boolean;
begin
  select * into v_vehicle from public.vehicles where id=p_id;
  if not found then raise exception using errcode='P0002',message='VEHICLE_NOT_FOUND'; end if;
  select exists (select 1 from public.approval_requests ar
                 where ar.subject_id=p_id and ar.kind='VEHICLE_DELETION' and ar.status='PENDING') into v_pending;
  select coalesce(jsonb_agg(to_jsonb(i) order by display_order,created_at),'[]'::jsonb) into v_images from public.vehicle_images i where vehicle_id=p_id and deleted_at is null;
  if private.current_role() in ('OWNER','MANAGER') then
    select coalesce(jsonb_agg(to_jsonb(e) order by expense_date desc,created_at desc),'[]'::jsonb) into v_expenses from public.vehicle_expenses e where vehicle_id=p_id;
  end if;
  select coalesce(jsonb_agg(public.get_sale(s.id) order by created_at desc),'[]'::jsonb) into v_sales from public.sales s where vehicle_id=p_id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc),'[]'::jsonb) into v_activity from (
    select a.*,p.full_name as actor_name from public.vehicle_activity a left join public.profiles p on p.id=a.user_id where vehicle_id=p_id order by a.created_at desc,a.id desc limit 100
  ) a;
  return private.vehicle_json(v_vehicle)||jsonb_build_object('images',v_images,'expenses',v_expenses,'sales',v_sales,'activity',v_activity,'pending_deletion',v_pending);
end $$;

-- ============================================================
-- STEP 9: Notify the OWNER (bell) when a delete request is filed
-- ============================================================

CREATE OR REPLACE FUNCTION private.notify_from_audit() RETURNS trigger
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
  r record;
BEGIN
  IF v_action NOT IN ('CREATE_ACQUISITION','CANCEL_ACQUISITION','CREATE_SALE','CANCEL_SALE',
                      'CREATE_PAYMENT','VOID_PAYMENT','CREATE_VEHICLE','UPDATE_VEHICLE',
                      'REQUEST_DELETE_VEHICLE') THEN
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

  IF v_action = 'CREATE_ACQUISITION' THEN
    v_vehicle := (v_new -> 'vehicle' ->> 'id')::uuid;
    SELECT private.vehicle_label_text(v.brand, v.model, v.internal_code, v.license_plate)
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
    SELECT private.vehicle_label_text(v.brand, v.model, v.internal_code, v.license_plate)
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
    SELECT private.vehicle_label_text(v.brand, v.model, v.internal_code, v.license_plate)
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
    SELECT private.vehicle_label_text(v.brand, v.model, v.internal_code, v.license_plate)
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
           private.vehicle_label_text(v.brand, v.model, v.internal_code, v.license_plate)
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
    v_label := private.vehicle_label_text(
      v_new ->> 'brand', v_new ->> 'model', v_new ->> 'internal_code', v_new ->> 'license_plate');
    v_title := left('Thêm xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã thêm xe ' || v_label || ' vào tồn kho';
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  ELSIF v_action = 'REQUEST_DELETE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.brand, v.model, v.internal_code, v.license_plate)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_reason := nullif(btrim(coalesce(v_new ->> 'reason', '')), '');
    v_title := left('Yêu cầu xóa xe ' || v_label, 160);
    v_body_money := v_actor_name || ' gửi yêu cầu xóa xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '') || ' — đang chờ chủ cửa hàng duyệt.';
    v_body_plain := v_body_money;
    v_link := '/approvals';
  ELSE -- UPDATE_VEHICLE
    v_vehicle := NEW.entity_id;
    v_label := private.vehicle_label_text(
      v_new ->> 'brand', v_new ->> 'model', v_new ->> 'internal_code', v_new ->> 'license_plate');
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
-- STEP 10: Grants — new RPCs follow the 031 lockdown matrix
-- ============================================================

REVOKE ALL ON FUNCTION
  public.request_delete_vehicle(uuid, text),
  public.resolve_vehicle_deletion(uuid, text, text),
  public.list_pending_approvals(jsonb)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.request_delete_vehicle(uuid, text),
  public.resolve_vehicle_deletion(uuid, text, text),
  public.list_pending_approvals(jsonb)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
