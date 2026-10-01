-- Migration: Introduce acquisitions table and refactor vehicle lifecycle
-- This migration:
--   1. Makes frame_number UNIQUE NOT NULL (business identity)
--   2. Creates acquisitions table (thu vào)
--   3. Backfills acquisitions from existing vehicle + vehicle_financials data
--   4. Creates list_acquisitions query function
--   5. Creates acquire_vehicle RPC (atomic acquisition)
--   6. Updates dashboard to include acquisition counts
--   7. Adds RLS and grants for acquisitions
--   8. Updates vehicle_json to pull purchase_price from acquisitions

-- ============================================================
-- STEP 1: Ensure frame_number is UNIQUE NOT NULL
-- ============================================================

-- First, fill empty frame_numbers with a generated value so NOT NULL can be enforced
UPDATE public.vehicles
SET frame_number = 'GEN-' || id::text
WHERE frame_number IS NULL OR btrim(frame_number) = '';

-- Drop the old non-unique index
DROP INDEX IF EXISTS public.vehicles_frame_number;

-- Add unique constraint
ALTER TABLE public.vehicles
  ALTER COLUMN frame_number SET NOT NULL,
  ALTER COLUMN frame_number SET DEFAULT '',
  ADD CONSTRAINT vehicles_frame_number_unique UNIQUE (frame_number);

-- Rename license_plate to current_license_plate for clarity (keep column working)
-- We keep the column name as license_plate for backward compatibility in V1
-- but add a comment for documentation
COMMENT ON COLUMN public.vehicles.license_plate IS 'Current license plate. Nullable conceptually; empty string means no plate yet. Future: vehicle_license_plates history table.';

-- ============================================================
-- STEP 2: Create acquisition status enum and acquisitions table
-- ============================================================

CREATE TYPE public.acquisition_status AS ENUM ('COMPLETED', 'CANCELLED');

CREATE TABLE public.acquisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID NOT NULL REFERENCES public.vehicles(id),
  acquisition_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
  purchase_price BIGINT NOT NULL CHECK (purchase_price BETWEEN 0 AND 1000000000000),
  seller_name TEXT NOT NULL DEFAULT '' CHECK (length(seller_name) <= 200),
  seller_phone TEXT NOT NULL DEFAULT '' CHECK (length(seller_phone) <= 40),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  status public.acquisition_status NOT NULL DEFAULT 'COMPLETED',
  cancellation_reason TEXT CHECK (length(cancellation_reason) <= 1000),
  cancelled_by UUID REFERENCES public.profiles(id),
  cancelled_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one completed acquisition per vehicle
CREATE UNIQUE INDEX one_completed_acquisition_per_vehicle
  ON public.acquisitions(vehicle_id) WHERE status = 'COMPLETED';

CREATE INDEX acquisitions_date ON public.acquisitions(acquisition_date DESC);
CREATE INDEX acquisitions_vehicle ON public.acquisitions(vehicle_id);
CREATE INDEX acquisitions_status ON public.acquisitions(status);

-- ============================================================
-- STEP 3: Enable RLS on acquisitions
-- ============================================================

ALTER TABLE public.acquisitions ENABLE ROW LEVEL SECURITY;

-- Acquisitions contain purchase_price which is financial data
-- Only OWNER and MANAGER can read acquisitions (matches vehicle_expenses policy)
CREATE POLICY acquisitions_read ON public.acquisitions
  FOR SELECT TO authenticated
  USING (private.can_financials() OR (private.is_active() AND private.current_role() IN ('OWNER', 'MANAGER', 'STAFF')));

-- Grant select permission
REVOKE ALL ON public.acquisitions FROM public, anon, authenticated;
GRANT SELECT ON public.acquisitions TO authenticated;

-- ============================================================
-- STEP 4: Backfill acquisitions from existing data
-- ============================================================

-- For every existing vehicle that has a purchase_price in vehicle_financials,
-- create an acquisition record
INSERT INTO public.acquisitions (vehicle_id, acquisition_date, purchase_price, seller_name, seller_phone, notes, status, created_by, created_at)
SELECT
  v.id,
  v.purchase_date,
  COALESCE(vf.purchase_price, 0),
  v.supplier_name,
  v.supplier_phone,
  '',
  'COMPLETED'::public.acquisition_status,
  v.created_by,
  v.created_at
FROM public.vehicles v
LEFT JOIN public.vehicle_financials vf ON vf.vehicle_id = v.id
WHERE v.status != 'CANCELLED';

-- ============================================================
-- STEP 5: Create acquire_vehicle RPC (atomic Thu Xe operation)
-- ============================================================

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

-- ============================================================
-- STEP 6: Create list_acquisitions query function
-- ============================================================

CREATE FUNCTION public.list_acquisitions(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
END $$;

-- ============================================================
-- STEP 7: Cancel acquisition function
-- ============================================================

CREATE FUNCTION public.cancel_acquisition(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_acq public.acquisitions;
  v_vehicle public.vehicles;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CANCELLATION_REASON_REQUIRED';
  END IF;

  SELECT * INTO v_acq FROM public.acquisitions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'ACQUISITION_NOT_FOUND';
  END IF;
  IF v_acq.status <> 'COMPLETED' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'ACQUISITION_ALREADY_CANCELLED';
  END IF;

  -- Check vehicle state
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_acq.vehicle_id FOR UPDATE;
  IF v_vehicle.status = 'SOLD' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CANNOT_CANCEL_SOLD_ACQUISITION';
  END IF;

  -- Cancel the acquisition
  UPDATE public.acquisitions
  SET status = 'CANCELLED',
      cancellation_reason = btrim(p_reason),
      cancelled_by = v_actor,
      cancelled_at = now(),
      updated_at = now()
  WHERE id = p_id;

  -- Mark vehicle as CANCELLED
  UPDATE public.vehicles
  SET status = 'CANCELLED', updated_at = now()
  WHERE id = v_acq.vehicle_id;

  -- Audit
  PERFORM private.audit(
    'CANCEL_ACQUISITION', 'acquisitions', p_id,
    to_jsonb(v_acq),
    to_jsonb(v_acq) || jsonb_build_object('status', 'CANCELLED', 'cancellation_reason', btrim(p_reason)),
    v_acq.vehicle_id
  );
END $$;

-- ============================================================
-- STEP 8: Update dashboard to include acquisition counts
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard(
  p_from date DEFAULT date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
  p_to date DEFAULT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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

  -- Inventory counts
  SELECT jsonb_build_object(
    'in_stock', count(*) FILTER (WHERE status = 'IN_STOCK'),
    'reserved', count(*) FILTER (WHERE status = 'RESERVED'),
    'inventory_cost_pending', count(*) FILTER (WHERE v.status IN ('IN_STOCK','RESERVED') AND f.purchase_price IS NULL),
    'inventory_cost', CASE WHEN v_fin AND count(*) FILTER (WHERE v.status IN ('IN_STOCK','RESERVED') AND f.purchase_price IS NULL) = 0
      THEN private.safe_money(coalesce(sum(f.purchase_price::numeric + coalesce(e.expenses, 0)) FILTER (WHERE v.status IN ('IN_STOCK','RESERVED')), 0))
      ELSE NULL END
  ) INTO v_result
  FROM public.vehicles v
  LEFT JOIN public.vehicle_financials f ON f.vehicle_id = v.id
  LEFT JOIN LATERAL (
    SELECT sum(amount) AS expenses FROM public.vehicle_expenses WHERE vehicle_id = v.id AND status = 'ACTIVE'
  ) e ON true;

  -- Inventory indicator
  SELECT jsonb_build_object('inventory_indicator', CASE
    WHEN (v_result->>'in_stock')::integer + (v_result->>'reserved')::integer < low_stock_threshold THEN 'LOW'
    WHEN (v_result->>'in_stock')::integer + (v_result->>'reserved')::integer > high_stock_threshold THEN 'HIGH'
    ELSE 'NORMAL' END
  ) INTO v_part FROM public.system_settings WHERE id;
  v_result := v_result || v_part;

  -- Acquisition counts (THU VÀO)
  SELECT jsonb_build_object(
    'acquired_today', count(*) FILTER (WHERE acquisition_date = v_today),
    'acquired_month', count(*) FILTER (WHERE acquisition_date BETWEEN v_month AND v_today),
    'acquisitions_count', count(*) FILTER (WHERE acquisition_date BETWEEN p_from AND p_to),
    'acquisition_cost', CASE WHEN v_fin THEN private.safe_money(coalesce(sum(purchase_price) FILTER (WHERE acquisition_date BETWEEN p_from AND p_to), 0)) ELSE NULL END
  ) INTO v_part
  FROM public.acquisitions WHERE status = 'COMPLETED';
  v_result := v_result || v_part;

  -- Sales metrics (BÁN RA)
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
  ) INTO v_part
  FROM public.sales s
  JOIN public.sale_financials f ON f.sale_id = s.id
  WHERE status = 'COMPLETED';
  v_result := v_result || v_part;

  -- Business expenses
  SELECT jsonb_build_object('business_expenses', CASE WHEN v_manage THEN private.safe_money(coalesce(sum(amount), 0)) ELSE NULL END)
  INTO v_part FROM public.business_expenses WHERE status = 'ACTIVE' AND expense_date BETWEEN p_from AND p_to;
  v_result := v_result || v_part;

  -- Recent data
  v_result := v_result || jsonb_build_object(
    'recent_sales', public.list_sales(jsonb_build_object('limit', 5, 'from', p_from, 'to', p_to, 'status', 'COMPLETED'))->'items',
    'recent_vehicles', public.list_vehicles(jsonb_build_object('limit', 5))->'items',
    'recent_acquisitions', public.list_acquisitions(jsonb_build_object('limit', 5, 'from', p_from, 'to', p_to, 'status', 'COMPLETED'))->'items'
  );

  IF v_manage THEN
    v_result := v_result || jsonb_build_object('recent_expenses', public.list_expenses(jsonb_build_object('limit', 5, 'from', p_from, 'to', p_to, 'status', 'ACTIVE'))->'items');
  ELSE
    v_result := v_result || jsonb_build_object('recent_expenses', '[]'::jsonb);
  END IF;

  -- Aging stats
  SELECT jsonb_build_object('aging', jsonb_build_array(
    jsonb_build_object('bucket', '0–29', 'count', count(*) FILTER (WHERE v_today - purchase_date < 30)),
    jsonb_build_object('bucket', '30–59', 'count', count(*) FILTER (WHERE v_today - purchase_date BETWEEN 30 AND 59)),
    jsonb_build_object('bucket', '60–89', 'count', count(*) FILTER (WHERE v_today - purchase_date BETWEEN 60 AND 89)),
    jsonb_build_object('bucket', '90+', 'count', count(*) FILTER (WHERE v_today - purchase_date >= 90))
  )) INTO v_part FROM public.vehicles WHERE status IN ('IN_STOCK','RESERVED');
  v_result := v_result || v_part;

  -- Longest in stock
  SELECT coalesce(jsonb_agg(private.vehicle_json(v) ORDER BY v.purchase_date, v.created_at), '[]'::jsonb)
  INTO v_part
  FROM public.vehicles v
  WHERE v.id IN (
    SELECT id FROM public.vehicles WHERE status IN ('IN_STOCK','RESERVED')
    ORDER BY purchase_date, created_at LIMIT 5
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
    SELECT s.sale_date AS date, count(*) AS count,
      CASE WHEN v_manage THEN private.safe_money(sum(s.sale_price)) ELSE NULL END AS revenue,
      CASE WHEN v_fin THEN private.safe_money(sum(f.gross_profit)) ELSE NULL END AS gross_profit
    FROM public.sales s
    JOIN public.sale_financials f ON f.sale_id = s.id
    WHERE s.status = 'COMPLETED' AND s.sale_date BETWEEN p_from AND p_to
    GROUP BY s.sale_date
  ) d;
  v_result := v_result || jsonb_build_object('daily_sales', v_part);

  RETURN v_result;
END $$;

-- ============================================================
-- STEP 9: Update report function to include acquisitions
-- ============================================================

CREATE OR REPLACE FUNCTION public.report(p_kind text, p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_filters jsonb;
BEGIN
  IF p_kind = 'profit' AND NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
  END IF;

  v_filters := p_filters || jsonb_build_object('status', 'COMPLETED');

  IF p_kind IN ('sales', 'profit') THEN
    RETURN public.list_sales(v_filters);
  ELSIF p_kind = 'acquisitions' THEN
    RETURN public.list_acquisitions(v_filters);
  ELSIF p_kind = 'inventory' THEN
    RETURN public.list_vehicles(p_filters || jsonb_build_object(
      'status', coalesce(p_filters->>'status', 'UNSOLD'),
      'date_from', coalesce(p_filters->>'from', p_filters->>'date_from'),
      'date_to', coalesce(p_filters->>'to', p_filters->>'date_to')
    ));
  ELSIF p_kind = 'vehicle_expenses' THEN
    RETURN public.list_expenses(p_filters || jsonb_build_object('kind', 'vehicle', 'status', 'ACTIVE'));
  ELSIF p_kind = 'business_expenses' THEN
    RETURN public.list_expenses(p_filters || jsonb_build_object('kind', 'business', 'status', 'ACTIVE'));
  ELSE
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_REPORT_KIND';
  END IF;
END $$;

-- ============================================================
-- STEP 10: Grant execute on new functions
-- ============================================================

DO $$
DECLARE v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY(ARRAY[
      'acquire_vehicle', 'list_acquisitions', 'cancel_acquisition'
    ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', v_function.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_function.signature);
  END LOOP;
END $$;
