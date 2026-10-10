-- Financial provenance privacy (OWNER-private purchase/sale prices).
-- Forward-only, transactional. Implements the OWNER-approved policy:
--   * purchase/sale price entered or last edited by OWNER -> OWNER-private (PRIVATE)
--   * price entered by active STAFF/MANAGER               -> business-visible (PUBLIC)
--   * price with undeterminable provenance (legacy)       -> RESTRICTED
-- PRIVATE/RESTRICTED values are only disclosed to roles with the corresponding
-- financial right (private.can_financials(): OWNER, or MANAGER with
-- can_view_financials). Every projection, RPC aggregate and direct PostgREST read
-- is gated by the stamped provenance so a private price cannot be read or inferred.
-- Below-cost sale + OWNER approval flow is preserved, but the above/below-cost
-- comparison is only exposed when the actor may already see the cost (anti-oracle).

-- 1) Visibility classification domain -------------------------------------------------
CREATE TYPE public.money_visibility AS ENUM ('PUBLIC', 'PRIVATE', 'RESTRICTED');

-- 2) Provenance helpers ---------------------------------------------------------------
-- Classify a value from the identity of the member who wrote it (last-writer wins).
CREATE OR REPLACE FUNCTION private.price_visibility_for(p_actor uuid)
 RETURNS public.money_visibility
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
  SELECT CASE
    WHEN p_actor IS NULL THEN 'RESTRICTED'::public.money_visibility
    WHEN EXISTS (SELECT 1 FROM public.profiles pr
                 WHERE pr.id = p_actor AND pr.active AND pr.role = 'OWNER'::public.user_role)
      THEN 'PRIVATE'::public.money_visibility
    WHEN EXISTS (SELECT 1 FROM public.profiles pr
                 WHERE pr.id = p_actor AND pr.active AND pr.role IN ('MANAGER'::public.user_role,'STAFF'::public.user_role))
      THEN 'PUBLIC'::public.money_visibility
    ELSE 'RESTRICTED'::public.money_visibility
  END;
$fn$;

-- Whether the CURRENT caller may see a value of the given visibility.
CREATE OR REPLACE FUNCTION private.money_disclosable(p_vis public.money_visibility)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
  SELECT COALESCE(p_vis = 'PUBLIC'::public.money_visibility OR private.can_financials(), false);
$fn$;

REVOKE ALL ON FUNCTION private.price_visibility_for(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.money_disclosable(public.money_visibility) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.price_visibility_for(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.money_disclosable(public.money_visibility) TO authenticated;

-- 3) Provenance columns (default RESTRICTED => fail-closed for any un-backfilled row) --
ALTER TABLE public.vehicle_financials
  ADD COLUMN purchase_price_visibility public.money_visibility NOT NULL DEFAULT 'RESTRICTED'::public.money_visibility;
ALTER TABLE public.acquisitions
  ADD COLUMN purchase_price_visibility public.money_visibility NOT NULL DEFAULT 'RESTRICTED'::public.money_visibility;
ALTER TABLE public.sales
  ADD COLUMN sale_price_visibility public.money_visibility NOT NULL DEFAULT 'RESTRICTED'::public.money_visibility;

-- 4) Backfill from recorded provenance. Vehicles with no price stay RESTRICTED (harmless,
--    value is null anyway); every priced row is reclassified by its last writer.
UPDATE public.vehicle_financials vf
   SET purchase_price_visibility = private.price_visibility_for(vf.updated_by)
 WHERE vf.purchase_price IS NOT NULL;

UPDATE public.acquisitions a
   SET purchase_price_visibility = private.price_visibility_for(a.created_by);

UPDATE public.sales s
   SET sale_price_visibility = private.price_visibility_for(s.sold_by);

-- 5) PostgREST (direct table) read policies ------------------------------------------
-- The app reads money only through SECURITY DEFINER RPCs (which bypass RLS and are
-- gated by the projections below); these policies close the direct REST read path.
DROP POLICY IF EXISTS sales_read ON public.sales;
CREATE POLICY sales_read ON public.sales
  FOR SELECT USING (private.is_active() AND private.money_disclosable(sale_price_visibility));

DROP POLICY IF EXISTS payments_read ON public.payments;
CREATE POLICY payments_read ON public.payments
  FOR SELECT USING (
    private.is_active() AND EXISTS (
      SELECT 1 FROM public.sales s
      WHERE s.id = payments.sale_id AND private.money_disclosable(s.sale_price_visibility)));

-- Approval payloads/reasons embed the OWNER cost and shortfall -> OWNER-only now.
DROP POLICY IF EXISTS approvals_read ON public.approval_requests;
CREATE POLICY approvals_read ON public.approval_requests
  FOR SELECT USING (private.current_role() = 'OWNER'::public.user_role);

-- 6) Single-row read masks ------------------------------------------------------------
-- 6a) vehicle_json: purchase_price only when disclosable.
CREATE OR REPLACE FUNCTION private.vehicle_json(p_vehicle vehicles)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
declare v_purchase bigint; v_vis public.money_visibility; v_disclos boolean; v_expenses bigint; v_result jsonb; v_end date; v_approval uuid;
begin
  select purchase_price, purchase_price_visibility into v_purchase, v_vis from public.vehicle_financials where vehicle_id=p_vehicle.id;
  v_disclos := private.money_disclosable(v_vis);
  if p_vehicle.status='SOLD' then select sale_date into v_end from public.sales where vehicle_id=p_vehicle.id and status='COMPLETED'; end if;
  -- pending approval id is a boolean/id hint only, never a price.
  select ar.id into v_approval from public.approval_requests ar
    where ar.subject_id=p_vehicle.id and ar.kind='SALE_BELOW_COST' and ar.status='PENDING'
    limit 1;
  v_result:=to_jsonb(p_vehicle)||private.vehicle_display(p_vehicle)||jsonb_build_object(
    'cost_pending',v_purchase is null,
    'purchase_price',CASE WHEN v_disclos THEN v_purchase ELSE NULL END,
    'purchase_price_hidden',(v_purchase is not null AND NOT v_disclos),
    'pending_sale_approval',v_approval is not null,
    'sale_approval_id',v_approval,
    'days_in_inventory',greatest(0,coalesce(v_end,private.today())-p_vehicle.purchase_date));
  if private.can_financials() then
    select private.safe_money(coalesce(sum(amount),0)) into v_expenses from public.vehicle_expenses where vehicle_id=p_vehicle.id and status='ACTIVE';
    v_result:=v_result||jsonb_build_object('expense_total',v_expenses,'total_cost',private.safe_money(v_purchase::numeric+v_expenses));
  end if;
  return v_result;
end $fn$;

-- 6b) sale_json: sale_price + all price-derived fields only when disclosable.
CREATE OR REPLACE FUNCTION private.sale_json(p_sale sales)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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

  v_result := (to_jsonb(p_sale) - 'sale_price_visibility') || jsonb_build_object(
    'vehicle', to_jsonb(v_vehicle),
    'vehicle_code', v_vehicle.internal_code,
    'internal_code', v_vehicle.internal_code,
    'license_plate', v_vehicle.license_plate,
    'paid_amount', v_paid,
    'remaining_amount', v_remaining,
    'due_date', p_sale.due_date,
    'debt_status', v_debt_status,
    'is_overdue', v_is_overdue
  ) || private.vehicle_display(v_vehicle);

  -- Provenance gate: hide the price AND every value derived from it so it cannot be
  -- reconstructed. Row still appears (no enumeration oracle), only money-blind.
  IF NOT private.money_disclosable(p_sale.sale_price_visibility) THEN
    v_result := (v_result - 'paid_amount' - 'remaining_amount' - 'debt_status' - 'is_overdue')
      || jsonb_build_object('sale_price', NULL, 'sale_price_hidden', true);
  END IF;

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
END $fn$;

-- 6c) get_sale: withhold the payment ledger when the sale price is not disclosable.
CREATE OR REPLACE FUNCTION public.get_sale(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_sale public.sales;
  v_payments jsonb := '[]'::jsonb;
  v_employee text;
BEGIN
  SELECT * INTO v_sale FROM public.sales WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND'; END IF;
  SELECT full_name INTO v_employee FROM public.profiles WHERE id = v_sale.sold_by;
  IF private.money_disclosable(v_sale.sale_price_visibility) THEN
    SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('creator_name', profile.full_name)
      ORDER BY p.payment_date, p.created_at, p.id), '[]'::jsonb) INTO v_payments
    FROM public.payments p LEFT JOIN public.profiles profile ON profile.id = p.created_by WHERE sale_id = p_id;
  END IF;
  RETURN private.sale_json(v_sale) || jsonb_build_object('payments', v_payments, 'employee_name', v_employee);
END $fn$;

-- 6d) list_acquisitions: purchase_price only when disclosable.
CREATE OR REPLACE FUNCTION public.list_acquisitions(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_from date := coalesce(nullif(p_filters->>'from', ''), nullif(p_filters->>'date_from', ''))::date;
  v_to date := coalesce(nullif(p_filters->>'to', ''), nullif(p_filters->>'date_to', ''))::date;
  v_search text := left(coalesce(p_filters->>'search', ''), 200);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
BEGIN
  IF v_from > v_to THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE';
  END IF;

  WITH matching AS (
    SELECT a.*, v.frame_number, v.license_plate, v.year, v.color, v.internal_code,
           t.name AS vehicle_type, p.full_name AS creator_name
    FROM public.acquisitions a
    JOIN public.vehicles v ON v.id = a.vehicle_id
    LEFT JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN public.profiles p ON p.id = a.created_by
    WHERE
      (v_from IS NULL OR a.acquisition_date >= v_from)
      AND (v_to IS NULL OR a.acquisition_date <= v_to)
      AND (nullif(p_filters->>'status', '') IS NULL OR a.status::text = p_filters->>'status')
      AND (v_search = '' OR concat_ws(' ', v.frame_number, v.license_plate, v.internal_code, t.name, a.seller_name, a.seller_phone) ILIKE '%' || v_search || '%')
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
          'vehicle_type', p.vehicle_type,
          'year', p.year,
          'color', p.color,
          'internal_code', p.internal_code,
          'vehicle_title', private.vehicle_label_text(p.license_plate, p.frame_number, p.internal_code),
          'vehicle_subtitle', private.vehicle_subtitle_text(p.vehicle_type, p.year, p.color),
          'acquisition_date', p.acquisition_date,
          'purchase_price', CASE WHEN private.money_disclosable(p.purchase_price_visibility) THEN p.purchase_price ELSE NULL END,
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
END $fn$;


-- 7) Aggregate read surfaces: exclude rows whose price is not disclosable to the
--    caller so summed/derived money cannot reveal a PRIVATE/RESTRICTED value.
--    (Entitled roles have money_disclosable()=true for every row -> unchanged.)

CREATE OR REPLACE FUNCTION public.list_receivables(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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
      v.internal_code, v.license_plate, v.frame_number, t.name AS vehicle_type,
      coalesce(p.amount, 0) AS paid_amount,
      greatest(0, s.sale_price - coalesce(p.amount, 0)) AS remaining_amount,
      s.due_date IS NOT NULL AND s.due_date < private.today()
        AND s.sale_price > coalesce(p.amount, 0) AS is_overdue
    FROM public.sales s JOIN public.vehicles v ON v.id = s.vehicle_id
    LEFT JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN paid p ON p.sale_id = s.id WHERE s.status = 'COMPLETED'
      AND private.money_disclosable(s.sale_price_visibility)
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
        b.internal_code, b.license_plate, b.frame_number, b.vehicle_type) ILIKE '%' || v_search || '%')
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
END $fn$;

CREATE OR REPLACE FUNCTION public.daily_reconciliation(p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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
  INTO v_summary FROM public.sales WHERE status = 'COMPLETED' AND sale_date = v_day
    AND private.money_disclosable(sale_price_visibility);
  SELECT jsonb_build_object(
    'today_sales_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE s.sale_date = v_day), 0)),
    'debt_collected_today', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE s.sale_date < v_day), 0)),
    'total_collected', private.safe_money(coalesce(sum(p.amount), 0)),
    'cash_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'CASH'), 0)),
    'bank_transfer_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'BANK_TRANSFER'), 0)),
    'other_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'OTHER'), 0))
  ) INTO v_collected FROM public.payments p JOIN public.sales s ON s.id = p.sale_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED'
    AND private.money_disclosable(s.sale_price_visibility);
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_business FROM public.business_expenses WHERE status = 'ACTIVE' AND expense_date = v_day;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_vehicle FROM public.vehicle_expenses WHERE status = 'ACTIVE' AND expense_date = v_day;
  SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('sale_code', s.sale_code,
    'customer_name', s.customer_name, 'customer_phone', s.customer_phone, 'sale_date', s.sale_date,
    'internal_code', v.internal_code, 'license_plate', v.license_plate,
    'is_prior_debt', s.sale_date < v_day)
    || private.vehicle_display(v) ORDER BY p.created_at DESC, p.id), '[]'::jsonb)
  INTO v_payments FROM public.payments p JOIN public.sales s ON s.id = p.sale_id
  JOIN public.vehicles v ON v.id = s.vehicle_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED'
    AND private.money_disclosable(s.sale_price_visibility);
  -- Day details deliberately override lifetime balances with amounts as of this day.
  SELECT coalesce(jsonb_agg(private.sale_json(s) || jsonb_build_object(
    'paid_amount', coalesce(p.paid_today, 0), 'paid_today', coalesce(p.paid_today, 0),
    'remaining_amount', greatest(0, s.sale_price - coalesce(p.paid_to_day, 0))) ORDER BY s.created_at DESC, s.id), '[]'::jsonb)
  INTO v_sales FROM public.sales s
  LEFT JOIN LATERAL (SELECT private.safe_money(sum(amount) FILTER (WHERE payment_date = v_day)) AS paid_today,
    private.safe_money(sum(amount) FILTER (WHERE payment_date <= v_day)) AS paid_to_day
    FROM public.payments WHERE sale_id = s.id AND status = 'ACTIVE') p ON true
  WHERE s.status = 'COMPLETED' AND s.sale_date = v_day
    AND private.money_disclosable(s.sale_price_visibility);
  SELECT coalesce(jsonb_agg(data ORDER BY expense_date, created_at, id), '[]'::jsonb) INTO v_expenses
  FROM (SELECT e.id, e.expense_date, e.created_at, to_jsonb(e) || jsonb_build_object('kind', 'vehicle',
    'internal_code', v.internal_code) || private.vehicle_display(v) AS data
    FROM public.vehicle_expenses e JOIN public.vehicles v ON v.id = e.vehicle_id WHERE e.status = 'ACTIVE' AND e.expense_date = v_day
    UNION ALL SELECT e.id, e.expense_date, e.created_at, to_jsonb(e) || jsonb_build_object('kind', 'business')
    FROM public.business_expenses e WHERE e.status = 'ACTIVE' AND e.expense_date = v_day) expenses;
  RETURN v_summary || v_collected || jsonb_build_object('date', v_day,
    'new_debt_created', private.safe_money((v_summary->>'sales_revenue')::numeric - (v_collected->>'today_sales_collected')::numeric),
    'business_expenses', v_business, 'vehicle_expenses', v_vehicle,
    'total_expenses', private.safe_money(v_business::numeric + v_vehicle),
    'net_cash_movement', private.safe_money((v_collected->>'total_collected')::numeric - v_business - v_vehicle),
    'payments', v_payments, 'sales', v_sales, 'expenses', v_expenses);
END $fn$;

CREATE OR REPLACE FUNCTION public.get_customer_history(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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
    WHERE s.status = 'COMPLETED' AND private.money_disclosable(s.sale_price_visibility)
      AND private.normalize_customer_phone(s.customer_phone) = v_phone
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
  WHERE s.status = 'COMPLETED' AND private.money_disclosable(s.sale_price_visibility)
    AND private.normalize_customer_phone(s.customer_phone) = v_phone;
  RETURN v_summary || jsonb_build_object('sales', v_sales);
END $fn$;

CREATE OR REPLACE FUNCTION public.list_customers(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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
    WHERE s.status = 'COMPLETED' AND private.money_disclosable(s.sale_price_visibility)
      AND private.normalize_customer_phone(s.customer_phone) <> ''
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
END $fn$;

CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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
  SELECT coalesce(jsonb_agg(private.vehicle_json(v) ORDER BY v.created_at DESC, v.id), '[]'::jsonb) INTO v_vehicles
  FROM public.vehicles v
  WHERE v.id IN (
    SELECT x.id FROM public.vehicles x
    LEFT JOIN public.vehicle_types t ON t.id = x.vehicle_type_id
    WHERE concat_ws(' ', x.internal_code, x.license_plate, x.frame_number, x.color, t.name)
      ILIKE '%' || v_query || '%'
    ORDER BY x.created_at DESC, x.id LIMIT v_limit
  );
  v_customers := public.list_customers(jsonb_build_object('search', v_query, 'limit', v_limit))->'items';
  SELECT coalesce(jsonb_agg(to_jsonb(result) ORDER BY result.sale_date DESC, result.created_at DESC, result.id), '[]'::jsonb)
  INTO v_sales FROM (
    SELECT s.id, s.sale_code, s.customer_name, s.customer_phone,
      private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) AS vehicle_title,
      v.internal_code, v.license_plate,
      s.sale_date, s.created_at,
      CASE WHEN private.money_disclosable(s.sale_price_visibility) THEN s.sale_price ELSE NULL END AS sale_price,
      s.status,
      CASE WHEN NOT private.money_disclosable(s.sale_price_visibility) THEN NULL
           WHEN s.status = 'COMPLETED' THEN greatest(0, s.sale_price - coalesce(p.paid, 0)) ELSE 0 END AS remaining_amount
    FROM public.sales s JOIN public.vehicles v ON v.id = s.vehicle_id
    LEFT JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN LATERAL (SELECT private.safe_money(sum(amount)) AS paid FROM public.payments
      WHERE sale_id = s.id AND status = 'ACTIVE') p ON true
    WHERE concat_ws(' ', s.sale_code, s.customer_name, s.customer_phone, v.internal_code, v.license_plate,
      v.frame_number, t.name) ILIKE '%' || v_query || '%'
      OR (v_phone <> '' AND private.normalize_customer_phone(s.customer_phone) LIKE '%' || v_phone || '%')
    ORDER BY s.sale_date DESC, s.created_at DESC, s.id LIMIT v_limit
  ) result;
  RETURN jsonb_build_object('vehicles', v_vehicles, 'customers', v_customers, 'sales', v_sales);
END $fn$;


CREATE OR REPLACE FUNCTION public.dashboard(p_from date DEFAULT (date_trunc('month'::text, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text)))::date, p_to date DEFAULT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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

  -- Sales & revenue (private-priced sales excluded for non-entitled callers)
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
  WHERE status = 'COMPLETED' AND private.money_disclosable(sale_price_visibility);
  v_result := v_result || v_part;

  -- Actionable business alert counts (unpaid/overdue debt, old inventory).
  WITH sale_debts AS (
    SELECT
      s.id,
      s.sale_price - coalesce((SELECT sum(amount) FROM public.payments p WHERE p.sale_id = s.id AND p.status = 'ACTIVE'), 0) AS remaining,
      s.due_date
    FROM public.sales s
    WHERE s.status = 'COMPLETED' AND private.money_disclosable(s.sale_price_visibility)
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
      AND private.money_disclosable(s.sale_price_visibility)
    GROUP BY s.sale_date
  ) d;
  v_result := v_result || jsonb_build_object('daily_sales', v_part);

  -- Acquisitions summary (cost shown only to financial roles; those roles see all)
  SELECT jsonb_build_object(
    'acquired_today', count(*) FILTER (WHERE acquisition_date = v_today),
    'acquired_month', count(*) FILTER (WHERE acquisition_date BETWEEN v_month AND v_today),
    'acquisitions_count', count(*) FILTER (WHERE acquisition_date BETWEEN p_from AND p_to),
    'acquisition_cost', CASE WHEN v_fin THEN private.safe_money(coalesce(sum(purchase_price) FILTER (WHERE acquisition_date BETWEEN p_from AND p_to), 0)) ELSE NULL END
  )
  INTO v_part
  FROM public.acquisitions WHERE status = 'COMPLETED';
  v_result := v_result || v_part;

  -- Recent acquisitions (purchase_price masked per-row inside list_acquisitions)
  v_result := v_result || jsonb_build_object(
    'recent_acquisitions', public.list_acquisitions(jsonb_build_object('limit', 5, 'from', p_from, 'to', p_to, 'status', 'COMPLETED'))->'items'
  );

  RETURN v_result;
END $fn$;

-- 8) Payment entry: block the balance oracle for a non-disclosable sale price.
CREATE OR REPLACE FUNCTION private.add_payment_verified_impl(p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
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
  -- A private/legacy price must not be probed via the "exceeds balance" boundary.
  IF private.current_role() <> 'OWNER'::public.user_role AND NOT private.money_disclosable(v_sale.sale_price_visibility) THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'PAYMENT_OWNER_REQUIRED';
  END IF;
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
END $fn$;


-- 9) Write paths: stamp provenance at the moment the value is recorded, and make the
--    below-cost / approval decision output-invariant when the cost is not disclosable.
CREATE OR REPLACE FUNCTION private.acquire_vehicle_impl(p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_frame text := btrim(coalesce(p_data->>'frame_number', ''));
  v_plate text := btrim(coalesce(p_data->>'license_plate', ''));
  v_kind text := coalesce(nullif(p_data->>'frame_input_kind',''), '');
  v_compact text;
  v_last5 text;
  v_plate_c text;
  v_lock text;
  v_detect jsonb;
  v_level text;
  v_reason text;
  v_vehicle_id uuid;
  v_vehicle public.vehicles;
  v_acquisition public.acquisitions;
  v_purchase bigint := private.money_input(p_data, 'purchase_price');
  v_vis public.money_visibility := private.price_visibility_for(private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]));
  v_type uuid;
  v_date date := coalesce((p_data->>'acquisition_date')::date, private.today());
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  -- Every vehicle entering stock must carry a purchase price.
  IF v_purchase IS NULL OR v_purchase <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_PRICE_REQUIRED';
  END IF;

  v_type := private.vehicle_type_input(p_data);

  IF v_frame = '' THEN
    v_frame := 'GEN-' || substr(gen_random_uuid()::text, 1, 12);
  END IF;

  IF v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
  END IF;

  v_compact := private.frame_compact_of(v_frame);
  IF v_kind NOT IN ('FULL','PARTIAL') THEN
    v_kind := private.frame_kind(v_compact);
  END IF;
  v_last5 := private.frame_last5_of(v_compact);
  v_plate_c := private.plate_compact_of(v_plate);

  v_lock := coalesce(v_plate_c,'~') || '#' || coalesce(v_last5,'~') || '#' ||
            coalesce(nullif(v_compact,''),'~');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock, 0));

  v_detect := private.detect_vehicle_duplicates(v_frame, v_plate, v_kind, NULL);
  v_level := v_detect->>'level';
  v_reason := v_detect->>'reason';

  IF v_level = 'RED' THEN
    IF v_reason = 'FULL_FRAME_MATCH' THEN
      SELECT id INTO v_vehicle_id FROM public.vehicles
      WHERE frame_input_kind='FULL' AND frame_compact = v_compact AND status <> 'CANCELLED';
      IF v_vehicle_id IS NOT NULL THEN
        PERFORM 1 FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
      END IF;
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_FRAME_NUMBER';
    END IF;
    RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_SUSPECTED';
  ELSIF v_level = 'YELLOW' THEN
    IF coalesce((p_data->>'duplicate_ack')::boolean, false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_NEEDS_CONFIRM';
    END IF;
    INSERT INTO public.vehicle_duplicate_checks
      (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
       candidate_ids, acknowledged)
    VALUES (v_actor, 'ACQUIRE', 'YELLOW', v_reason, v_plate_c, v_last5, v_kind,
      (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
      true);
  END IF;

  INSERT INTO public.vehicles (
    frame_number, license_plate, frame_input_kind,
    vehicle_type_id, year, color,
    purchase_date, status,
    supplier_name, supplier_phone, notes, created_by
  ) VALUES (
    v_frame,
    v_plate,
    v_kind,
    v_type,
    nullif(p_data->>'year', '')::integer,
    btrim(coalesce(p_data->>'color', '')),
    v_date,
    'IN_STOCK'::public.vehicle_status,
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'notes', ''),
    v_actor
  ) RETURNING * INTO v_vehicle;

  INSERT INTO public.vehicle_financials (vehicle_id, purchase_price, updated_by, purchase_price_visibility)
  VALUES (v_vehicle.id, v_purchase, v_actor, v_vis);

  INSERT INTO public.acquisitions (
    vehicle_id, acquisition_date, purchase_price, purchase_price_visibility,
    seller_name, seller_phone, notes, status, created_by
  ) VALUES (
    v_vehicle.id,
    v_date,
    v_purchase,
    v_vis,
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'acquisition_notes', ''),
    'COMPLETED'::public.acquisition_status,
    v_actor
  ) RETURNING * INTO v_acquisition;

  PERFORM private.audit(
    'CREATE_ACQUISITION', 'acquisitions', v_acquisition.id,
    null,
    to_jsonb(v_acquisition) || jsonb_build_object('vehicle', to_jsonb(v_vehicle)),
    v_vehicle.id
  );

  PERFORM private.audit(
    'CREATE_VEHICLE', 'vehicles', v_vehicle.id,
    null,
    to_jsonb(v_vehicle)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_vehicle.vehicle_type_id)),
    v_vehicle.id
  );

  RETURN v_vehicle.id;
END $fn$;

CREATE OR REPLACE FUNCTION private.save_vehicle_impl(p_data jsonb, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.vehicles; v_new public.vehicles; v_purchase bigint; v_old_purchase bigint;
  v_status public.vehicle_status; v_date date; v_old_json jsonb;
  v_frame text; v_type uuid;
  v_kind text; v_kind_in text; v_plate text;
  v_compact text; v_last5 text; v_plate_c text; v_lock text;
  v_detect jsonb; v_level text; v_reason text; v_changed boolean;
  v_vis public.money_visibility := private.price_visibility_for(private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]));
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;
  IF p_id IS NULL THEN
    v_type := private.vehicle_type_input(p_data);
  ELSE
    v_type := private.vehicle_type_input_optional(p_data);
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.vehicles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='VEHICLE_NOT_FOUND'; END IF;
    PERFORM private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
    IF EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
      RAISE EXCEPTION USING errcode='22023',message='DELETE_PENDING';
    END IF;
    IF p_data ? 'expected_updated_at' AND v_old.updated_at IS DISTINCT FROM (p_data->>'expected_updated_at')::timestamptz THEN
      RAISE EXCEPTION USING errcode='40001',message='VEHICLE_EDIT_CONFLICT';
    END IF;
    SELECT purchase_price INTO v_old_purchase FROM public.vehicle_financials WHERE vehicle_id = p_id;
  END IF;
  v_status := COALESCE((p_data->>'status')::public.vehicle_status, v_old.status, 'IN_STOCK');
  IF v_status = 'SOLD' AND (p_id IS NULL OR v_old.status <> 'SOLD') THEN RAISE EXCEPTION USING errcode='22023',message='USE_SELL_VEHICLE'; END IF;
  v_purchase := private.money_input(p_data, 'purchase_price', v_old_purchase);
  IF p_id IS NULL AND (v_purchase IS NULL OR v_purchase <= 0) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_PRICE_REQUIRED';
  END IF;
  IF p_id IS NOT NULL AND p_data ? 'purchase_price' AND (v_purchase IS NULL OR v_purchase <= 0) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_PRICE_REQUIRED';
  END IF;
  v_date := COALESCE((p_data->>'purchase_date')::date, v_old.purchase_date, private.today());
  IF v_date > private.today() THEN RAISE EXCEPTION USING errcode='22023',message='FUTURE_DATE'; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = p_id AND status = 'ACTIVE' AND expense_date < v_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_AFTER_EXPENSE';
  END IF;
  IF v_old.status = 'SOLD' AND (v_status <> 'SOLD' OR v_purchase IS DISTINCT FROM v_old_purchase
      OR v_date <> v_old.purchase_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='SOLD_VEHICLE_LOCKED';
  END IF;

  v_kind_in := nullif(p_data->>'frame_input_kind','');

  IF p_id IS NULL THEN
    v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), 'GEN-' || substr(gen_random_uuid()::text, 1, 12));
    v_kind := coalesce(v_kind_in, private.frame_kind(private.frame_compact_of(v_frame)));
    v_plate := btrim(coalesce(p_data->>'license_plate',''));
    v_changed := true;
  ELSE
    v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), v_old.frame_number);
    v_plate := btrim(COALESCE(p_data->>'license_plate', v_old.license_plate));
    IF p_data ? 'frame_number' OR v_kind_in IS NOT NULL THEN
      v_kind := coalesce(v_kind_in, private.frame_kind(private.frame_compact_of(v_frame)));
    ELSE
      v_kind := v_old.frame_input_kind;
    END IF;
    v_compact := private.frame_compact_of(v_frame);
    v_plate_c := private.plate_compact_of(v_plate);
    v_changed := v_compact IS DISTINCT FROM v_old.frame_compact
      OR v_plate_c IS DISTINCT FROM v_old.plate_compact
      OR v_kind <> v_old.frame_input_kind;
  END IF;
  v_compact := private.frame_compact_of(v_frame);
  v_last5 := private.frame_last5_of(v_compact);
  v_plate_c := private.plate_compact_of(v_plate);

  IF v_changed AND (v_plate_c IS NOT NULL OR v_last5 IS NOT NULL) THEN
    v_lock := coalesce(v_plate_c,'~') || '#' || coalesce(v_last5,'~') || '#' ||
              coalesce(nullif(v_compact,''),'~');
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock, 0));
    v_detect := private.detect_vehicle_duplicates(v_frame, v_plate, v_kind, p_id);
    v_level := v_detect->>'level';
    v_reason := v_detect->>'reason';
    IF v_level = 'RED' THEN
      IF v_reason = 'FULL_FRAME_MATCH' THEN
        RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_FRAME_NUMBER';
      END IF;
      RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_VEHICLE_SUSPECTED';
    ELSIF v_level = 'YELLOW' THEN
      IF coalesce((p_data->>'duplicate_ack')::boolean, false) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING errcode='23505', message='DUPLICATE_VEHICLE_NEEDS_CONFIRM';
      END IF;
      INSERT INTO public.vehicle_duplicate_checks
        (actor, context, level, reason, plate_compact, frame_last5, frame_input_kind,
         candidate_ids, acknowledged)
      VALUES (v_actor, 'SAVE', 'YELLOW', v_reason, v_plate_c, v_last5, v_kind,
        (SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(v_detect->'candidate_ids') x),
        true);
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.vehicles(
      license_plate, vehicle_type_id, year, color, frame_number, frame_input_kind,
      purchase_date, status, supplier_name, supplier_phone, notes, created_by
    ) VALUES (
      v_plate, v_type,
      NULLIF(p_data->>'year', '')::integer, btrim(COALESCE(p_data->>'color', '')), v_frame, v_kind,
      v_date, v_status,
      btrim(COALESCE(p_data->>'supplier_name', '')), btrim(COALESCE(p_data->>'supplier_phone', '')), COALESCE(p_data->>'notes', ''), v_actor
    ) RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by, purchase_price_visibility) VALUES (v_new.id, v_purchase, v_actor, v_vis);
    PERFORM private.audit('CREATE_VEHICLE', 'vehicles', v_new.id, NULL,
      to_jsonb(v_new)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_new.vehicle_type_id)),
      v_new.id);
  ELSE
    v_old_json := to_jsonb(v_old)
      || jsonb_build_object('purchase_price', v_old_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_old.vehicle_type_id));
    UPDATE public.vehicles SET
      license_plate = v_plate,
      vehicle_type_id = COALESCE(v_type, vehicle_type_id),
      year = CASE WHEN p_data ? 'year' THEN NULLIF(p_data->>'year', '')::integer ELSE year END,
      color = btrim(COALESCE(p_data->>'color', color)),
      frame_number = v_frame,
      frame_input_kind = v_kind,
      purchase_date = v_date,
      status = v_status,
      supplier_name = btrim(COALESCE(p_data->>'supplier_name', supplier_name)),
      supplier_phone = btrim(COALESCE(p_data->>'supplier_phone', supplier_phone)),
      notes = COALESCE(p_data->>'notes', notes),
      updated_at = now()
    WHERE id = p_id RETURNING * INTO v_new;

    -- Re-stamp provenance ONLY when the price value actually changed; editing other
    -- fields must not reclassify (and thus re-expose or hide) the OWNER's price.
    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by, purchase_price_visibility)
      VALUES (p_id, v_purchase, v_actor, v_vis)
      ON CONFLICT (vehicle_id) DO UPDATE
        SET purchase_price = EXCLUDED.purchase_price,
            updated_by = EXCLUDED.updated_by,
            purchase_price_visibility = CASE
              WHEN public.vehicle_financials.purchase_price IS DISTINCT FROM EXCLUDED.purchase_price
                THEN EXCLUDED.purchase_price_visibility
              ELSE public.vehicle_financials.purchase_price_visibility END,
            updated_at = now();

    PERFORM private.audit('UPDATE_VEHICLE', 'vehicles', v_new.id, v_old_json,
      to_jsonb(v_new)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_new.vehicle_type_id)),
      v_new.id);
  END IF;
  RETURN v_new.id;
END $fn$;


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
END $fn$;

CREATE OR REPLACE FUNCTION private.request_sale_below_cost_impl(p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_actor uuid := private.require_role(ARRAY['MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles;
  v_purchase bigint;
  v_cost_vis public.money_visibility;
  v_expenses bigint;
  v_price bigint := private.money_input(p_data, 'sale_price');
  v_initial bigint := private.money_input(p_data, 'initial_payment', 0);
  v_date date := coalesce((p_data->>'sale_date')::date, private.today());
  v_due_date date := nullif(p_data->>'due_date', '')::date;
  v_customer text := btrim(coalesce(p_data->>'customer_name', ''));
  v_payload jsonb;
  v_approval uuid;
  v_reason text;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = (p_data->>'vehicle_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND'; END IF;
  PERFORM private.require_role(ARRAY['MANAGER','STAFF']::public.user_role[]);
  IF v_vehicle.status NOT IN ('IN_STOCK', 'RESERVED') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_NOT_AVAILABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'DELETE_PENDING';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.subject_id = v_vehicle.id AND ar.kind = 'SALE_BELOW_COST' AND ar.status = 'PENDING') THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'ALREADY_PENDING';
  END IF;

  IF v_customer = '' OR char_length(v_customer) > 160 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_CUSTOMER_NAME';
  END IF;
  IF v_date < v_vehicle.purchase_date OR v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_SALE_DATE';
  END IF;
  IF v_due_date IS NOT NULL AND v_due_date < v_date THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DUE_DATE';
  END IF;
  IF v_price IS NULL OR v_price <= 0 OR v_initial > v_price THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT';
  END IF;

  SELECT purchase_price, purchase_price_visibility INTO v_purchase, v_cost_vis FROM public.vehicle_financials WHERE vehicle_id = v_vehicle.id;
  IF v_purchase IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_COST_REQUIRED';
  END IF;
  -- Anti-oracle: only reject "not actually below cost" when the actor may already see the
  -- cost. If the cost is private to them, the request is accepted uniformly into the
  -- OWNER-review queue without disclosing whether the price is above or below cost.
  IF private.money_disclosable(v_cost_vis) AND v_price >= v_purchase THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_NOT_BELOW_COST';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE' AND expense_date > v_date) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'SALE_BEFORE_EXPENSE';
  END IF;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_expenses
  FROM public.vehicle_expenses WHERE vehicle_id = v_vehicle.id AND status = 'ACTIVE';

  v_payload := jsonb_build_object(
    'vehicle_id', v_vehicle.id,
    'customer_name', v_customer,
    'customer_phone', btrim(coalesce(p_data->>'customer_phone', '')),
    'sale_price', v_price,
    'sale_date', v_date,
    'due_date', v_due_date,
    'payment_method', coalesce(nullif(p_data->>'payment_method',''), 'CASH'),
    'initial_payment', v_initial,
    'notes', coalesce(p_data->>'notes', ''),
    'sold_by', v_actor,
    'snapshot_purchase_price', v_purchase,
    'snapshot_expense_total', v_expenses,
    'shortfall', v_purchase - v_price
  );

  v_reason := 'Bán dưới giá thu xe '
    || private.vehicle_label_text(v_vehicle.license_plate, v_vehicle.frame_number, v_vehicle.internal_code)
    || ': giá thu ' || private.money_text(v_purchase)
    || ' → giá bán ' || private.money_text(v_price)
    || ' (thiếu ' || private.money_text(v_purchase - v_price) || ').';

  INSERT INTO public.approval_requests (kind, subject_id, requested_by, reason, payload)
  VALUES ('SALE_BELOW_COST', v_vehicle.id, v_actor, left(v_reason, 1000), v_payload)
  RETURNING id INTO v_approval;

  PERFORM private.audit('REQUEST_SALE_BELOW_COST', 'vehicles', v_vehicle.id, null,
    v_payload || jsonb_build_object('request_id', v_approval, 'requested_by', v_actor), v_vehicle.id);

  RETURN v_approval;
END $fn$;

-- 10) Self-verification (fail the whole migration if any guarantee does not hold).
DO $do$
DECLARE c bigint;
BEGIN
  SELECT count(*) INTO c FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' AND t.typname = 'money_visibility';
  IF c <> 3 THEN RAISE EXCEPTION 'provenance verify: money_visibility expected 3 labels, got %', c; END IF;

  SELECT count(*) INTO c FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'vehicle_financials' AND column_name = 'purchase_price_visibility')
       OR (table_name = 'acquisitions'        AND column_name = 'purchase_price_visibility')
       OR (table_name = 'sales'               AND column_name = 'sale_price_visibility'))
     AND is_nullable = 'NO';
  IF c <> 3 THEN RAISE EXCEPTION 'provenance verify: expected 3 NOT NULL visibility columns, got %', c; END IF;

  IF private.money_disclosable('PUBLIC'::public.money_visibility) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'provenance verify: PUBLIC must be disclosable'; END IF;
  IF private.money_disclosable('PRIVATE'::public.money_visibility) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'provenance verify: PRIVATE must be non-disclosable without financial right'; END IF;
  IF private.money_disclosable('RESTRICTED'::public.money_visibility) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'provenance verify: RESTRICTED must be non-disclosable without financial right'; END IF;

  SELECT count(*) INTO c FROM pg_policy p
    JOIN pg_class r ON r.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE n.nspname = 'public' AND r.relname = 'approval_requests' AND p.polname = 'approvals_read'
     AND p.polcmd = 'r'
     AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%OWNER%'
     AND pg_get_expr(p.polqual, p.polrelid) NOT ILIKE '%requested_by%';
  IF c <> 1 THEN RAISE EXCEPTION 'provenance verify: approvals_read must be OWNER-only'; END IF;

  SELECT count(*) INTO c FROM pg_policy p
    JOIN pg_class r ON r.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE n.nspname = 'public' AND r.relname = 'sales' AND p.polname = 'sales_read'
     AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%money_disclosable%';
  IF c <> 1 THEN RAISE EXCEPTION 'provenance verify: sales_read must be provenance-gated'; END IF;

  SELECT count(*) INTO c FROM pg_policy p
    JOIN pg_class r ON r.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE n.nspname = 'public' AND r.relname = 'payments' AND p.polname = 'payments_read'
     AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%money_disclosable%';
  IF c <> 1 THEN RAISE EXCEPTION 'provenance verify: payments_read must be provenance-gated'; END IF;
END
$do$;
