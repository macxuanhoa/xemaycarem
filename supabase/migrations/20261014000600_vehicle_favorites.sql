-- Migration: 20261014000600_vehicle_favorites.sql
-- Description: "Xe yêu thích" — a personal star list per account (STAFF/MANAGER/OWNER).
--   * vehicle_favorites is user-scoped state, not business data: every account keeps
--     its own stars, RLS exposes only the owner's rows, and the browser never writes
--     the table directly — toggling goes through toggle_vehicle_favorite().
--   * list_vehicles gains p_filters.favorite ('true' = only my starred vehicles) and
--     every vehicle projection (list + get_vehicle) now carries `is_favorite` for the
--     calling user, so cards/detail/3-dot menu render the star without extra queries.
--   * Favorite rows cascade with the vehicle (hard purge) and with a purged profile.
--     No audit trail: a star is a personal view preference, like notification reads.

BEGIN;

CREATE TABLE IF NOT EXISTS public.vehicle_favorites (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, vehicle_id)
);

-- The PK serves "my favorites"; this side index serves vehicle-side cascade deletes
-- and the per-row `is_favorite` probe from list projections.
CREATE INDEX IF NOT EXISTS vehicle_favorites_vehicle_idx
  ON public.vehicle_favorites (vehicle_id);

ALTER TABLE public.vehicle_favorites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS favorites_own_read ON public.vehicle_favorites;
CREATE POLICY favorites_own_read ON public.vehicle_favorites
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.vehicle_favorites FROM public, anon, authenticated;
GRANT SELECT ON public.vehicle_favorites TO authenticated;

-- Toggle for the signed-in account. Stable result contract: {vehicle_id, favorite}.
CREATE OR REPLACE FUNCTION public.toggle_vehicle_favorite(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_favorite boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.vehicles WHERE id = p_vehicle_id) THEN
    RAISE EXCEPTION USING errcode='P0002', message='VEHICLE_NOT_FOUND';
  END IF;
  DELETE FROM public.vehicle_favorites WHERE user_id = v_actor AND vehicle_id = p_vehicle_id;
  IF FOUND THEN
    v_favorite := false;
  ELSE
    BEGIN
      INSERT INTO public.vehicle_favorites(user_id, vehicle_id) VALUES (v_actor, p_vehicle_id);
    EXCEPTION WHEN foreign_key_violation THEN
      -- The vehicle was purged in the same instant the star was filed.
      RAISE EXCEPTION USING errcode='P0002', message='VEHICLE_NOT_FOUND';
    END;
    v_favorite := true;
  END IF;
  RETURN jsonb_build_object('vehicle_id', p_vehicle_id, 'favorite', v_favorite);
END $$;

-- list_vehicles: favorite filter + per-user is_favorite on every item.
-- Body is the state from 20261008000300 with the favorite column/keys added.
CREATE OR REPLACE FUNCTION public.list_vehicles(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_sort text:=coalesce(p_filters->>'sort','newest');
  v_type_name text:=nullif(btrim(coalesce(p_filters->>'vehicle_type','')),'');
  v_type uuid:=nullif(nullif(coalesce(p_filters->>'vehicle_type_id',''),'')::text,'')::uuid;
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if nullif(p_filters->>'min_days','') is not null and (p_filters->>'min_days')::integer not between 0 and 36500 then raise exception using errcode='22023',message='INVALID_STOCK_AGE'; end if;
  if v_sort='highest_cost' and not private.can_financials() then raise exception using errcode='42501',message='FINANCIAL_ACCESS_DENIED'; end if;
  if v_type is null and v_type_name is not null then
    select id into v_type from public.vehicle_types where lower(btrim(name))=lower(v_type_name);
    if v_type is null then raise exception using errcode='22023',message='INVALID_VEHICLE_TYPE'; end if;
  end if;
  with matching as (
    select v.* from public.vehicles v
    left join public.vehicle_types t on t.id=v.vehicle_type_id
    where
      not exists (select 1 from public.approval_requests ar
                  where ar.subject_id = v.id and ar.kind = 'VEHICLE_DELETION' and ar.status = 'PENDING') and
      (nullif(p_filters->>'status','') is null or p_filters->>'status'='ALL' or v.status::text=p_filters->>'status' or (p_filters->>'status' in ('AVAILABLE','UNSOLD') and v.status in ('IN_STOCK','RESERVED'))) and
      (not coalesce(nullif(p_filters->>'favorite','')::boolean,false) or exists(select 1 from public.vehicle_favorites fv where fv.vehicle_id=v.id and fv.user_id=v_actor)) and
      (nullif(p_filters->>'min_days','') is null or (v.status in ('IN_STOCK','RESERVED') and private.today()-v.purchase_date >= (p_filters->>'min_days')::integer)) and
      (not coalesce(nullif(p_filters->>'cost_pending','')::boolean,false) or exists(select 1 from public.vehicle_financials vf where vf.vehicle_id=v.id and vf.purchase_price is null)) and
      (v_type is null or v.vehicle_type_id=v_type) and
      (nullif(p_filters->>'year','') is null or v.year=(p_filters->>'year')::integer) and
      (nullif(p_filters->>'date_from','') is null or v.purchase_date>=(p_filters->>'date_from')::date) and
      (nullif(p_filters->>'date_to','') is null or v.purchase_date<=(p_filters->>'date_to')::date) and
      (v_search='' or concat_ws(' ',v.internal_code,v.license_plate,v.frame_number,v.color,t.name) ilike '%'||v_search||'%'
        or exists(select 1 from public.sales s where s.vehicle_id=v.id and s.customer_phone ilike '%'||v_search||'%'))
  ), ordered as (
    select m.id,row_number() over(order by
      case when v_sort='oldest' then m.created_at end asc,
      case when v_sort='longest_stock' then case when m.status in ('IN_STOCK','RESERVED') then m.purchase_date end end asc nulls last,
      case when v_sort='highest_cost' then f.purchase_price+(select coalesce(sum(amount),0) from public.vehicle_expenses e where e.vehicle_id=m.id and e.status='ACTIVE') end desc nulls last,
      m.created_at desc,m.id) as ord
    from matching m left join public.vehicle_financials f on f.vehicle_id=m.id
    order by ord
    limit v_limit offset v_offset
  )
  select (select count(*) from matching),coalesce((select jsonb_agg(
    private.vehicle_json(v)||jsonb_build_object('is_favorite',
      exists(select 1 from public.vehicle_favorites fv where fv.vehicle_id=v.id and fv.user_id=v_actor))
    order by o.ord) from ordered o join public.vehicles v on v.id=o.id),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

-- get_vehicle: same per-user star on the detail projection (body from 20261008000200).
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
  return private.vehicle_json(v_vehicle)||jsonb_build_object(
    'images',v_images,'expenses',v_expenses,'sales',v_sales,'activity',v_activity,
    'pending_deletion',v_pending,
    'is_favorite',exists(select 1 from public.vehicle_favorites fv where fv.vehicle_id=p_id and fv.user_id=v_actor));
end $$;

REVOKE ALL ON FUNCTION public.toggle_vehicle_favorite(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_vehicle_favorite(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_vehicle_favorite(uuid) TO service_role;

COMMIT;
