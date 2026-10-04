-- Migration: 20261004003900_business_notifications.sql
-- Description: In-app business notifications (the bell). Every core trade action
--   already funnels through private.audit(), so fan-out hooks the audit trail itself:
--   an AFTER INSERT trigger on audit_logs turns whitelisted business events into
--   per-recipient notification rows. No business RPC is modified (forward-only).
--   * OWNER + active MANAGER receive every store event; STAFF receive their own
--     actions plus events that land on transactions they own (their sale gets a
--     payment/cancellation, their vehicle gets edited/sold).
--   * Amounts are rendered per recipient: OWNER, financial MANAGERs, and the actor
--     see prices; everyone else gets money-free copy (PII/financial isolation).
--   * Same-transaction dedup: the initial payment inside sell_vehicle and the
--     VOID_PAYMENT loop inside cancel_sale are cleaned up when the primary
--     CREATE_SALE / CANCEL_SALE event notifies; the CREATE_VEHICLE half of an
--     acquisition is skipped. now() is stable inside a transaction, so rows
--     written by one RPC share a created_at and can be matched exactly.
--   * Delivered live via the Supabase Realtime publication below; RLS keeps every
--     row visible to its recipient only. Writes happen solely through the
--     SECURITY DEFINER trigger — no client can insert.
-- NOTE: inserting notifications must NOT call private.audit (would re-enter trigger).

-- ============================================================
-- STEP 1: Table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  vehicle_id uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body text CHECK (body IS NULL OR char_length(body) <= 400),
  deep_link text CHECK (deep_link IS NULL OR char_length(deep_link) <= 200),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_recent
  ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread
  ON public.notifications (user_id) WHERE read_at IS NULL;

-- ============================================================
-- STEP 2: Deterministic Vietnamese money text (12500000 -> 12.500.000)
-- Bigint magnitude is capped at 1.000.000.000.000 by the existing checks.
-- ============================================================

CREATE OR REPLACE FUNCTION private.money_text(p_amount bigint) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_amount IS NULL THEN NULL
    ELSE regexp_replace(p_amount::text, '(\d)(?=(\d{3})+$)', '\1.', 'g') || ' đ'
  END;
$$;

-- Vehicle display label: brand+model, else internal code, else plate.
CREATE OR REPLACE FUNCTION private.vehicle_label_text(
  p_brand text, p_model text, p_internal_code text, p_license_plate text
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(
    nullif(btrim(concat(coalesce(p_brand, ''), ' ', coalesce(p_model, ''))), ''),
    nullif(btrim(coalesce(p_internal_code, '')), ''),
    CASE WHEN btrim(coalesce(p_license_plate, '')) <> ''
         THEN 'BS ' || btrim(p_license_plate) END,
    'xe không rõ danh tính');
$$;

-- ============================================================
-- STEP 3: Fan-out trigger on the audit trail
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
                      'CREATE_PAYMENT','VOID_PAYMENT','CREATE_VEHICLE','UPDATE_VEHICLE') THEN
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

DROP TRIGGER IF EXISTS notify_after_audit ON public.audit_logs;
CREATE TRIGGER notify_after_audit
  AFTER INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION private.notify_from_audit();

-- ============================================================
-- STEP 4: Client RPCs (SECURITY DEFINER, scoped to auth.uid())
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_notifications(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_limit integer := least(100, greatest(1, coalesce((p_filters ->> 'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters ->> 'offset')::integer, 0));
  v_unread_only boolean := coalesce((p_filters ->> 'unread_only')::boolean, false);
  v_items jsonb;
  v_total bigint;
  v_unread bigint;
BEGIN
  IF jsonb_typeof(p_filters) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  SELECT count(*) INTO v_total FROM public.notifications n WHERE n.user_id = v_actor;
  SELECT count(*) INTO v_unread
  FROM public.notifications n WHERE n.user_id = v_actor AND n.read_at IS NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'action', x.action, 'entity_type', x.entity_type,
      'entity_id', x.entity_id, 'vehicle_id', x.vehicle_id,
      'title', x.title, 'body', x.body, 'deep_link', x.deep_link,
      'read_at', x.read_at, 'created_at', x.created_at,
      'actor_id', x.actor_id, 'actor_name', x.actor_name
    ) ORDER BY x.rn), '[]'::jsonb) INTO v_items
  FROM (
    SELECT row_number() OVER (ORDER BY n.created_at DESC, n.id DESC) AS rn,
           n.id, n.action, n.entity_type, n.entity_id, n.vehicle_id,
           n.title, n.body, n.deep_link, n.read_at, n.created_at,
           n.actor_id, a.full_name AS actor_name
    FROM public.notifications n
    LEFT JOIN public.profiles a ON a.id = n.actor_id
    WHERE n.user_id = v_actor
      AND (NOT v_unread_only OR n.read_at IS NULL)
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT v_limit OFFSET v_offset
  ) x;

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'unread_count', v_unread);
END $$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_count integer;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_ids) > 200 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TOO_MANY_IDS';
  END IF;
  UPDATE public.notifications n
  SET read_at = now()
  WHERE n.user_id = v_actor AND n.id = ANY (p_ids) AND n.read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_count integer;
BEGIN
  UPDATE public.notifications n
  SET read_at = now()
  WHERE n.user_id = v_actor AND n.read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ============================================================
-- STEP 5: RLS + privilege lockdown (announcements pattern)
-- ============================================================

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_self_read ON public.notifications;
CREATE POLICY notifications_self_read ON public.notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Recipients may only ever fill in read_at, never rewrite content or recipient.
DROP POLICY IF EXISTS notifications_self_mark_read ON public.notifications;
CREATE POLICY notifications_self_mark_read ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND read_at IS NOT NULL);

REVOKE ALL ON public.notifications FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_notifications(jsonb),
  public.mark_notifications_read(uuid[]), public.mark_all_notifications_read()
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications(jsonb),
  public.mark_notifications_read(uuid[]), public.mark_all_notifications_read()
  TO authenticated;

-- ============================================================
-- STEP 6: Realtime delivery (RLS-filtered postgres_changes)
-- ============================================================

DO $$ BEGIN
  -- The publication only exists on the managed Supabase platform; disposable test
  -- engines skip this block, which keeps the migration replayable everywhere.
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;
