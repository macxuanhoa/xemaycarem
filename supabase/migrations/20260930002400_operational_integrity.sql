-- Repair the existing operational RPCs without changing debt or accounting storage.
-- All balances continue to come from completed sales and ACTIVE payments.

CREATE OR REPLACE FUNCTION private.normalize_customer_phone(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_phone, '')) ~ '^\+84' AND length(regexp_replace(p_phone, '[^0-9]', '', 'g')) = 11
      THEN '0' || substr(regexp_replace(p_phone, '[^0-9]', '', 'g'), 3)
    ELSE regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
  END
$$;

-- History and phone search use exactly this expression for existing, unmodified data.
CREATE INDEX IF NOT EXISTS sales_customer_phone_normalized
  ON public.sales (private.normalize_customer_phone(customer_phone));

-- Actionable inventory alerts reuse normal filters and restricted financial sort guards.
create or replace function public.list_vehicles(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
end $$;

CREATE OR REPLACE FUNCTION public.list_receivables(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
END $$;

CREATE OR REPLACE FUNCTION public.list_customers(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
END $$;

CREATE OR REPLACE FUNCTION public.get_customer_history(p_phone text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
END $$;

CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
END $$;

-- Keep dashboard behavior while applying the existing safe-integer aggregate guard to debt alerts.
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
END $$;

CREATE OR REPLACE FUNCTION public.get_sale(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
END $$;

-- Optional request_id reuses the existing stable payment UUID as its retry key.
-- Existing callers continue working; callers using retries must keep the same key and payload.
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

CREATE OR REPLACE FUNCTION public.daily_reconciliation(p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_day date := coalesce(p_date, private.today());
  v_summary jsonb;
  v_collected jsonb;
  v_payments jsonb;
  v_sales jsonb;
  v_expenses jsonb;
  v_business bigint;
  v_vehicle bigint;
BEGIN
  IF v_day > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE'; END IF;
  SELECT jsonb_build_object('sales_count', count(*), 'sales_revenue', private.safe_money(coalesce(sum(sale_price), 0)))
  INTO v_summary FROM public.sales WHERE status = 'COMPLETED' AND sale_date = v_day;
  SELECT jsonb_build_object(
    'today_sales_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE s.sale_date = v_day), 0)),
    'debt_collected_today', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE s.sale_date < v_day), 0)),
    'total_collected', private.safe_money(coalesce(sum(p.amount), 0)),
    'cash_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'CASH'), 0)),
    'bank_transfer_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'BANK_TRANSFER'), 0)),
    'other_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'OTHER'), 0))
  ) INTO v_collected FROM public.payments p JOIN public.sales s ON s.id = p.sale_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED';
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_business FROM public.business_expenses WHERE status = 'ACTIVE' AND expense_date = v_day;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_vehicle FROM public.vehicle_expenses WHERE status = 'ACTIVE' AND expense_date = v_day;
  SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('sale_code', s.sale_code,
    'customer_name', s.customer_name, 'customer_phone', s.customer_phone, 'sale_date', s.sale_date,
    'vehicle_name', v.brand || ' ' || v.model, 'internal_code', v.internal_code,
    'license_plate', v.license_plate, 'is_prior_debt', s.sale_date < v_day) ORDER BY p.created_at DESC, p.id), '[]'::jsonb)
  INTO v_payments FROM public.payments p JOIN public.sales s ON s.id = p.sale_id
  JOIN public.vehicles v ON v.id = s.vehicle_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED';
  -- Day details deliberately override lifetime balances with amounts as of this day.
  SELECT coalesce(jsonb_agg(private.sale_json(s) || jsonb_build_object(
    'paid_amount', coalesce(p.paid_today, 0), 'paid_today', coalesce(p.paid_today, 0),
    'remaining_amount', greatest(0, s.sale_price - coalesce(p.paid_to_day, 0))) ORDER BY s.created_at DESC, s.id), '[]'::jsonb)
  INTO v_sales FROM public.sales s
  LEFT JOIN LATERAL (SELECT private.safe_money(sum(amount) FILTER (WHERE payment_date = v_day)) AS paid_today,
    private.safe_money(sum(amount) FILTER (WHERE payment_date <= v_day)) AS paid_to_day
    FROM public.payments WHERE sale_id = s.id AND status = 'ACTIVE') p ON true
  WHERE s.status = 'COMPLETED' AND s.sale_date = v_day;
  SELECT coalesce(jsonb_agg(data ORDER BY expense_date, created_at, id), '[]'::jsonb) INTO v_expenses
  FROM (SELECT e.id, e.expense_date, e.created_at, to_jsonb(e) || jsonb_build_object('kind', 'vehicle',
    'vehicle_name', v.brand || ' ' || v.model, 'internal_code', v.internal_code) AS data
    FROM public.vehicle_expenses e JOIN public.vehicles v ON v.id = e.vehicle_id WHERE e.status = 'ACTIVE' AND e.expense_date = v_day
    UNION ALL SELECT e.id, e.expense_date, e.created_at, to_jsonb(e) || jsonb_build_object('kind', 'business')
    FROM public.business_expenses e WHERE e.status = 'ACTIVE' AND e.expense_date = v_day) expenses;
  RETURN v_summary || v_collected || jsonb_build_object('date', v_day,
    'new_debt_created', private.safe_money((v_summary->>'sales_revenue')::numeric - (v_collected->>'today_sales_collected')::numeric),
    'business_expenses', v_business, 'vehicle_expenses', v_vehicle,
    'total_expenses', private.safe_money(v_business::numeric + v_vehicle),
    'net_cash_movement', private.safe_money((v_collected->>'total_collected')::numeric - v_business - v_vehicle),
    'payments', v_payments, 'sales', v_sales, 'expenses', v_expenses);
END $$;

-- Preserve the normal acquisition flow, enforcing the same purchase-price permission as save_vehicle.
CREATE OR REPLACE FUNCTION public.acquire_vehicle(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_frame text := btrim(p_data->>'frame_number');
  v_vehicle_id uuid;
  v_vehicle public.vehicles;
  v_acquisition public.acquisitions;
  v_purchase bigint := private.money_input(p_data, 'purchase_price');
  v_date date := coalesce((p_data->>'acquisition_date')::date, private.today());
  v_fin boolean := private.can_financials();
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  IF p_data ? 'purchase_price' AND NOT v_fin THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
  END IF;

  -- Validate frame_number is provided
  IF v_frame IS NULL OR v_frame = '' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FRAME_NUMBER_REQUIRED';
  END IF;

  -- Validate acquisition date
  IF v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
  END IF;

  -- Purchase price is required for financial users, optional otherwise
  IF v_fin AND v_purchase IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_PRICE_REQUIRED';
  END IF;

  -- Check if vehicle with this frame_number already exists
  SELECT id INTO v_vehicle_id FROM public.vehicles WHERE frame_number = v_frame;

  IF v_vehicle_id IS NOT NULL THEN
    -- Vehicle exists - check if it can be re-acquired
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
    IF v_vehicle.status NOT IN ('CANCELLED') THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_FRAME_NUMBER';
    END IF;
  END IF;

  -- Create the vehicle
  INSERT INTO public.vehicles (
    frame_number, engine_number, license_plate,
    brand, model, variant, year, color, odometer,
    purchase_date, asking_price, status,
    supplier_name, supplier_phone, notes, created_by
  ) VALUES (
    v_frame,
    btrim(coalesce(p_data->>'engine_number', '')),
    btrim(coalesce(p_data->>'license_plate', '')),
    btrim(p_data->>'brand'),
    btrim(p_data->>'model'),
    btrim(coalesce(p_data->>'variant', '')),
    nullif(p_data->>'year', '')::integer,
    btrim(coalesce(p_data->>'color', '')),
    coalesce(nullif(p_data->>'odometer', '')::integer, 0),
    v_date,
    private.money_input(p_data, 'asking_price', 0),
    'IN_STOCK'::public.vehicle_status,
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'notes', ''),
    v_actor
  ) RETURNING * INTO v_vehicle;

  -- Create the vehicle_financials record (backward compat)
  INSERT INTO public.vehicle_financials (vehicle_id, purchase_price, updated_by)
  VALUES (v_vehicle.id, v_purchase, v_actor);

  -- Create the acquisition record
  INSERT INTO public.acquisitions (
    vehicle_id, acquisition_date, purchase_price,
    seller_name, seller_phone, notes, status, created_by
  ) VALUES (
    v_vehicle.id,
    v_date,
    coalesce(v_purchase, 0),
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'acquisition_notes', ''),
    'COMPLETED'::public.acquisition_status,
    v_actor
  ) RETURNING * INTO v_acquisition;

  -- Audit
  PERFORM private.audit(
    'CREATE_ACQUISITION', 'acquisitions', v_acquisition.id,
    null,
    to_jsonb(v_acquisition) || jsonb_build_object('vehicle', to_jsonb(v_vehicle)),
    v_vehicle.id
  );

  PERFORM private.audit(
    'CREATE_VEHICLE', 'vehicles', v_vehicle.id,
    null,
    to_jsonb(v_vehicle) || jsonb_build_object('purchase_price', v_purchase),
    v_vehicle.id
  );

  RETURN v_vehicle.id;
END $$;

-- All import rows are checked again on the server immediately before one atomic batch.
CREATE OR REPLACE FUNCTION public.validate_import_vehicles(p_vehicles jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_row jsonb;
  v_index integer;
  v_field text;
  v_value text;
  v_seen_frames text[] := ARRAY[]::text[];
  v_seen_engines text[] := ARRAY[]::text[];
  v_seen_plates text[] := ARRAY[]::text[];
  v_duplicates jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_date date;
  v_number integer;
BEGIN
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;
  IF jsonb_array_length(p_vehicles) > 500 THEN RAISE EXCEPTION USING errcode = '22023', message = 'IMPORT_BATCH_TOO_LARGE'; END IF;
  FOR v_row, v_index IN SELECT value, (ordinality - 1)::integer FROM jsonb_array_elements(p_vehicles) WITH ORDINALITY LOOP
    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', '', 'message', 'INVALID_INPUT');
      CONTINUE;
    END IF;
    FOREACH v_field IN ARRAY ARRAY['frame_number','engine_number','license_plate'] LOOP
      v_value := upper(btrim(coalesce(v_row->>v_field, '')));
      IF (v_field = 'frame_number' AND v_value = '') OR length(v_value) > (CASE WHEN v_field = 'license_plate' THEN 30 ELSE 100 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
      -- Compare plate identity independently of display punctuation; keep the
      -- imported spelling and chassis/engine semantics unchanged.
      IF v_field = 'license_plate' THEN
        v_value := regexp_replace(v_value, '[^A-Z0-9]', '', 'g');
      END IF;
      IF v_value <> '' THEN
        IF (v_field = 'frame_number' AND (v_value = ANY(v_seen_frames) OR EXISTS (SELECT 1 FROM public.vehicles WHERE upper(btrim(frame_number)) = v_value)))
          OR (v_field = 'engine_number' AND (v_value = ANY(v_seen_engines) OR EXISTS (SELECT 1 FROM public.vehicles WHERE upper(btrim(engine_number)) = v_value)))
          OR (v_field = 'license_plate' AND (v_value = ANY(v_seen_plates) OR EXISTS (SELECT 1 FROM public.vehicles WHERE regexp_replace(upper(license_plate), '[^A-Z0-9]', '', 'g') = v_value))) THEN
          v_duplicates := v_duplicates || jsonb_build_object('index', v_index, 'field', v_field, 'value', v_value, 'message',
            CASE v_field WHEN 'frame_number' THEN 'Số khung đã tồn tại hoặc trùng trong file' WHEN 'engine_number' THEN 'Số máy đã tồn tại hoặc trùng trong file' ELSE 'Biển số đã tồn tại hoặc trùng trong file' END);
        END IF;
        IF v_field = 'frame_number' THEN v_seen_frames := array_append(v_seen_frames, v_value);
        ELSIF v_field = 'engine_number' THEN v_seen_engines := array_append(v_seen_engines, v_value);
        ELSE v_seen_plates := array_append(v_seen_plates, v_value); END IF;
      END IF;
    END LOOP;
    IF length(btrim(coalesce(v_row->>'brand', ''))) NOT BETWEEN 1 AND 80 THEN v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'brand', 'message', 'INVALID_BRAND'); END IF;
    IF length(btrim(coalesce(v_row->>'model', ''))) NOT BETWEEN 1 AND 120 THEN v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'model', 'message', 'INVALID_MODEL'); END IF;
    FOREACH v_field IN ARRAY ARRAY['variant','color','supplier_name','supplier_phone','notes'] LOOP
      IF length(coalesce(v_row->>v_field, '')) > (CASE v_field
        WHEN 'variant' THEN 120 WHEN 'color' THEN 80 WHEN 'supplier_name' THEN 200
        WHEN 'supplier_phone' THEN 40 ELSE 10000 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
    END LOOP;
    FOREACH v_field IN ARRAY ARRAY['purchase_price','asking_price'] LOOP
      BEGIN
        PERFORM private.money_input(v_row, v_field, 0);
        IF v_field = 'purchase_price' AND NOT private.can_financials() AND v_row ? 'purchase_price' THEN
          RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
        END IF;
        IF v_field = 'purchase_price' AND private.can_financials() AND v_row->>v_field IS NULL THEN
          RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_PRICE_REQUIRED';
        END IF;
      EXCEPTION WHEN invalid_parameter_value OR insufficient_privilege THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', SQLERRM);
      END;
    END LOOP;
    BEGIN
      IF nullif(v_row->>'purchase_date', '') IS NOT NULL AND v_row->>'purchase_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PURCHASE_DATE';
      END IF;
      v_date := coalesce(nullif(v_row->>'purchase_date', '')::date, private.today());
      IF v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_DATE_IN_FUTURE'; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'purchase_date', 'message', 'INVALID_PURCHASE_DATE');
    END;
    FOREACH v_field IN ARRAY ARRAY['year','odometer'] LOOP
      BEGIN
        v_value := nullif(v_row->>v_field, '');
        IF v_value IS NOT NULL THEN
          IF v_value !~ '^[0-9]+$' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER'; END IF;
          v_number := v_value::integer;
          IF (v_field = 'year' AND v_number NOT BETWEEN 1900 AND 2100) OR (v_field = 'odometer' AND v_number NOT BETWEEN 0 AND 10000000) THEN
            RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER';
          END IF;
        END IF;
      EXCEPTION WHEN invalid_parameter_value OR numeric_value_out_of_range OR invalid_text_representation THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END;
    END LOOP;
    IF v_row ? 'status' AND v_row->>'status' IS DISTINCT FROM 'IN_STOCK' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'status', 'message', 'INVALID_VEHICLE_STATUS');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('duplicates', v_duplicates, 'errors', v_errors);
END $$;

CREATE OR REPLACE FUNCTION public.import_vehicles(p_vehicles jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_validation jsonb;
  v_row jsonb;
  v_data jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;
  IF jsonb_array_length(p_vehicles) = 0 THEN RAISE EXCEPTION USING errcode = '22023', message = 'NO_DATA_TO_IMPORT'; END IF;
  IF jsonb_array_length(p_vehicles) > 500 THEN RAISE EXCEPTION USING errcode = '22023', message = 'IMPORT_BATCH_TOO_LARGE'; END IF;
  -- Engine/plate are not globally unique in the historical schema. Serialize this
  -- bounded initial import with ordinary inventory writes to close the preview race.
  LOCK TABLE public.vehicles IN SHARE ROW EXCLUSIVE MODE;
  v_validation := public.validate_import_vehicles(p_vehicles);
  IF jsonb_array_length(v_validation->'duplicates') > 0 THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_IMPORT_VEHICLE';
  END IF;
  IF jsonb_array_length(v_validation->'errors') > 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_IMPORT_DATA', detail = (v_validation->'errors')::text;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_vehicles) LOOP
    v_data := v_row || jsonb_build_object('acquisition_date', coalesce(nullif(v_row->>'purchase_date', ''), private.today()::text),
      'seller_name', coalesce(v_row->>'supplier_name', ''), 'seller_phone', coalesce(v_row->>'supplier_phone', ''),
      'acquisition_notes', coalesce(v_row->>'notes', ''));
    v_ids := array_append(v_ids, public.acquire_vehicle(v_data));
  END LOOP;
  RETURN jsonb_build_object('imported_count', cardinality(v_ids), 'vehicle_ids', to_jsonb(v_ids));
END $$;

REVOKE ALL ON FUNCTION private.normalize_customer_phone(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_receivables(jsonb), public.list_customers(jsonb),
  public.get_customer_history(text), public.global_search(text, integer), public.get_sale(uuid),
  public.add_payment(jsonb), public.daily_reconciliation(date), public.validate_import_vehicles(jsonb),
  public.import_vehicles(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_receivables(jsonb), public.list_customers(jsonb),
  public.get_customer_history(text), public.global_search(text, integer), public.get_sale(uuid),
  public.add_payment(jsonb), public.daily_reconciliation(date), public.validate_import_vehicles(jsonb),
  public.import_vehicles(jsonb) TO authenticated;
