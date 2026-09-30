-- Migration: 20260930002300_operational_features.sql
-- Description: Operational enhancements for motorcycle shop CRM:
-- 1. Accounts Receivable / Customer Debt (due_date, list_receivables, update_sale_due_date)
-- 2. Daily Reconciliation (daily_reconciliation)
-- 3. Actionable Dashboard Alerts (unpaid, overdue, old stock counts in dashboard RPC)
-- 4. Initial Vehicle CSV Import (validate_import_vehicles, import_vehicles)
-- 5. Global Search (global_search)
-- 6. Customer History (list_customers, get_customer_history)

-- ============================================================
-- STEP 1: Add due_date to public.sales and supporting indexes
-- ============================================================

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS due_date date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_due_date_check' AND conrelid = 'public.sales'::regclass
  ) THEN
    ALTER TABLE public.sales ADD CONSTRAINT sales_due_date_check CHECK (due_date IS NULL OR due_date >= sale_date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sales_due_date ON public.sales(due_date);
CREATE INDEX IF NOT EXISTS payments_date ON public.payments(payment_date DESC);
CREATE INDEX IF NOT EXISTS payments_status_date ON public.payments(status, payment_date DESC);

-- ============================================================
-- STEP 2: Update sell_vehicle to support optional due_date
-- ============================================================

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
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = (p_data->>'vehicle_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  IF v_vehicle.status NOT IN ('IN_STOCK', 'RESERVED') THEN RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_NOT_AVAILABLE'; END IF;
  IF v_date < v_vehicle.purchase_date OR v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SALE_DATE'; END IF;
  IF v_due_date IS NOT NULL AND v_due_date < v_date THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE'; END IF;
  IF v_price IS NULL OR v_initial > v_price THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT'; END IF;
  IF EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE' AND expense_date > v_date) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_BEFORE_EXPENSE';
  END IF;

  SELECT purchase_price INTO v_purchase FROM public.vehicle_financials WHERE vehicle_id = v_vehicle.id;
  IF v_purchase IS NULL THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_COST_REQUIRED'; END IF;

  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE';
  PERFORM private.safe_money(v_purchase::numeric + v_expenses);

  INSERT INTO public.sales (vehicle_id, customer_name, customer_phone, sale_price, sale_date, due_date, sold_by, notes)
  VALUES (
    v_vehicle.id,
    btrim(p_data->>'customer_name'),
    btrim(coalesce(p_data->>'customer_phone', '')),
    v_price,
    v_date,
    v_due_date,
    v_actor,
    coalesce(p_data->>'notes', '')
  ) RETURNING * INTO v_sale;

  INSERT INTO public.sale_financials (sale_id, purchase_cost_snapshot, expense_cost_snapshot, sale_price_snapshot)
  VALUES (v_sale.id, v_purchase, v_expenses, v_price);

  IF v_initial > 0 THEN
    INSERT INTO public.payments (sale_id, amount, payment_method, payment_date, created_by)
    VALUES (
      v_sale.id,
      v_initial,
      coalesce((p_data->>'payment_method')::public.payment_method, 'CASH'),
      v_date,
      v_actor
    ) RETURNING * INTO v_payment;
    PERFORM private.audit('CREATE_PAYMENT', 'payments', v_payment.id, null, to_jsonb(v_payment), v_vehicle.id);
  END IF;

  UPDATE public.vehicles SET status = 'SOLD', updated_at = now() WHERE id = v_vehicle.id;
  PERFORM private.audit(
    'CREATE_SALE', 'sales', v_sale.id, null,
    to_jsonb(v_sale) || jsonb_build_object(
      'purchase_cost_snapshot', v_purchase,
      'expense_cost_snapshot', v_expenses,
      'total_cost_snapshot', v_purchase + v_expenses,
      'gross_profit', v_price - v_purchase - v_expenses
    ),
    v_vehicle.id
  );

  RETURN v_sale.id;
END $$;

-- ============================================================
-- STEP 3: Update sale_due_date RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_sale_due_date(p_sale_id uuid, p_due_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.sales;
  v_new public.sales;
BEGIN
  SELECT * INTO v_old FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND'; END IF;
  IF v_old.status <> 'COMPLETED' THEN RAISE EXCEPTION USING errcode = '22023', message = 'SALE_NOT_ACTIVE'; END IF;
  IF p_due_date IS NOT NULL AND p_due_date < v_old.sale_date THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE';
  END IF;

  UPDATE public.sales
  SET due_date = p_due_date, updated_at = now()
  WHERE id = p_sale_id
  RETURNING * INTO v_new;

  PERFORM private.audit('UPDATE_SALE_DUE_DATE', 'sales', p_sale_id, to_jsonb(v_old), to_jsonb(v_new), v_old.vehicle_id);
  RETURN private.sale_json(v_new);
END $$;

-- ============================================================
-- STEP 4: Update private.sale_json to include debt status
-- ============================================================

CREATE OR REPLACE FUNCTION private.sale_json(p_sale public.sales) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_vehicle public.vehicles;
  v_paid bigint;
  v_result jsonb;
  v_fin public.sale_financials;
  v_remaining bigint;
  v_debt_status text;
  v_is_overdue boolean := false;
  v_today date := private.today();
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_sale.vehicle_id;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_paid FROM public.payments WHERE sale_id = p_sale.id AND status = 'ACTIVE';
  v_remaining := CASE WHEN p_sale.status = 'COMPLETED' THEN greatest(0, p_sale.sale_price - v_paid) ELSE 0 END;

  IF p_sale.status = 'CANCELLED' THEN
    v_debt_status := 'CANCELLED';
  ELSIF v_remaining <= 0 THEN
    v_debt_status := 'PAID';
  ELSE
    IF p_sale.due_date IS NOT NULL AND p_sale.due_date < v_today THEN
      v_is_overdue := true;
      v_debt_status := 'OVERDUE';
    ELSIF v_paid > 0 THEN
      v_debt_status := 'PARTIALLY_PAID';
    ELSE
      v_debt_status := 'UNPAID';
    END IF;
  END IF;

  v_result := to_jsonb(p_sale) || jsonb_build_object(
    'vehicle', to_jsonb(v_vehicle),
    'vehicle_code', v_vehicle.internal_code,
    'vehicle_name', v_vehicle.brand || ' ' || v_vehicle.model,
    'internal_code', v_vehicle.internal_code,
    'brand', v_vehicle.brand,
    'model', v_vehicle.model,
    'license_plate', v_vehicle.license_plate,
    'paid_amount', v_paid,
    'remaining_amount', v_remaining,
    'due_date', p_sale.due_date,
    'debt_status', v_debt_status,
    'is_overdue', v_is_overdue
  );

  IF private.can_financials() THEN
    SELECT * INTO v_fin FROM public.sale_financials WHERE sale_id = p_sale.id;
    v_result := v_result || jsonb_build_object(
      'purchase_cost_snapshot', v_fin.purchase_cost_snapshot,
      'expense_cost_snapshot', v_fin.expense_cost_snapshot,
      'total_cost_snapshot', v_fin.total_cost_snapshot,
      'gross_profit', v_fin.gross_profit
    );
  END IF;

  RETURN v_result;
END $$;

-- ============================================================
-- STEP 5: Accounts Receivable query function (list_receivables)
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_receivables(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_search text := left(coalesce(p_filters->>'search', ''), 200);
  v_status text := coalesce(p_filters->>'payment_status', 'DEBT_ONLY');
  v_from date := coalesce(nullif(p_filters->>'from', ''), nullif(p_filters->>'date_from', ''))::date;
  v_to date := coalesce(nullif(p_filters->>'to', ''), nullif(p_filters->>'date_to', ''))::date;
  v_sort text := coalesce(p_filters->>'sort', 'highest_debt');
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_today date := private.today();
  v_items jsonb;
  v_total bigint;
  v_total_receivable bigint := 0;
  v_total_overdue bigint := 0;
  v_overdue_count bigint := 0;
  v_unpaid_count bigint := 0;
BEGIN
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_from > v_to THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE';
  END IF;

  WITH raw_sales AS (
    SELECT
      s.id,
      s.sale_code,
      s.customer_name,
      s.customer_phone,
      s.sale_price,
      s.sale_date,
      s.due_date,
      s.status,
      s.created_at,
      v.internal_code,
      v.license_plate,
      v.brand,
      v.model,
      coalesce((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0) AS paid_amount
    FROM public.sales s
    JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE s.status = 'COMPLETED'
  ),
  with_balances AS (
    SELECT
      rs.*,
      greatest(0, rs.sale_price - rs.paid_amount) AS remaining_amount,
      CASE
        WHEN rs.sale_price - rs.paid_amount <= 0 THEN 'PAID'
        WHEN rs.due_date IS NOT NULL AND rs.due_date < v_today THEN 'OVERDUE'
        WHEN rs.paid_amount > 0 THEN 'PARTIALLY_PAID'
        ELSE 'UNPAID'
      END AS payment_state,
      CASE
        WHEN rs.sale_price - rs.paid_amount > 0 AND rs.due_date IS NOT NULL AND rs.due_date < v_today THEN true
        ELSE false
      END AS is_overdue
    FROM raw_sales rs
  ),
  filtered AS (
    SELECT wb.*
    FROM with_balances wb
    WHERE
      (v_from IS NULL OR wb.sale_date >= v_from)
      AND (v_to IS NULL OR wb.sale_date <= v_to)
      AND (
        v_status = 'ALL'
        OR (v_status = 'DEBT_ONLY' AND wb.remaining_amount > 0)
        OR (v_status = 'OVERDUE' AND wb.is_overdue = true)
        OR (v_status = 'PARTIALLY_PAID' AND wb.payment_state = 'PARTIALLY_PAID')
        OR (v_status = 'UNPAID' AND wb.payment_state = 'UNPAID')
        OR (v_status = 'PAID' AND wb.payment_state = 'PAID')
      )
      AND (
        v_search = ''
        OR concat_ws(' ', wb.sale_code, wb.customer_name, wb.customer_phone, wb.internal_code, wb.license_plate, wb.brand, wb.model) ILIKE '%' || v_search || '%'
      )
  ),
  ordered AS (
    SELECT f.id, row_number() OVER (ORDER BY
      CASE WHEN v_sort = 'highest_debt' THEN f.remaining_amount END DESC,
      CASE WHEN v_sort = 'due_date' THEN f.due_date END ASC NULLS LAST,
      CASE WHEN v_sort = 'oldest' THEN f.sale_date END ASC,
      f.sale_date DESC, f.created_at DESC, f.id
    ) AS ord
    FROM filtered f
    ORDER BY ord
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    coalesce(sum(remaining_amount), 0),
    coalesce(sum(CASE WHEN is_overdue THEN remaining_amount ELSE 0 END), 0),
    count(*) FILTER (WHERE is_overdue),
    count(*) FILTER (WHERE remaining_amount > 0),
    count(*)
  INTO v_total_receivable, v_total_overdue, v_overdue_count, v_unpaid_count, v_total
  FROM filtered;

  SELECT coalesce(jsonb_agg(private.sale_json(s) ORDER BY o.ord), '[]'::jsonb)
  INTO v_items
  FROM ordered o
  JOIN public.sales s ON s.id = o.id;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'total_receivable', v_total_receivable,
    'total_overdue', v_total_overdue,
    'overdue_count', v_overdue_count,
    'unpaid_count', v_unpaid_count
  );
END $$;

-- ============================================================
-- STEP 6: Daily Reconciliation RPC (daily_reconciliation)
-- ============================================================

CREATE OR REPLACE FUNCTION public.daily_reconciliation(p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_day date := coalesce(p_date, private.today());
  v_sales_count bigint;
  v_sales_revenue bigint;
  v_today_sales_collected bigint;
  v_debt_collected_today bigint;
  v_total_collected bigint;
  v_cash_collected bigint;
  v_bank_transfer_collected bigint;
  v_other_collected bigint;
  v_new_debt_created bigint;
  v_business_expenses bigint;
  v_vehicle_expenses bigint;
  v_total_expenses bigint;
  v_net_cash_movement bigint;
  v_payments jsonb;
  v_sales jsonb;
  v_expenses jsonb;
BEGIN
  -- 1. Sales made on v_day
  SELECT
    count(*),
    coalesce(sum(sale_price), 0)
  INTO v_sales_count, v_sales_revenue
  FROM public.sales
  WHERE status = 'COMPLETED' AND sale_date = v_day;

  -- 2. Payments collected on v_day
  SELECT
    coalesce(sum(p.amount) FILTER (WHERE s.sale_date = v_day), 0),
    coalesce(sum(p.amount) FILTER (WHERE s.sale_date < v_day), 0),
    coalesce(sum(p.amount), 0),
    coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'CASH'), 0),
    coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'BANK_TRANSFER'), 0),
    coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'OTHER'), 0)
  INTO
    v_today_sales_collected,
    v_debt_collected_today,
    v_total_collected,
    v_cash_collected,
    v_bank_transfer_collected,
    v_other_collected
  FROM public.payments p
  JOIN public.sales s ON s.id = p.sale_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED';

  -- New debt created today = sales made today minus what was collected today for today's sales
  v_new_debt_created := greatest(0, v_sales_revenue - v_today_sales_collected);

  -- 3. Expenses on v_day
  SELECT coalesce(sum(amount), 0) INTO v_business_expenses
  FROM public.business_expenses
  WHERE status = 'ACTIVE' AND expense_date = v_day;

  SELECT coalesce(sum(amount), 0) INTO v_vehicle_expenses
  FROM public.vehicle_expenses
  WHERE status = 'ACTIVE' AND expense_date = v_day;

  v_total_expenses := v_business_expenses + v_vehicle_expenses;
  v_net_cash_movement := v_total_collected - v_total_expenses;

  -- Detail lists
  SELECT coalesce(jsonb_agg(
    to_jsonb(p) || jsonb_build_object(
      'sale_code', s.sale_code,
      'customer_name', s.customer_name,
      'customer_phone', s.customer_phone,
      'sale_date', s.sale_date,
      'sale_price', s.sale_price,
      'vehicle_name', v.brand || ' ' || v.model,
      'internal_code', v.internal_code,
      'license_plate', v.license_plate,
      'is_prior_debt', s.sale_date < v_day
    ) ORDER BY p.created_at DESC
  ), '[]'::jsonb)
  INTO v_payments
  FROM public.payments p
  JOIN public.sales s ON s.id = p.sale_id
  JOIN public.vehicles v ON v.id = s.vehicle_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED';

  SELECT coalesce(jsonb_agg(private.sale_json(s) ORDER BY s.created_at DESC), '[]'::jsonb)
  INTO v_sales
  FROM public.sales s
  WHERE s.status = 'COMPLETED' AND s.sale_date = v_day;

  SELECT coalesce(jsonb_agg(data ORDER BY expense_date DESC, created_at DESC), '[]'::jsonb)
  INTO v_expenses
  FROM (
    SELECT e.expense_date, e.created_at, to_jsonb(e) || jsonb_build_object('kind', 'vehicle', 'vehicle_name', v.brand || ' ' || v.model, 'internal_code', v.internal_code) AS data
    FROM public.vehicle_expenses e
    JOIN public.vehicles v ON v.id = e.vehicle_id
    WHERE e.status = 'ACTIVE' AND e.expense_date = v_day
    UNION ALL
    SELECT be.expense_date, be.created_at, to_jsonb(be) || jsonb_build_object('kind', 'business') AS data
    FROM public.business_expenses be
    WHERE be.status = 'ACTIVE' AND be.expense_date = v_day
  ) exp;

  RETURN jsonb_build_object(
    'date', v_day,
    'sales_count', v_sales_count,
    'sales_revenue', v_sales_revenue,
    'today_sales_collected', v_today_sales_collected,
    'debt_collected_today', v_debt_collected_today,
    'total_collected', v_total_collected,
    'cash_collected', v_cash_collected,
    'bank_transfer_collected', v_bank_transfer_collected,
    'other_collected', v_other_collected,
    'new_debt_created', v_new_debt_created,
    'business_expenses', v_business_expenses,
    'vehicle_expenses', v_vehicle_expenses,
    'total_expenses', v_total_expenses,
    'net_cash_movement', v_net_cash_movement,
    'payments', v_payments,
    'sales', v_sales,
    'expenses', v_expenses
  );
END $$;

-- ============================================================
-- STEP 7: Actionable Alerts in public.dashboard
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard(
  p_from date DEFAULT date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
  p_to date DEFAULT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_fin boolean := private.can_financials();
  v_manage boolean := private.current_role() IN ('OWNER','MANAGER');
  v_today date := private.today();
  v_month date := date_trunc('month', private.today())::date;
  v_result jsonb;
  v_part jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE';
  END IF;

  SELECT jsonb_build_object(
    'in_stock', count(*) FILTER (WHERE status = 'IN_STOCK'),
    'reserved', count(*) FILTER (WHERE status = 'RESERVED'),
    'inventory_cost_pending', count(*) FILTER (WHERE v.status IN ('IN_STOCK','RESERVED') AND f.purchase_price IS NULL),
    'inventory_cost', CASE WHEN v_fin AND count(*) FILTER (WHERE v.status IN ('IN_STOCK','RESERVED') AND f.purchase_price IS NULL) = 0
      THEN private.safe_money(coalesce(sum(f.purchase_price::numeric + coalesce(e.expenses, 0)) FILTER (WHERE v.status IN ('IN_STOCK','RESERVED')), 0)) ELSE NULL END
  )
  INTO v_result
  FROM public.vehicles v
  LEFT JOIN public.vehicle_financials f ON f.vehicle_id = v.id
  LEFT JOIN LATERAL (
    SELECT sum(amount) AS expenses FROM public.vehicle_expenses WHERE vehicle_id = v.id AND status = 'ACTIVE'
  ) e ON true;

  SELECT jsonb_build_object('inventory_indicator', CASE
    WHEN (v_result->>'in_stock')::integer + (v_result->>'reserved')::integer < low_stock_threshold THEN 'LOW'
    WHEN (v_result->>'in_stock')::integer + (v_result->>'reserved')::integer > high_stock_threshold THEN 'HIGH'
    ELSE 'NORMAL' END)
  INTO v_part
  FROM public.system_settings WHERE id;
  v_result := v_result || v_part;

  -- Sales & revenue
  SELECT jsonb_build_object(
    'sold_today', count(*) FILTER (WHERE sale_date = v_today),
    'sold_month', count(*) FILTER (WHERE sale_date BETWEEN v_month AND v_today),
    'sales_count', count(*) FILTER (WHERE sale_date BETWEEN p_from AND p_to),
    'today_revenue', CASE WHEN v_manage THEN private.safe_money(coalesce(sum(sale_price) FILTER (WHERE sale_date = v_today), 0)) ELSE NULL END,
    'month_revenue', CASE WHEN v_manage THEN private.safe_money(coalesce(sum(sale_price) FILTER (WHERE sale_date BETWEEN v_month AND v_today), 0)) ELSE NULL END,
    'revenue', CASE WHEN v_manage THEN private.safe_money(coalesce(sum(sale_price) FILTER (WHERE sale_date BETWEEN p_from AND p_to), 0)) ELSE NULL END,
    'today_profit', CASE WHEN v_fin THEN private.safe_money(coalesce(sum(gross_profit) FILTER (WHERE sale_date = v_today), 0)) ELSE NULL END,
    'month_profit', CASE WHEN v_fin THEN private.safe_money(coalesce(sum(gross_profit) FILTER (WHERE sale_date BETWEEN v_month AND v_today), 0)) ELSE NULL END,
    'gross_profit', CASE WHEN v_fin THEN private.safe_money(coalesce(sum(gross_profit) FILTER (WHERE sale_date BETWEEN p_from AND p_to), 0)) ELSE NULL END
  )
  INTO v_part
  FROM public.sales s
  JOIN public.sale_financials f ON f.sale_id = s.id
  WHERE status = 'COMPLETED';
  v_result := v_result || v_part;

  -- Actionable business alert counts:
  -- 1. Unpaid debt
  -- 2. Overdue debt
  -- 3. Old inventory (> 60 days)
  WITH sale_debts AS (
    SELECT
      s.id,
      s.sale_price - coalesce((SELECT sum(amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0) AS remaining,
      s.due_date
    FROM public.sales s
    WHERE s.status = 'COMPLETED'
  )
  SELECT jsonb_build_object(
    'unpaid_sales_count', count(*) FILTER (WHERE remaining > 0),
    'total_receivables', coalesce(sum(remaining) FILTER (WHERE remaining > 0), 0),
    'overdue_sales_count', count(*) FILTER (WHERE remaining > 0 AND due_date IS NOT NULL AND due_date < v_today),
    'total_overdue_debt', coalesce(sum(remaining) FILTER (WHERE remaining > 0 AND due_date IS NOT NULL AND due_date < v_today), 0)
  )
  INTO v_part
  FROM sale_debts;
  v_result := v_result || v_part;

  -- Old stock (> 60 days)
  SELECT jsonb_build_object(
    'old_inventory_count', count(*) FILTER (WHERE status IN ('IN_STOCK', 'RESERVED') AND v_today - purchase_date > 60)
  )
  INTO v_part
  FROM public.vehicles;
  v_result := v_result || v_part;

  -- Expenses
  SELECT jsonb_build_object('business_expenses', CASE WHEN v_manage THEN private.safe_money(coalesce(sum(amount), 0)) ELSE NULL END)
  INTO v_part
  FROM public.business_expenses WHERE status = 'ACTIVE' AND expense_date BETWEEN p_from AND p_to;
  v_result := v_result || v_part;

  -- Recent items
  v_result := v_result || jsonb_build_object(
    'recent_sales', public.list_sales(jsonb_build_object('limit', 5, 'from', p_from, 'to', p_to, 'status', 'COMPLETED'))->'items',
    'recent_vehicles', public.list_vehicles(jsonb_build_object('limit', 5))->'items'
  );

  IF v_manage THEN
    v_result := v_result || jsonb_build_object('recent_expenses', public.list_expenses(jsonb_build_object('limit', 5, 'from', p_from, 'to', p_to, 'status', 'ACTIVE'))->'items');
  ELSE
    v_result := v_result || jsonb_build_object('recent_expenses', '[]'::jsonb);
  END IF;

  -- Aging
  SELECT jsonb_build_object('aging', jsonb_build_array(
    jsonb_build_object('bucket', '0–29', 'count', count(*) FILTER (WHERE v_today - purchase_date < 30)),
    jsonb_build_object('bucket', '30–59', 'count', count(*) FILTER (WHERE v_today - purchase_date BETWEEN 30 AND 59)),
    jsonb_build_object('bucket', '60–89', 'count', count(*) FILTER (WHERE v_today - purchase_date BETWEEN 60 AND 89)),
    jsonb_build_object('bucket', '90+', 'count', count(*) FILTER (WHERE v_today - purchase_date >= 90))
  ))
  INTO v_part
  FROM public.vehicles WHERE status IN ('IN_STOCK', 'RESERVED');
  v_result := v_result || v_part;

  -- Longest stock
  SELECT coalesce(jsonb_agg(private.vehicle_json(v) ORDER BY v.purchase_date, v.created_at), '[]'::jsonb)
  INTO v_part
  FROM public.vehicles v
  WHERE v.id IN (
    SELECT id FROM public.vehicles WHERE status IN ('IN_STOCK', 'RESERVED') ORDER BY purchase_date, created_at LIMIT 5
  );
  v_result := v_result || jsonb_build_object('longest_stock', v_part);

  -- Top profitable
  v_part := '[]'::jsonb;
  IF v_fin THEN
    SELECT coalesce(jsonb_agg(private.sale_json(s) ORDER BY f.gross_profit DESC), '[]'::jsonb)
    INTO v_part
    FROM public.sales s
    JOIN public.sale_financials f ON f.sale_id = s.id
    WHERE s.id IN (
      SELECT ss.id FROM public.sales ss
      JOIN public.sale_financials ff ON ff.sale_id = ss.id
      WHERE ss.status = 'COMPLETED' AND ss.sale_date BETWEEN p_from AND p_to
      ORDER BY ff.gross_profit DESC LIMIT 5
    );
  END IF;
  v_result := v_result || jsonb_build_object('top_profitable', v_part);

  -- Daily sales chart
  SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.date), '[]'::jsonb)
  INTO v_part
  FROM (
    SELECT
      s.sale_date AS date,
      count(*) AS count,
      CASE WHEN v_manage THEN private.safe_money(sum(s.sale_price)) ELSE NULL END AS revenue,
      CASE WHEN v_fin THEN private.safe_money(sum(f.gross_profit)) ELSE NULL END AS gross_profit
    FROM public.sales s
    JOIN public.sale_financials f ON f.sale_id = s.id
    WHERE s.status = 'COMPLETED' AND s.sale_date BETWEEN p_from AND p_to
    GROUP BY s.sale_date
  ) d;
  v_result := v_result || jsonb_build_object('daily_sales', v_part);

  -- Acquisitions summary
  SELECT jsonb_build_object(
    'acquired_today', count(*) FILTER (WHERE acquisition_date = v_today),
    'acquired_month', count(*) FILTER (WHERE acquisition_date BETWEEN v_month AND v_today),
    'acquisitions_count', count(*) FILTER (WHERE acquisition_date BETWEEN p_from AND p_to),
    'acquisition_cost', CASE WHEN v_fin THEN private.safe_money(coalesce(sum(purchase_price) FILTER (WHERE acquisition_date BETWEEN p_from AND p_to), 0)) ELSE NULL END
  )
  INTO v_part
  FROM public.acquisitions WHERE status = 'COMPLETED';
  v_result := v_result || v_part;

  -- Recent acquisitions
  v_result := v_result || jsonb_build_object(
    'recent_acquisitions', public.list_acquisitions(jsonb_build_object('limit', 5, 'from', p_from, 'to', p_to, 'status', 'COMPLETED'))->'items'
  );

  RETURN v_result;
END $$;

-- ============================================================
-- STEP 8: Global Search RPC (global_search)
-- ============================================================

CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_q text := left(btrim(coalesce(p_query, '')), 100);
  v_vehicles jsonb := '[]'::jsonb;
  v_customers jsonb := '[]'::jsonb;
  v_sales jsonb := '[]'::jsonb;
  v_limit integer := least(30, greatest(1, coalesce(p_limit, 10)));
BEGIN
  IF length(v_q) < 2 THEN
    RETURN jsonb_build_object('vehicles', v_vehicles, 'customers', v_customers, 'sales', v_sales);
  END IF;

  -- Search Vehicles (NEVER leak purchase_price or profit)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id,
    'internal_code', v.internal_code,
    'brand', v.brand,
    'model', v.model,
    'license_plate', v.license_plate,
    'frame_number', v.frame_number,
    'engine_number', v.engine_number,
    'asking_price', v.asking_price,
    'status', v.status
  )), '[]'::jsonb)
  INTO v_vehicles
  FROM (
    SELECT v.*
    FROM public.vehicles v
    WHERE concat_ws(' ', v.internal_code, v.license_plate, v.brand, v.model, v.frame_number, v.engine_number) ILIKE '%' || v_q || '%'
    ORDER BY v.created_at DESC
    LIMIT v_limit
  ) v;

  -- Search Customers (grouped by phone)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'customer_name', c.customer_name,
    'customer_phone', c.customer_phone,
    'purchases_count', c.purchases_count,
    'total_spent', c.total_spent,
    'latest_sale_date', c.latest_sale_date
  )), '[]'::jsonb)
  INTO v_customers
  FROM (
    SELECT
      max(s.customer_name) AS customer_name,
      s.customer_phone,
      count(*) AS purchases_count,
      sum(s.sale_price) AS total_spent,
      max(s.sale_date) AS latest_sale_date
    FROM public.sales s
    WHERE s.status = 'COMPLETED'
      AND (s.customer_name ILIKE '%' || v_q || '%' OR s.customer_phone ILIKE '%' || v_q || '%')
    GROUP BY s.customer_phone
    ORDER BY max(s.sale_date) DESC
    LIMIT v_limit
  ) c;

  -- Search Sales (NEVER leak cost snapshot or profit)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'sale_code', s.sale_code,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'vehicle_name', v.brand || ' ' || v.model,
    'internal_code', v.internal_code,
    'license_plate', v.license_plate,
    'sale_date', s.sale_date,
    'sale_price', s.sale_price,
    'remaining_amount', greatest(0, s.sale_price - coalesce((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0)),
    'status', s.status
  )), '[]'::jsonb)
  INTO v_sales
  FROM (
    SELECT s.*, v.brand, v.model, v.internal_code, v.license_plate
    FROM public.sales s
    JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE concat_ws(' ', s.sale_code, s.customer_name, s.customer_phone, v.internal_code, v.license_plate) ILIKE '%' || v_q || '%'
    ORDER BY s.sale_date DESC, s.created_at DESC
    LIMIT v_limit
  ) s;

  RETURN jsonb_build_object('vehicles', v_vehicles, 'customers', v_customers, 'sales', v_sales);
END $$;

-- ============================================================
-- STEP 9: Customer History RPCs (list_customers, get_customer_history)
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_customers(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_search text := left(coalesce(p_filters->>'search', ''), 100);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
BEGIN
  WITH customer_summary AS (
    SELECT
      max(s.customer_name) AS customer_name,
      s.customer_phone,
      count(*) AS purchases_count,
      sum(s.sale_price) AS total_spent,
      sum(coalesce((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0)) AS total_paid,
      sum(greatest(0, s.sale_price - coalesce((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0))) AS total_debt,
      min(s.sale_date) AS first_purchase_date,
      max(s.sale_date) AS latest_purchase_date
    FROM public.sales s
    WHERE s.status = 'COMPLETED' AND length(btrim(s.customer_phone)) > 0
    GROUP BY s.customer_phone
  ),
  filtered AS (
    SELECT *
    FROM customer_summary cs
    WHERE (v_search = '' OR cs.customer_name ILIKE '%' || v_search || '%' OR cs.customer_phone ILIKE '%' || v_search || '%')
  ),
  paged AS (
    SELECT *
    FROM filtered
    ORDER BY latest_purchase_date DESC, purchases_count DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    count(*),
    coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.latest_purchase_date DESC), '[]'::jsonb)
  INTO v_total, v_items
  FROM paged p;

  RETURN jsonb_build_object('items', v_items, 'total', coalesce((SELECT count(*) FROM filtered), 0));
END $$;

CREATE OR REPLACE FUNCTION public.get_customer_history(p_phone text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_clean_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_summary jsonb;
  v_sales jsonb;
BEGIN
  IF length(v_clean_phone) < 3 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PHONE_NUMBER';
  END IF;

  SELECT jsonb_build_object(
    'customer_name', max(s.customer_name),
    'customer_phone', v_clean_phone,
    'purchases_count', count(*),
    'total_spent', sum(s.sale_price),
    'total_paid', sum(coalesce((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0)),
    'total_debt', sum(greatest(0, s.sale_price - coalesce((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0))),
    'first_purchase_date', min(s.sale_date),
    'latest_purchase_date', max(s.sale_date)
  )
  INTO v_summary
  FROM public.sales s
  WHERE s.status = 'COMPLETED' AND regexp_replace(s.customer_phone, '[^0-9+]', '', 'g') = v_clean_phone;

  IF v_summary IS NULL OR v_summary->>'customer_name' IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  END IF;

  SELECT coalesce(jsonb_agg(private.sale_json(s) ORDER BY s.sale_date DESC, s.created_at DESC), '[]'::jsonb)
  INTO v_sales
  FROM public.sales s
  WHERE s.status = 'COMPLETED' AND regexp_replace(s.customer_phone, '[^0-9+]', '', 'g') = v_clean_phone;

  RETURN v_summary || jsonb_build_object('sales', v_sales);
END $$;

-- ============================================================
-- STEP 10: Import Validation & Execution RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_import_vehicles(p_vehicles jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_elem jsonb;
  v_frame text;
  v_engine text;
  v_plate text;
  v_duplicates jsonb := '[]'::jsonb;
  v_idx integer := 0;
BEGIN
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_vehicles) LOOP
    v_frame := btrim(coalesce(v_elem->>'frame_number', ''));
    v_engine := btrim(coalesce(v_elem->>'engine_number', ''));
    v_plate := btrim(coalesce(v_elem->>'license_plate', ''));

    IF v_frame <> '' AND EXISTS (SELECT 1 FROM public.vehicles WHERE frame_number = v_frame) THEN
      v_duplicates := v_duplicates || jsonb_build_object(
        'index', v_idx,
        'field', 'frame_number',
        'value', v_frame,
        'message', 'Số khung đã tồn tại trong hệ thống'
      );
    END IF;

    IF v_engine <> '' AND EXISTS (SELECT 1 FROM public.vehicles WHERE engine_number = v_engine) THEN
      v_duplicates := v_duplicates || jsonb_build_object(
        'index', v_idx,
        'field', 'engine_number',
        'value', v_engine,
        'message', 'Số máy đã tồn tại trong hệ thống'
      );
    END IF;

    IF v_plate <> '' AND EXISTS (SELECT 1 FROM public.vehicles WHERE license_plate = v_plate) THEN
      v_duplicates := v_duplicates || jsonb_build_object(
        'index', v_idx,
        'field', 'license_plate',
        'value', v_plate,
        'message', 'Biển số đã tồn tại trong hệ thống'
      );
    END IF;

    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object('duplicates', v_duplicates);
END $$;

CREATE OR REPLACE FUNCTION public.import_vehicles(p_vehicles jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_elem jsonb;
  v_vehicle public.vehicles;
  v_acq public.acquisitions;
  v_frame text;
  v_date date;
  v_purchase bigint;
  v_asking bigint;
  v_year integer;
  v_odo integer;
  v_count integer := 0;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF jsonb_array_length(p_vehicles) = 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'NO_DATA_TO_IMPORT';
  END IF;

  IF jsonb_array_length(p_vehicles) > 500 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'IMPORT_BATCH_TOO_LARGE';
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_vehicles) LOOP
    v_frame := btrim(coalesce(v_elem->>'frame_number', ''));
    IF v_frame = '' OR char_length(v_frame) > 100 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_FRAME_NUMBER';
    END IF;

    IF btrim(coalesce(v_elem->>'brand', '')) = '' OR char_length(btrim(v_elem->>'brand')) > 80 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_BRAND';
    END IF;

    IF btrim(coalesce(v_elem->>'model', '')) = '' OR char_length(btrim(v_elem->>'model')) > 120 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_MODEL';
    END IF;

    v_date := coalesce(nullif(v_elem->>'purchase_date', '')::date, private.today());
    IF v_date > private.today() THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_DATE_IN_FUTURE';
    END IF;

    v_purchase := private.money_input(v_elem, 'purchase_price', 0);
    v_asking := private.money_input(v_elem, 'asking_price', 0);
    v_year := nullif(v_elem->>'year', '')::integer;
    IF v_year IS NOT NULL AND (v_year < 1900 OR v_year > 2100) THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_YEAR';
    END IF;

    v_odo := coalesce(nullif(v_elem->>'odometer', '')::integer, 0);
    IF v_odo < 0 OR v_odo > 10000000 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_ODOMETER';
    END IF;

    INSERT INTO public.vehicles (
      frame_number, engine_number, license_plate,
      brand, model, variant, year, color, odometer,
      purchase_date, asking_price, status,
      supplier_name, supplier_phone, notes, created_by
    ) VALUES (
      v_frame,
      btrim(coalesce(v_elem->>'engine_number', '')),
      btrim(coalesce(v_elem->>'license_plate', '')),
      btrim(v_elem->>'brand'),
      btrim(v_elem->>'model'),
      btrim(coalesce(v_elem->>'variant', '')),
      v_year,
      btrim(coalesce(v_elem->>'color', '')),
      v_odo,
      v_date,
      v_asking,
      'IN_STOCK'::public.vehicle_status,
      btrim(coalesce(v_elem->>'supplier_name', '')),
      btrim(coalesce(v_elem->>'supplier_phone', '')),
      coalesce(v_elem->>'notes', ''),
      v_actor
    ) RETURNING * INTO v_vehicle;

    INSERT INTO public.vehicle_financials (vehicle_id, purchase_price, updated_by)
    VALUES (v_vehicle.id, v_purchase, v_actor);

    INSERT INTO public.acquisitions (
      vehicle_id, acquisition_date, purchase_price,
      seller_name, seller_phone, notes, status, created_by
    ) VALUES (
      v_vehicle.id,
      v_date,
      v_purchase,
      btrim(coalesce(v_elem->>'supplier_name', '')),
      btrim(coalesce(v_elem->>'supplier_phone', '')),
      coalesce(v_elem->>'notes', ''),
      'COMPLETED'::public.acquisition_status,
      v_actor
    ) RETURNING * INTO v_acq;

    PERFORM private.audit('CREATE_VEHICLE', 'vehicles', v_vehicle.id, null, to_jsonb(v_vehicle) || jsonb_build_object('purchase_price', v_purchase, 'source', 'CSV_IMPORT'), v_vehicle.id);
    PERFORM private.audit('CREATE_ACQUISITION', 'acquisitions', v_acq.id, null, to_jsonb(v_acq) || jsonb_build_object('source', 'CSV_IMPORT'), v_vehicle.id);

    v_count := v_count + 1;
    v_ids := array_append(v_ids, v_vehicle.id);
  END LOOP;

  RETURN jsonb_build_object('imported_count', v_count, 'vehicle_ids', to_jsonb(v_ids));
END $$;

-- ============================================================
-- STEP 11: Grants
-- ============================================================

GRANT EXECUTE ON FUNCTION public.list_receivables TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_sale_due_date TO authenticated;
GRANT EXECUTE ON FUNCTION public.daily_reconciliation TO authenticated;
GRANT EXECUTE ON FUNCTION public.global_search TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_import_vehicles TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_vehicles TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_customers TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_history TO authenticated;
