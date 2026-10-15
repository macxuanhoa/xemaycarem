-- Kho xe: thẻ mobile dựng theo layout ngang cần ảnh đại diện thật, nhưng projection
-- của list_vehicles (private.vehicle_json) chưa từng chứa đường dẫn ảnh — chỉ
-- get_vehicle mới có mảng `images`. Migration forward-only này CHỈ thêm một trường
-- `primary_image_path` vào từng item của DANH SÁCH (không đụng private.vehicle_json,
-- nên get_vehicle và mọi mask tài chính giữ nguyên). Client ký URL qua storage
-- gateway (api.imageUrl); DB không bao giờ chứa URL.
--
-- Body dưới đây sao nguyên trạng thái mới nhất (20261014000600_vehicle_favorites.sql),
-- chỉ đổi đúng biểu thức dựng jsonb item để ghép thêm khóa primary_image_path:
-- ảnh chưa soft-delete có display_order nhỏ nhất (fallback created_at), NULL nếu không có.
-- storage_path là đường dẫn tương đối trong bucket riêng tư vehicle-images, không nhạy
-- cảm; quyền đọc ảnh vẫn do storage policy + signed URL ngắn hạn kiểm soát.

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
    private.vehicle_json(v)||jsonb_build_object(
      'is_favorite',
        exists(select 1 from public.vehicle_favorites fv where fv.vehicle_id=v.id and fv.user_id=v_actor),
      'primary_image_path',
        (select i.storage_path from public.vehicle_images i
          where i.vehicle_id=v.id and i.deleted_at is null
          order by i.display_order, i.created_at limit 1))
    order by o.ord) from ordered o join public.vehicles v on v.id=o.id),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;
