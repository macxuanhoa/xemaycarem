-- Migration: 20261001003100_production_reconciliation.sql
-- Description: forward-only reconciliation of production to the validated local final state.
--   * Replaces the 15 function bodies that drifted because historical migrations (001-025)
--     were rewritten AFTER production had already applied them (VIEWER role removal,
--     active/schedule gating, financial-visibility hardening).
--   * Re-enforces the exact function/table/view/sequence GRANT-REVOKE matrix and the RLS
--     enable/force flags observed in the fully replayed local database (the state every
--     local test, security check and E2E run was validated against).
-- This migration replays no historical DDL, creates no new objects and deletes no data.
-- Signatures were verified 1:1 against production, so CREATE OR REPLACE is safe and
-- dependent triggers and RLS policies continue to resolve to the same function OIDs.

-- schema isolation for private helpers (mirrors 001/002 intent)
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- ============ drifted function bodies: local final state ============
-- ---------------------------------------------------------------------
-- final-state body from local replay: private.new_auth_user
CREATE OR REPLACE FUNCTION private.new_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_username text;
BEGIN
  -- Extract username from metadata if provided, otherwise from email or fallback
  v_username := lower(btrim(coalesce(
    new.raw_user_meta_data->>'username',
    regexp_replace(new.email, '@.*$', '', 'g'),
    'user_' || substr(new.id::text, 1, 8)
  )));
  
  v_username := regexp_replace(v_username, '[^a-z0-9_.]', '_', 'g');
  IF length(v_username) < 3 THEN
    v_username := v_username || '_' || substr(new.id::text, 1, 4);
  END IF;
  IF length(v_username) > 30 THEN
    v_username := substr(v_username, 1, 30);
  END IF;
  
  -- Ensure username uniqueness
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username AND id <> new.id) LOOP
    v_username := substr(v_username, 1, 25) || substr(md5(random()::text), 1, 4);
  END LOOP;
  
  INSERT INTO public.profiles(
    id, full_name, role, active, username, must_change_password,
    disabled_until, allowed_from, allowed_until, working_days, deleted_at, disable_reason
  ) VALUES (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''), 'Người dùng mới'), 120),
    'STAFF',
    true, -- Provisioned accounts are active by default
    v_username,
    false,
    NULL, '00:00:00', '23:59:59', ARRAY[1,2,3,4,5,6,7], NULL, NULL
  ) ON CONFLICT (id) DO NOTHING;
  
  RETURN new;
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.dashboard
CREATE OR REPLACE FUNCTION public.dashboard(p_from date DEFAULT (date_trunc('month'::text, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)))::date, p_to date DEFAULT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
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
    'total_receivables', private.safe_money(coalesce(sum(remaining) FILTER (WHERE remaining > 0), 0)),
    'overdue_sales_count', count(*) FILTER (WHERE remaining > 0 AND due_date IS NOT NULL AND due_date < v_today),
    'total_overdue_debt', private.safe_money(coalesce(sum(remaining) FILTER (WHERE remaining > 0 AND due_date IS NOT NULL AND due_date < v_today), 0))
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
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.get_customer_history
CREATE OR REPLACE FUNCTION public.get_customer_history(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_phone text := private.normalize_customer_phone(p_phone);
  v_summary jsonb;
  v_sales jsonb;
BEGIN
  IF length(v_phone) < 3 THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PHONE_NUMBER'; END IF;
  WITH matching AS (
    SELECT s.*, coalesce(p.paid, 0) AS paid FROM public.sales s
    LEFT JOIN LATERAL (SELECT private.safe_money(sum(amount)) AS paid FROM public.payments
      WHERE sale_id = s.id AND status = 'ACTIVE') p ON true
    WHERE s.status = 'COMPLETED' AND private.normalize_customer_phone(s.customer_phone) = v_phone
  )
  SELECT jsonb_build_object(
    'customer_name', (array_agg(customer_name ORDER BY sale_date DESC, created_at DESC, id))[1],
    'customer_phone', v_phone,
    'customer_names', array_agg(DISTINCT customer_name ORDER BY customer_name),
    'identity_warning', count(DISTINCT lower(btrim(customer_name))) > 1,
    'purchases_count', count(*), 'total_spent', private.safe_money(coalesce(sum(sale_price), 0)),
    'total_paid', private.safe_money(coalesce(sum(paid), 0)),
    'total_debt', private.safe_money(coalesce(sum(greatest(0, sale_price - paid)), 0)),
    'first_purchase_date', min(sale_date), 'latest_purchase_date', max(sale_date)
  ) INTO v_summary FROM matching;
  IF v_summary->>'customer_name' IS NULL THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND'; END IF;
  SELECT coalesce(jsonb_agg(public.get_sale(s.id) ORDER BY s.sale_date DESC, s.created_at DESC, s.id), '[]'::jsonb)
  INTO v_sales FROM public.sales s
  WHERE s.status = 'COMPLETED' AND private.normalize_customer_phone(s.customer_phone) = v_phone;
  RETURN v_summary || jsonb_build_object('sales', v_sales);
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.get_sale
CREATE OR REPLACE FUNCTION public.get_sale(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_sale public.sales;
  v_payments jsonb;
  v_employee text;
BEGIN
  SELECT * INTO v_sale FROM public.sales WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND'; END IF;
  SELECT full_name INTO v_employee FROM public.profiles WHERE id = v_sale.sold_by;
  SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('creator_name', profile.full_name)
    ORDER BY p.payment_date, p.created_at, p.id), '[]'::jsonb) INTO v_payments
  FROM public.payments p LEFT JOIN public.profiles profile ON profile.id = p.created_by WHERE sale_id = p_id;
  RETURN private.sale_json(v_sale) || jsonb_build_object('payments', v_payments, 'employee_name', v_employee);
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.get_settings
CREATE OR REPLACE FUNCTION public.get_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]); v_result jsonb;
begin select to_jsonb(s) into v_result from public.system_settings s where id; return v_result; end $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.get_vehicle
CREATE OR REPLACE FUNCTION public.get_vehicle(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles; v_images jsonb; v_expenses jsonb:='[]'; v_sales jsonb; v_activity jsonb;
begin
  select * into v_vehicle from public.vehicles where id=p_id;
  if not found then raise exception using errcode='P0002',message='VEHICLE_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(to_jsonb(i) order by display_order,created_at),'[]'::jsonb) into v_images from public.vehicle_images i where vehicle_id=p_id and deleted_at is null;
  if private.current_role() in ('OWNER','MANAGER') then
    select coalesce(jsonb_agg(to_jsonb(e) order by expense_date desc,created_at desc),'[]'::jsonb) into v_expenses from public.vehicle_expenses e where vehicle_id=p_id;
  end if;
  select coalesce(jsonb_agg(public.get_sale(s.id) order by created_at desc),'[]'::jsonb) into v_sales from public.sales s where vehicle_id=p_id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc),'[]'::jsonb) into v_activity from (
    select a.*,p.full_name as actor_name from public.vehicle_activity a left join public.profiles p on p.id=a.user_id where vehicle_id=p_id order by a.created_at desc,a.id desc limit 100
  ) a;
  return private.vehicle_json(v_vehicle)||jsonb_build_object('images',v_images,'expenses',v_expenses,'sales',v_sales,'activity',v_activity);
end $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.global_search
CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_query text := left(btrim(coalesce(p_query, '')), 100);
  v_phone text := private.normalize_customer_phone(v_query);
  v_limit integer := least(30, greatest(1, coalesce(p_limit, 10)));
  v_vehicles jsonb := '[]'::jsonb;
  v_customers jsonb := '[]'::jsonb;
  v_sales jsonb := '[]'::jsonb;
BEGIN
  IF length(v_query) < 2 THEN RETURN jsonb_build_object('vehicles', v_vehicles, 'customers', v_customers, 'sales', v_sales); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.created_at DESC, v.id), '[]'::jsonb) INTO v_vehicles
  FROM (SELECT id, internal_code, brand, model, license_plate, frame_number, engine_number, asking_price, status, created_at
    FROM public.vehicles WHERE concat_ws(' ', internal_code, license_plate, brand, model, frame_number, engine_number)
      ILIKE '%' || v_query || '%' ORDER BY created_at DESC, id LIMIT v_limit) v;
  v_customers := public.list_customers(jsonb_build_object('search', v_query, 'limit', v_limit))->'items';
  SELECT coalesce(jsonb_agg(to_jsonb(result) ORDER BY result.sale_date DESC, result.created_at DESC, result.id), '[]'::jsonb)
  INTO v_sales FROM (
    SELECT s.id, s.sale_code, s.customer_name, s.customer_phone,
      v.brand || ' ' || v.model AS vehicle_name, v.internal_code, v.license_plate,
      s.sale_date, s.created_at, s.sale_price, s.status,
      CASE WHEN s.status = 'COMPLETED' THEN greatest(0, s.sale_price - coalesce(p.paid, 0)) ELSE 0 END AS remaining_amount
    FROM public.sales s JOIN public.vehicles v ON v.id = s.vehicle_id
    LEFT JOIN LATERAL (SELECT private.safe_money(sum(amount)) AS paid FROM public.payments
      WHERE sale_id = s.id AND status = 'ACTIVE') p ON true
    WHERE concat_ws(' ', s.sale_code, s.customer_name, s.customer_phone, v.internal_code, v.license_plate,
      v.frame_number, v.engine_number, v.brand, v.model) ILIKE '%' || v_query || '%'
      OR (v_phone <> '' AND private.normalize_customer_phone(s.customer_phone) LIKE '%' || v_phone || '%')
    ORDER BY s.sale_date DESC, s.created_at DESC, s.id LIMIT v_limit
  ) result;
  RETURN jsonb_build_object('vehicles', v_vehicles, 'customers', v_customers, 'sales', v_sales);
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.list_acquisitions
CREATE OR REPLACE FUNCTION public.list_acquisitions(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_from date := coalesce(nullif(p_filters->>'from', ''), nullif(p_filters->>'date_from', ''))::date;
  v_to date := coalesce(nullif(p_filters->>'to', ''), nullif(p_filters->>'date_to', ''))::date;
  v_search text := left(coalesce(p_filters->>'search', ''), 200);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
  v_fin boolean := private.can_financials();
BEGIN
  IF v_from > v_to THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE';
  END IF;

  WITH matching AS (
    SELECT a.*, v.frame_number, v.license_plate, v.brand, v.model, v.internal_code,
           p.full_name AS creator_name
    FROM public.acquisitions a
    JOIN public.vehicles v ON v.id = a.vehicle_id
    LEFT JOIN public.profiles p ON p.id = a.created_by
    WHERE
      (v_from IS NULL OR a.acquisition_date >= v_from)
      AND (v_to IS NULL OR a.acquisition_date <= v_to)
      AND (nullif(p_filters->>'status', '') IS NULL OR a.status::text = p_filters->>'status')
      AND (v_search = '' OR concat_ws(' ', v.frame_number, v.license_plate, v.brand, v.model, v.internal_code, a.seller_name, a.seller_phone) ILIKE '%' || v_search || '%')
  ),
  paged AS (
    SELECT * FROM matching
    ORDER BY acquisition_date DESC, created_at DESC, id
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    (SELECT count(*) FROM matching),
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'vehicle_id', p.vehicle_id,
          'frame_number', p.frame_number,
          'license_plate', p.license_plate,
          'brand', p.brand,
          'model', p.model,
          'internal_code', p.internal_code,
          'vehicle_name', p.brand || ' ' || p.model,
          'acquisition_date', p.acquisition_date,
          'purchase_price', CASE WHEN v_fin THEN p.purchase_price ELSE NULL END,
          'seller_name', p.seller_name,
          'seller_phone', p.seller_phone,
          'status', p.status,
          'notes', p.notes,
          'creator_name', p.creator_name,
          'created_by', p.created_by,
          'created_at', p.created_at
        ) ORDER BY p.acquisition_date DESC, p.created_at DESC, p.id
      ) FROM paged p
    ), '[]'::jsonb)
  INTO v_total, v_items;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.list_customers
CREATE OR REPLACE FUNCTION public.list_customers(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_search text := left(btrim(coalesce(p_filters->>'search', '')), 100);
  v_phone_search text := private.normalize_customer_phone(v_search);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_result jsonb;
BEGIN
  WITH paid AS (
    SELECT sale_id, private.safe_money(sum(amount)) AS amount
    FROM public.payments WHERE status = 'ACTIVE' GROUP BY sale_id
  ), customers AS (
    SELECT (array_agg(s.customer_name ORDER BY s.sale_date DESC, s.created_at DESC, s.id))[1] AS customer_name,
      private.normalize_customer_phone(s.customer_phone) AS customer_phone,
      array_agg(DISTINCT s.customer_name ORDER BY s.customer_name) AS customer_names,
      count(DISTINCT lower(btrim(s.customer_name))) > 1 AS identity_warning,
      count(*) AS purchases_count,
      private.safe_money(sum(s.sale_price)) AS total_spent,
      private.safe_money(sum(coalesce(p.amount, 0))) AS total_paid,
      private.safe_money(sum(greatest(0, s.sale_price - coalesce(p.amount, 0)))) AS total_debt,
      min(s.sale_date) AS first_purchase_date, max(s.sale_date) AS latest_purchase_date
    FROM public.sales s LEFT JOIN paid p ON p.sale_id = s.id
    WHERE s.status = 'COMPLETED' AND private.normalize_customer_phone(s.customer_phone) <> ''
    GROUP BY private.normalize_customer_phone(s.customer_phone)
  ), filtered AS (
    SELECT * FROM customers c WHERE v_search = '' OR
      array_to_string(c.customer_names, ' ') ILIKE '%' || v_search || '%'
      OR (v_phone_search <> '' AND c.customer_phone LIKE '%' || v_phone_search || '%')
  ), paged AS (
    SELECT * FROM filtered ORDER BY latest_purchase_date DESC, purchases_count DESC, customer_phone
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object('total', (SELECT count(*) FROM filtered),
    'items', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.latest_purchase_date DESC,
      p.purchases_count DESC, p.customer_phone) FROM paged p), '[]'::jsonb)) INTO v_result;
  RETURN v_result;
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.list_receivables
CREATE OR REPLACE FUNCTION public.list_receivables(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_search text := left(btrim(coalesce(p_filters->>'search', '')), 200);
  v_status text := coalesce(p_filters->>'payment_status', 'DEBT_ONLY');
  v_from date := coalesce(nullif(p_filters->>'from', ''), nullif(p_filters->>'date_from', ''))::date;
  v_to date := coalesce(nullif(p_filters->>'to', ''), nullif(p_filters->>'date_to', ''))::date;
  v_sort text := coalesce(p_filters->>'sort', 'highest_debt');
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_result jsonb;
BEGIN
  IF v_from > v_to THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE'; END IF;
  IF v_status NOT IN ('ALL','DEBT_ONLY','OVERDUE','PARTIALLY_PAID','UNPAID','PAID') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT_STATUS';
  END IF;
  WITH paid AS (
    SELECT sale_id, private.safe_money(sum(amount)) AS amount
    FROM public.payments WHERE status = 'ACTIVE' GROUP BY sale_id
  ), balances AS (
    SELECT s.id, s.sale_code, s.customer_name, s.customer_phone, s.sale_date, s.due_date, s.created_at,
      v.internal_code, v.license_plate, v.brand, v.model,
      coalesce(p.amount, 0) AS paid_amount,
      greatest(0, s.sale_price - coalesce(p.amount, 0)) AS remaining_amount,
      s.due_date IS NOT NULL AND s.due_date < private.today()
        AND s.sale_price > coalesce(p.amount, 0) AS is_overdue
    FROM public.sales s JOIN public.vehicles v ON v.id = s.vehicle_id
    LEFT JOIN paid p ON p.sale_id = s.id WHERE s.status = 'COMPLETED'
  ), filtered AS (
    SELECT b.* FROM balances b WHERE
      (v_from IS NULL OR b.sale_date >= v_from) AND (v_to IS NULL OR b.sale_date <= v_to)
      AND (v_status = 'ALL'
        OR (v_status = 'DEBT_ONLY' AND b.remaining_amount > 0)
        OR (v_status = 'OVERDUE' AND b.is_overdue)
        OR (v_status = 'PARTIALLY_PAID' AND b.remaining_amount > 0 AND b.paid_amount > 0)
        OR (v_status = 'UNPAID' AND b.remaining_amount > 0 AND b.paid_amount = 0)
        OR (v_status = 'PAID' AND b.remaining_amount = 0))
      AND (v_search = '' OR concat_ws(' ', b.sale_code, b.customer_name, b.customer_phone,
        b.internal_code, b.license_plate, b.brand, b.model) ILIKE '%' || v_search || '%')
  ), ordered AS (
    SELECT f.id, row_number() OVER (ORDER BY
      CASE WHEN v_sort = 'highest_debt' THEN f.remaining_amount END DESC,
      CASE WHEN v_sort = 'due_date' THEN f.due_date END ASC NULLS LAST,
      CASE WHEN v_sort = 'oldest' THEN f.sale_date END ASC,
      f.sale_date DESC, f.created_at DESC, f.id) AS ord
    FROM filtered f
  ), paged AS (
    SELECT * FROM ordered ORDER BY ord LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(private.sale_json(s) ORDER BY p.ord)
      FROM paged p JOIN public.sales s ON s.id = p.id), '[]'::jsonb),
    'total', count(*),
    'total_receivable', private.safe_money(coalesce(sum(remaining_amount), 0)),
    'total_overdue', private.safe_money(coalesce(sum(remaining_amount) FILTER (WHERE is_overdue), 0)),
    'overdue_count', count(*) FILTER (WHERE is_overdue),
    'unpaid_count', count(*) FILTER (WHERE remaining_amount > 0)
  ) INTO v_result FROM filtered;
  RETURN v_result;
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.list_sales
CREATE OR REPLACE FUNCTION public.list_sales(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_from date:=coalesce(nullif(p_filters->>'from',''),nullif(p_filters->>'date_from',''))::date;
  v_to date:=coalesce(nullif(p_filters->>'to',''),nullif(p_filters->>'date_to',''))::date;
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if v_from>v_to then raise exception using errcode='22023',message='INVALID_DATE_RANGE'; end if;
  with matching as (
    select s.* from public.sales s join public.vehicles v on v.id=s.vehicle_id where
      (v_from is null or s.sale_date>=v_from) and (v_to is null or s.sale_date<=v_to) and
      (nullif(p_filters->>'status','') is null or s.status::text=p_filters->>'status') and
      (v_search='' or concat_ws(' ',s.sale_code,s.customer_name,s.customer_phone,v.internal_code,v.license_plate,v.brand,v.model) ilike '%'||v_search||'%')
  ), paged as (select * from matching order by sale_date desc,created_at desc,id limit v_limit offset v_offset)
  select (select count(*) from matching),coalesce((select jsonb_agg(private.sale_json(s) order by sale_date desc,created_at desc,id) from public.sales s where id in(select id from paged)),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.list_vehicles
CREATE OR REPLACE FUNCTION public.list_vehicles(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.save_settings
CREATE OR REPLACE FUNCTION public.save_settings(p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]); v_old jsonb; v_new jsonb;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;
  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;
  UPDATE public.system_settings SET store_name=btrim(coalesce(p_data->>'store_name',store_name)),phone=btrim(coalesce(p_data->>'phone',phone)),
    address=btrim(coalesce(p_data->>'address',address)),low_stock_threshold=coalesce((p_data->>'low_stock_threshold')::integer,low_stock_threshold),
    high_stock_threshold=coalesce((p_data->>'high_stock_threshold')::integer,high_stock_threshold),
    customer_messaging_enabled=coalesce((p_data->>'customer_messaging_enabled')::boolean,customer_messaging_enabled),
    sale_thank_you_enabled=coalesce((p_data->>'sale_thank_you_enabled')::boolean,sale_thank_you_enabled),
    primary_message_channel=coalesce(p_data->>'primary_message_channel',primary_message_channel),
    fallback_channel=coalesce(p_data->>'fallback_channel',fallback_channel),support_phone=btrim(coalesce(p_data->>'support_phone',support_phone)),
    updated_by=v_actor,updated_at=now() WHERE id RETURNING to_jsonb(system_settings) INTO v_new;
  PERFORM private.audit('MESSAGE_SETTING_CHANGED','system_settings',null,v_old,v_new);
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.sell_vehicle
CREATE OR REPLACE FUNCTION public.sell_vehicle(p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
END $function$
;
-- ---------------------------------------------------------------------
-- final-state body from local replay: public.update_profile
CREATE OR REPLACE FUNCTION public.update_profile(p_id uuid, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_actor_role public.user_role := private.current_role();
  v_old public.profiles;
  v_new public.profiles;
  v_role public.user_role;
  v_active boolean;
  v_fin boolean;
  v_username text;
  v_disabled_until timestamptz;
  v_allowed_from time;
  v_allowed_until time;
  v_working_days integer[];
  v_must_change_pwd boolean;
  v_audit_action text;
BEGIN
  -- Advisory lock to prevent simultaneous demotions of last OWNER
  PERFORM pg_advisory_xact_lock(761482190);
  
  SELECT * INTO v_old FROM public.profiles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002', message='PROFILE_NOT_FOUND'; END IF;
  
  -- Non-owners can ONLY update their own full_name
  IF v_actor_role <> 'OWNER' THEN
    IF p_id <> v_actor OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k NOT IN ('full_name')
    ) THEN
      RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
    END IF;
  END IF;
  
  v_role := COALESCE((p_data->>'role')::public.user_role, v_old.role);
  v_active := COALESCE((p_data->>'active')::boolean, v_old.active);
  v_fin := COALESCE((p_data->>'can_view_financials')::boolean, v_old.can_view_financials);
  v_username := lower(btrim(COALESCE(p_data->>'username', v_old.username)));
  v_must_change_pwd := COALESCE((p_data->>'must_change_password')::boolean, v_old.must_change_password);
  
  -- Handle disabled_until
  IF p_data ? 'disabled_until' THEN
    v_disabled_until := (p_data->>'disabled_until')::timestamptz;
  ELSE
    v_disabled_until := v_old.disabled_until;
  END IF;
  
  -- Handle allowed_from and allowed_until
  IF p_data ? 'allowed_from' THEN
    v_allowed_from := (p_data->>'allowed_from')::time;
  ELSE
    v_allowed_from := v_old.allowed_from;
  END IF;
  
  IF p_data ? 'allowed_until' THEN
    v_allowed_until := (p_data->>'allowed_until')::time;
  ELSE
    v_allowed_until := v_old.allowed_until;
  END IF;
  
  -- Handle working_days
  IF p_data ? 'working_days' AND jsonb_typeof(p_data->'working_days') = 'array' THEN
    SELECT COALESCE(array_agg(elem::int), ARRAY[1,2,3,4,5,6,7])
    INTO v_working_days
    FROM jsonb_array_elements_text(p_data->'working_days') AS elem;
  ELSE
    v_working_days := v_old.working_days;
  END IF;
  
  -- Username change validations
  IF v_username <> v_old.username THEN
    IF v_actor_role <> 'OWNER' THEN RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED'; END IF;
    IF v_username !~ '^[a-z0-9_.]{3,30}$' THEN
      RAISE EXCEPTION USING errcode='22023', message='INVALID_USERNAME';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username AND id <> p_id) THEN
      RAISE EXCEPTION USING errcode='23505', message='USERNAME_EXISTS';
    END IF;
  END IF;
  
  -- Protect the last active OWNER
  IF v_old.role = 'OWNER' AND v_old.active AND (v_role <> 'OWNER' OR NOT v_active) AND NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE role = 'OWNER' AND active AND id <> p_id
  ) THEN
    RAISE EXCEPTION USING errcode='22023', message='LAST_OWNER_REQUIRED';
  END IF;
  
  UPDATE public.profiles SET
    full_name = btrim(COALESCE(p_data->>'full_name', full_name)),
    role = v_role,
    active = v_active,
    can_view_financials = v_fin,
    username = v_username,
    must_change_password = v_must_change_pwd,
    disabled_until = v_disabled_until,
    allowed_from = v_allowed_from,
    allowed_until = v_allowed_until,
    working_days = v_working_days,
    disable_reason = COALESCE(p_data->>'disable_reason', disable_reason),
    deleted_at = CASE 
      WHEN p_data ? 'deleted_at' THEN (p_data->>'deleted_at')::timestamptz
      ELSE deleted_at
    END,
    updated_at = now()
  WHERE id = p_id RETURNING * INTO v_new;
  
  -- Audit specific action
  IF v_old.active AND NOT v_new.active THEN
    v_audit_action := 'DISABLE_USER';
  ELSIF NOT v_old.active AND v_new.active THEN
    v_audit_action := 'ENABLE_USER';
  ELSIF v_old.disabled_until IS NULL AND v_new.disabled_until > now() THEN
    v_audit_action := 'TEMP_LOCK_USER';
  ELSIF v_old.disabled_until IS NOT NULL AND v_new.disabled_until IS NULL THEN
    v_audit_action := 'UNLOCK_USER';
  ELSIF v_old.role <> v_new.role THEN
    v_audit_action := 'CHANGE_USER_ROLE';
  ELSIF v_old.allowed_from <> v_new.allowed_from OR v_old.allowed_until <> v_new.allowed_until OR v_old.working_days <> v_new.working_days THEN
    v_audit_action := 'CHANGE_ACCESS_SCHEDULE';
  ELSIF NOT v_old.must_change_password AND v_new.must_change_password THEN
    v_audit_action := 'FORCE_PASSWORD_CHANGE';
  ELSE
    v_audit_action := 'UPDATE_USER';
  END IF;
  
  PERFORM private.audit(v_audit_action, 'profiles', p_id, to_jsonb(v_old), to_jsonb(v_new));
END $function$
;

-- ============ privilege matrix enforcement: local final state ============
revoke all on function private.can_financials() from public, anon, authenticated;
grant execute on function private.can_financials() to authenticated;
revoke all on function private.can_read_identity_document_image(p_path text) from public, anon, authenticated;
grant execute on function private.can_read_identity_document_image(p_path text) to authenticated;
revoke all on function private.can_read_vehicle_image(p_path text) from public, anon, authenticated;
grant execute on function private.can_read_vehicle_image(p_path text) to authenticated;
revoke all on function private.can_upload_identity_document_image(p_path text) from public, anon, authenticated;
grant execute on function private.can_upload_identity_document_image(p_path text) to authenticated;
revoke all on function private.can_upload_vehicle_image(p_path text) from public, anon, authenticated;
grant execute on function private.can_upload_vehicle_image(p_path text) to authenticated;
revoke all on function private.can_user_login() from public, anon, authenticated;
grant execute on function private.can_user_login() to authenticated;
revoke all on function private.current_role() from public, anon, authenticated;
grant execute on function private.current_role() to authenticated;
revoke all on function private.immutable_history() from public, anon, authenticated;
revoke all on function private.is_active() from public, anon, authenticated;
grant execute on function private.is_active() to authenticated;
revoke all on function private.is_user_authorized(p_user_id uuid) from public, anon, authenticated;
revoke all on function private.knowledge_visible(p_audience text) from public, anon, authenticated;
grant execute on function private.knowledge_visible(p_audience text) to authenticated;
revoke all on function private.money_input(p_data jsonb, p_key text, p_default bigint) from public, anon, authenticated;
revoke all on function private.new_auth_user() from public, anon, authenticated;
revoke all on function private.normalize_customer_phone(p_phone text) from public, anon, authenticated;
revoke all on function private.protect_last_usable_owner() from public, anon, authenticated;
revoke all on function private.require_role(p_roles user_role[]) from public, anon, authenticated;
revoke all on function private.safe_money(p_value numeric) from public, anon, authenticated;
revoke all on function private.sale_json(p_sale sales) from public, anon, authenticated;
revoke all on function private.schedule_allows_time(p_from time without time zone, p_until time without time zone, p_time time without time zone) from public, anon, authenticated;
revoke all on function private.today() from public, anon, authenticated;
revoke all on function private.track_required_password_change() from public, anon, authenticated;
revoke all on function private.vehicle_json(p_vehicle vehicles) from public, anon, authenticated;
revoke all on function public.acquire_vehicle(p_data jsonb) from public, anon, authenticated;
grant execute on function public.acquire_vehicle(p_data jsonb) to authenticated;
grant execute on function public.acquire_vehicle(p_data jsonb) to service_role;
revoke all on function public.add_payment(p_data jsonb) from public, anon, authenticated;
grant execute on function public.add_payment(p_data jsonb) to authenticated;
grant execute on function public.add_payment(p_data jsonb) to service_role;
revoke all on function public.cancel_acquisition(p_id uuid, p_reason text) from public, anon, authenticated;
grant execute on function public.cancel_acquisition(p_id uuid, p_reason text) to authenticated;
grant execute on function public.cancel_acquisition(p_id uuid, p_reason text) to service_role;
revoke all on function public.cancel_expense(p_kind text, p_id uuid, p_reason text) from public, anon, authenticated;
grant execute on function public.cancel_expense(p_kind text, p_id uuid, p_reason text) to authenticated;
grant execute on function public.cancel_expense(p_kind text, p_id uuid, p_reason text) to service_role;
revoke all on function public.cancel_sale(p_id uuid, p_reason text) from public, anon, authenticated;
grant execute on function public.cancel_sale(p_id uuid, p_reason text) to authenticated;
grant execute on function public.cancel_sale(p_id uuid, p_reason text) to service_role;
revoke all on function public.check_user_access() from public, anon, authenticated;
grant execute on function public.check_user_access() to authenticated;
grant execute on function public.check_user_access() to service_role;
revoke all on function public.check_user_can_hard_delete(p_user_id uuid) from public, anon, authenticated;
grant execute on function public.check_user_can_hard_delete(p_user_id uuid) to authenticated;
grant execute on function public.check_user_can_hard_delete(p_user_id uuid) to service_role;
revoke all on function public.claim_message(p_message_id uuid) from public, anon, authenticated;
grant execute on function public.claim_message(p_message_id uuid) to authenticated;
grant execute on function public.claim_message(p_message_id uuid) to service_role;
revoke all on function public.complete_password_change() from public, anon, authenticated;
grant execute on function public.complete_password_change() to authenticated;
grant execute on function public.complete_password_change() to service_role;
revoke all on function public.daily_reconciliation(p_date date) from public, anon, authenticated;
grant execute on function public.daily_reconciliation(p_date date) to authenticated;
grant execute on function public.daily_reconciliation(p_date date) to service_role;
revoke all on function public.dashboard(p_from date, p_to date) from public, anon, authenticated;
grant execute on function public.dashboard(p_from date, p_to date) to authenticated;
grant execute on function public.dashboard(p_from date, p_to date) to service_role;
revoke all on function public.delete_announcement(p_id uuid) from public, anon, authenticated;
grant execute on function public.delete_announcement(p_id uuid) to authenticated;
grant execute on function public.delete_announcement(p_id uuid) to service_role;
revoke all on function public.fail_message(p_message_id uuid, p_error_code text, p_safe_message text, p_permanent boolean) from public, anon, authenticated;
grant execute on function public.fail_message(p_message_id uuid, p_error_code text, p_safe_message text, p_permanent boolean) to authenticated;
grant execute on function public.fail_message(p_message_id uuid, p_error_code text, p_safe_message text, p_permanent boolean) to service_role;
revoke all on function public.finish_mock_message(p_message_id uuid, p_provider_message_id text) from public, anon, authenticated;
grant execute on function public.finish_mock_message(p_message_id uuid, p_provider_message_id text) to authenticated;
grant execute on function public.finish_mock_message(p_message_id uuid, p_provider_message_id text) to service_role;
revoke all on function public.get_acquisition_for_vehicle(p_vehicle_id uuid) from public, anon, authenticated;
grant execute on function public.get_acquisition_for_vehicle(p_vehicle_id uuid) to authenticated;
grant execute on function public.get_acquisition_for_vehicle(p_vehicle_id uuid) to service_role;
revoke all on function public.get_customer_history(p_phone text) from public, anon, authenticated;
grant execute on function public.get_customer_history(p_phone text) to authenticated;
grant execute on function public.get_customer_history(p_phone text) to service_role;
revoke all on function public.get_identity_document(p_subject_type text, p_subject_id uuid) from public, anon, authenticated;
grant execute on function public.get_identity_document(p_subject_type text, p_subject_id uuid) to authenticated;
grant execute on function public.get_identity_document(p_subject_type text, p_subject_id uuid) to service_role;
revoke all on function public.get_knowledge_article(p_slug text) from public, anon, authenticated;
grant execute on function public.get_knowledge_article(p_slug text) to authenticated;
grant execute on function public.get_knowledge_article(p_slug text) to service_role;
revoke all on function public.get_sale_communication(p_sale_id uuid) from public, anon, authenticated;
grant execute on function public.get_sale_communication(p_sale_id uuid) to authenticated;
grant execute on function public.get_sale_communication(p_sale_id uuid) to service_role;
revoke all on function public.get_sale(p_id uuid) from public, anon, authenticated;
grant execute on function public.get_sale(p_id uuid) to authenticated;
grant execute on function public.get_sale(p_id uuid) to service_role;
revoke all on function public.get_settings() from public, anon, authenticated;
grant execute on function public.get_settings() to authenticated;
grant execute on function public.get_settings() to service_role;
revoke all on function public.get_vehicle(p_id uuid) from public, anon, authenticated;
grant execute on function public.get_vehicle(p_id uuid) to authenticated;
grant execute on function public.get_vehicle(p_id uuid) to service_role;
revoke all on function public.global_search(p_query text, p_limit integer) from public, anon, authenticated;
grant execute on function public.global_search(p_query text, p_limit integer) to authenticated;
grant execute on function public.global_search(p_query text, p_limit integer) to service_role;
revoke all on function public.import_vehicles(p_vehicles jsonb) from public, anon, authenticated;
grant execute on function public.import_vehicles(p_vehicles jsonb) to authenticated;
grant execute on function public.import_vehicles(p_vehicles jsonb) to service_role;
revoke all on function public.list_acquisitions(p_filters jsonb) from public, anon, authenticated;
grant execute on function public.list_acquisitions(p_filters jsonb) to authenticated;
grant execute on function public.list_acquisitions(p_filters jsonb) to service_role;
revoke all on function public.list_active_announcements() from public, anon, authenticated;
grant execute on function public.list_active_announcements() to authenticated;
grant execute on function public.list_active_announcements() to service_role;
revoke all on function public.list_announcements() from public, anon, authenticated;
grant execute on function public.list_announcements() to authenticated;
grant execute on function public.list_announcements() to service_role;
revoke all on function public.list_audit(p_filters jsonb) from public, anon, authenticated;
grant execute on function public.list_audit(p_filters jsonb) to authenticated;
grant execute on function public.list_audit(p_filters jsonb) to service_role;
revoke all on function public.list_customer_communications(p_phone text) from public, anon, authenticated;
grant execute on function public.list_customer_communications(p_phone text) to authenticated;
grant execute on function public.list_customer_communications(p_phone text) to service_role;
revoke all on function public.list_customers(p_filters jsonb) from public, anon, authenticated;
grant execute on function public.list_customers(p_filters jsonb) to authenticated;
grant execute on function public.list_customers(p_filters jsonb) to service_role;
revoke all on function public.list_expenses(p_filters jsonb) from public, anon, authenticated;
grant execute on function public.list_expenses(p_filters jsonb) to authenticated;
grant execute on function public.list_expenses(p_filters jsonb) to service_role;
revoke all on function public.list_knowledge() from public, anon, authenticated;
grant execute on function public.list_knowledge() to authenticated;
grant execute on function public.list_knowledge() to service_role;
revoke all on function public.list_profiles() from public, anon, authenticated;
grant execute on function public.list_profiles() to authenticated;
grant execute on function public.list_profiles() to service_role;
revoke all on function public.list_receivables(p_filters jsonb) from public, anon, authenticated;
grant execute on function public.list_receivables(p_filters jsonb) to authenticated;
grant execute on function public.list_receivables(p_filters jsonb) to service_role;
revoke all on function public.list_sales(p_filters jsonb) from public, anon, authenticated;
grant execute on function public.list_sales(p_filters jsonb) to authenticated;
grant execute on function public.list_sales(p_filters jsonb) to service_role;
revoke all on function public.list_vehicles(p_filters jsonb) from public, anon, authenticated;
grant execute on function public.list_vehicles(p_filters jsonb) to authenticated;
grant execute on function public.list_vehicles(p_filters jsonb) to service_role;
revoke all on function public.register_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text, p_storage_path text) from public, anon, authenticated;
grant execute on function public.register_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text, p_storage_path text) to authenticated;
grant execute on function public.register_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text, p_storage_path text) to service_role;
revoke all on function public.register_vehicle_image(p_vehicle_id uuid, p_storage_path text, p_display_order integer) from public, anon, authenticated;
grant execute on function public.register_vehicle_image(p_vehicle_id uuid, p_storage_path text, p_display_order integer) to authenticated;
grant execute on function public.register_vehicle_image(p_vehicle_id uuid, p_storage_path text, p_display_order integer) to service_role;
revoke all on function public.remove_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text) from public, anon, authenticated;
grant execute on function public.remove_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text) to authenticated;
grant execute on function public.remove_identity_document_image(p_subject_type text, p_subject_id uuid, p_side text) to service_role;
revoke all on function public.remove_vehicle_image(p_id uuid) from public, anon, authenticated;
grant execute on function public.remove_vehicle_image(p_id uuid) to authenticated;
grant execute on function public.remove_vehicle_image(p_id uuid) to service_role;
revoke all on function public.report(p_kind text, p_filters jsonb) from public, anon, authenticated;
grant execute on function public.report(p_kind text, p_filters jsonb) to authenticated;
grant execute on function public.report(p_kind text, p_filters jsonb) to service_role;
revoke all on function public.require_password_change(p_user_id uuid, p_reset_pending boolean) from public, anon, authenticated;
grant execute on function public.require_password_change(p_user_id uuid, p_reset_pending boolean) to authenticated;
grant execute on function public.require_password_change(p_user_id uuid, p_reset_pending boolean) to service_role;
revoke all on function public.resolve_login_email(p_identifier text) from public, anon, authenticated;
grant execute on function public.resolve_login_email(p_identifier text) to authenticated;
grant execute on function public.resolve_login_email(p_identifier text) to anon;
grant execute on function public.resolve_login_email(p_identifier text) to service_role;
revoke all on function public.retry_sale_thank_you(p_sale_id uuid) from public, anon, authenticated;
grant execute on function public.retry_sale_thank_you(p_sale_id uuid) to authenticated;
grant execute on function public.retry_sale_thank_you(p_sale_id uuid) to service_role;
revoke all on function public.save_announcement(p_data jsonb) from public, anon, authenticated;
grant execute on function public.save_announcement(p_data jsonb) to authenticated;
grant execute on function public.save_announcement(p_data jsonb) to service_role;
revoke all on function public.save_expense(p_kind text, p_data jsonb, p_id uuid) from public, anon, authenticated;
grant execute on function public.save_expense(p_kind text, p_data jsonb, p_id uuid) to authenticated;
grant execute on function public.save_expense(p_kind text, p_data jsonb, p_id uuid) to service_role;
revoke all on function public.save_identity_document(p_data jsonb) from public, anon, authenticated;
grant execute on function public.save_identity_document(p_data jsonb) to authenticated;
grant execute on function public.save_identity_document(p_data jsonb) to service_role;
revoke all on function public.save_settings(p_data jsonb) from public, anon, authenticated;
grant execute on function public.save_settings(p_data jsonb) to authenticated;
grant execute on function public.save_settings(p_data jsonb) to service_role;
revoke all on function public.save_vehicle(p_data jsonb, p_id uuid) from public, anon, authenticated;
grant execute on function public.save_vehicle(p_data jsonb, p_id uuid) to authenticated;
grant execute on function public.save_vehicle(p_data jsonb, p_id uuid) to service_role;
revoke all on function public.search_knowledge(p_query text, p_limit integer) from public, anon, authenticated;
grant execute on function public.search_knowledge(p_query text, p_limit integer) to authenticated;
grant execute on function public.search_knowledge(p_query text, p_limit integer) to service_role;
revoke all on function public.sell_vehicle(p_data jsonb) from public, anon, authenticated;
grant execute on function public.sell_vehicle(p_data jsonb) to authenticated;
grant execute on function public.sell_vehicle(p_data jsonb) to service_role;
revoke all on function public.set_announcement_active(p_id uuid, p_active boolean) from public, anon, authenticated;
grant execute on function public.set_announcement_active(p_id uuid, p_active boolean) to authenticated;
grant execute on function public.set_announcement_active(p_id uuid, p_active boolean) to service_role;
revoke all on function public.skip_message(p_message_id uuid, p_error_code text, p_safe_message text) from public, anon, authenticated;
grant execute on function public.skip_message(p_message_id uuid, p_error_code text, p_safe_message text) to authenticated;
grant execute on function public.skip_message(p_message_id uuid, p_error_code text, p_safe_message text) to service_role;
revoke all on function public.update_profile(p_id uuid, p_data jsonb) from public, anon, authenticated;
grant execute on function public.update_profile(p_id uuid, p_data jsonb) to authenticated;
grant execute on function public.update_profile(p_id uuid, p_data jsonb) to service_role;
revoke all on function public.update_sale_due_date(p_sale_id uuid, p_due_date date) from public, anon, authenticated;
grant execute on function public.update_sale_due_date(p_sale_id uuid, p_due_date date) to authenticated;
grant execute on function public.update_sale_due_date(p_sale_id uuid, p_due_date date) to service_role;
revoke all on function public.validate_import_vehicles(p_vehicles jsonb) from public, anon, authenticated;
grant execute on function public.validate_import_vehicles(p_vehicles jsonb) to authenticated;
grant execute on function public.validate_import_vehicles(p_vehicles jsonb) to service_role;
revoke all on private.sale_code_seq from public, anon, authenticated;
revoke all on private.vehicle_code_seq from public, anon, authenticated;
revoke all on public.audit_logs_id_seq from public, anon, authenticated;
revoke all on public.vehicle_activity_id_seq from public, anon, authenticated;
revoke all on private.required_password_changes from public, anon, authenticated;
alter table private.required_password_changes disable row level security;
alter table private.required_password_changes no force row level security;
revoke all on public.acquisitions from public, anon, authenticated;
grant select on public.acquisitions to authenticated;
alter table public.acquisitions enable row level security;
alter table public.acquisitions no force row level security;
revoke all on public.audit_logs from public, anon, authenticated;
grant select on public.audit_logs to authenticated;
alter table public.audit_logs enable row level security;
alter table public.audit_logs no force row level security;
revoke all on public.business_expenses from public, anon, authenticated;
grant select on public.business_expenses to authenticated;
alter table public.business_expenses enable row level security;
alter table public.business_expenses no force row level security;
revoke all on public.customer_communications from public, anon, authenticated;
alter table public.customer_communications enable row level security;
alter table public.customer_communications no force row level security;
revoke all on public.identity_documents from public, anon, authenticated;
grant select on public.identity_documents to authenticated;
alter table public.identity_documents enable row level security;
alter table public.identity_documents no force row level security;
revoke all on public.knowledge_base from public, anon, authenticated;
grant select on public.knowledge_base to authenticated;
alter table public.knowledge_base enable row level security;
alter table public.knowledge_base no force row level security;
revoke all on public.message_outbox from public, anon, authenticated;
alter table public.message_outbox enable row level security;
alter table public.message_outbox no force row level security;
revoke all on public.payments from public, anon, authenticated;
grant select on public.payments to authenticated;
alter table public.payments enable row level security;
alter table public.payments no force row level security;
revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
alter table public.profiles enable row level security;
alter table public.profiles no force row level security;
revoke all on public.sale_financials from public, anon, authenticated;
grant select on public.sale_financials to authenticated;
alter table public.sale_financials enable row level security;
alter table public.sale_financials no force row level security;
revoke all on public.sales from public, anon, authenticated;
grant select on public.sales to authenticated;
alter table public.sales enable row level security;
alter table public.sales no force row level security;
revoke all on public.system_announcements from public, anon, authenticated;
alter table public.system_announcements enable row level security;
alter table public.system_announcements no force row level security;
revoke all on public.system_settings from public, anon, authenticated;
grant select on public.system_settings to authenticated;
alter table public.system_settings enable row level security;
alter table public.system_settings no force row level security;
revoke all on public.vehicle_activity from public, anon, authenticated;
grant select on public.vehicle_activity to authenticated;
alter table public.vehicle_activity enable row level security;
alter table public.vehicle_activity no force row level security;
revoke all on public.vehicle_expenses from public, anon, authenticated;
grant select on public.vehicle_expenses to authenticated;
alter table public.vehicle_expenses enable row level security;
alter table public.vehicle_expenses no force row level security;
revoke all on public.vehicle_financials from public, anon, authenticated;
grant select on public.vehicle_financials to authenticated;
alter table public.vehicle_financials enable row level security;
alter table public.vehicle_financials no force row level security;
revoke all on public.vehicle_images from public, anon, authenticated;
grant select on public.vehicle_images to authenticated;
alter table public.vehicle_images enable row level security;
alter table public.vehicle_images no force row level security;
revoke all on public.vehicles from public, anon, authenticated;
grant select on public.vehicles to authenticated;
alter table public.vehicles enable row level security;
alter table public.vehicles no force row level security;
revoke all on public.user_performance_summary from public, anon, authenticated;
grant select on public.user_performance_summary to authenticated;

-- ---------------------------------------------------------------------
-- drifted column defaults: local final state
-- The 001 baseline was rewritten AFTER production had already applied it (VIEWER role
-- removal plus active/schedule-gating and financial-visibility hardening). That rewrite
-- also changed two profiles defaults: role 'OWNER' -> 'STAFF' and active false -> true.
-- Replaying 026-031 on the live production schema (scripts/verify-prod-replay.mjs) proved
-- these two defaults are the ONLY residual structural drift once 031's function/grant/RLS
-- reconciliation is applied (0 code-drift functions, policies/constraints/indexes/grants
-- all converge). Align them so `db push` leaves production equal to the validated local
-- schema. Forward-only: no rows are modified, only omitted-column defaults for future inserts.
-- ---------------------------------------------------------------------
alter table public.profiles alter column role set default 'STAFF';
alter table public.profiles alter column active set default true;
