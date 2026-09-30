create function private.vehicle_json(p_vehicle public.vehicles) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_purchase bigint; v_expenses bigint; v_result jsonb; v_end date;
begin
  select purchase_price into v_purchase from public.vehicle_financials where vehicle_id=p_vehicle.id;
  if p_vehicle.status='SOLD' then select sale_date into v_end from public.sales where vehicle_id=p_vehicle.id and status='COMPLETED'; end if;
  v_result:=to_jsonb(p_vehicle)||jsonb_build_object('cost_pending',v_purchase is null,'days_in_inventory',greatest(0,coalesce(v_end,private.today())-p_vehicle.purchase_date));
  if private.can_financials() then
    select private.safe_money(coalesce(sum(amount),0)) into v_expenses from public.vehicle_expenses where vehicle_id=p_vehicle.id and status='ACTIVE';
    v_result:=v_result||jsonb_build_object('purchase_price',v_purchase,'expense_total',v_expenses,'total_cost',private.safe_money(v_purchase::numeric+v_expenses));
  end if;
  return v_result;
end $$;

create function private.sale_json(p_sale public.sales) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_vehicle public.vehicles; v_paid bigint; v_result jsonb; v_fin public.sale_financials;
begin
  select * into v_vehicle from public.vehicles where id=p_sale.vehicle_id;
  select private.safe_money(coalesce(sum(amount),0)) into v_paid from public.payments where sale_id=p_sale.id and status='ACTIVE';
  v_result:=to_jsonb(p_sale)||jsonb_build_object('vehicle',to_jsonb(v_vehicle),'vehicle_code',v_vehicle.internal_code,'vehicle_name',v_vehicle.brand||' '||v_vehicle.model,
    'internal_code',v_vehicle.internal_code,'brand',v_vehicle.brand,'model',v_vehicle.model,
    'license_plate',v_vehicle.license_plate,'paid_amount',v_paid,'remaining_amount',case when p_sale.status='COMPLETED' then p_sale.sale_price-v_paid else 0 end);
  if private.can_financials() then
    select * into v_fin from public.sale_financials where sale_id=p_sale.id;
    v_result:=v_result||jsonb_build_object('purchase_cost_snapshot',v_fin.purchase_cost_snapshot,'expense_cost_snapshot',v_fin.expense_cost_snapshot,'total_cost_snapshot',v_fin.total_cost_snapshot,'gross_profit',v_fin.gross_profit);
  end if;
  return v_result;
end $$;

create function public.list_vehicles(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_sort text:=coalesce(p_filters->>'sort','newest');
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if v_sort='highest_cost' and not private.can_financials() then raise exception using errcode='42501',message='FINANCIAL_ACCESS_DENIED'; end if;
  with matching as (
    select v.* from public.vehicles v where
      (nullif(p_filters->>'status','') is null or p_filters->>'status'='ALL' or v.status::text=p_filters->>'status' or (p_filters->>'status' in ('AVAILABLE','UNSOLD') and v.status in ('IN_STOCK','RESERVED'))) and
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

create function public.get_sale(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_sale public.sales; v_payments jsonb;
begin
  select * into v_sale from public.sales where id=p_id;
  if not found then raise exception using errcode='P0002',message='SALE_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.payment_date,p.created_at),'[]'::jsonb) into v_payments from public.payments p where sale_id=p_id;
  return private.sale_json(v_sale)||jsonb_build_object('payments',v_payments);
end $$;

create function public.get_vehicle(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
end $$;

create function public.list_sales(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
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
end $$;

create function public.list_expenses(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER']::public.user_role[]);
  v_from date:=coalesce(nullif(p_filters->>'from',''),nullif(p_filters->>'date_from',''))::date;
  v_to date:=coalesce(nullif(p_filters->>'to',''),nullif(p_filters->>'date_to',''))::date;
  v_kind text:=coalesce(p_filters->>'kind','all');
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if v_from>v_to then raise exception using errcode='22023',message='INVALID_DATE_RANGE'; end if;
  with combined as (
    select e.id,e.expense_date,e.created_at,e.status,e.description,to_jsonb(e)||jsonb_build_object('kind','vehicle','vehicle_code',v.internal_code,'internal_code',v.internal_code,'vehicle_name',v.brand||' '||v.model) as data
    from public.vehicle_expenses e join public.vehicles v on v.id=e.vehicle_id where v_kind in ('all','vehicle')
    union all
    select e.id,e.expense_date,e.created_at,e.status,e.description,to_jsonb(e)||jsonb_build_object('kind','business') from public.business_expenses e where v_kind in ('all','business')
  ), matching as (
    select * from combined where (v_from is null or expense_date>=v_from) and (v_to is null or expense_date<=v_to)
      and (nullif(p_filters->>'status','') is null or status::text=p_filters->>'status') and (v_search='' or description ilike '%'||v_search||'%')
      and (nullif(p_filters->>'vehicle_id','') is null or data->>'vehicle_id'=p_filters->>'vehicle_id')
  ), paged as (select * from matching order by expense_date desc,created_at desc,id limit v_limit offset v_offset)
  select (select count(*) from matching),coalesce((select jsonb_agg(data order by expense_date desc,created_at desc,id) from paged),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create function public.list_profiles() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=private.require_role(array['OWNER']::public.user_role[]); v_result jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('email',u.email) order by p.created_at),'[]'::jsonb) into v_result
  from public.profiles p join auth.users u on u.id=p.id;
  return v_result;
end $$;

create function public.get_settings() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]); v_result jsonb;
begin select to_jsonb(s) into v_result from public.system_settings s where id; return v_result; end $$;

create function public.list_audit(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER']::public.user_role[]);
  v_from date:=coalesce(nullif(p_filters->>'from',''),nullif(p_filters->>'date_from',''))::date;
  v_to date:=coalesce(nullif(p_filters->>'to',''),nullif(p_filters->>'date_to',''))::date;
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if v_from>v_to then raise exception using errcode='22023',message='INVALID_DATE_RANGE'; end if;
  with matching as (
    select a.*,p.full_name as actor_name from public.audit_logs a left join public.profiles p on p.id=a.user_id
    where (v_from is null or a.created_at>=(v_from::timestamp at time zone 'Asia/Ho_Chi_Minh'))
      and (v_to is null or a.created_at<((v_to+1)::timestamp at time zone 'Asia/Ho_Chi_Minh'))
      and (nullif(p_filters->>'entity_id','') is null or a.entity_id=(p_filters->>'entity_id')::uuid)
      and (nullif(p_filters->>'action','') is null or a.action=p_filters->>'action')
      and (v_search='' or concat_ws(' ',a.action,a.entity_type,p.full_name) ilike '%'||v_search||'%')
  ), paged as (select * from matching order by created_at desc,id desc limit v_limit offset v_offset)
  select (select count(*) from matching),coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from paged p),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create function public.report(p_kind text,p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=private.require_role(array['OWNER','MANAGER']::public.user_role[]); v_filters jsonb;
begin
  if p_kind='profit' and not private.can_financials() then raise exception using errcode='42501',message='FINANCIAL_ACCESS_DENIED'; end if;
  v_filters:=p_filters||jsonb_build_object('status','COMPLETED');
  if p_kind in ('sales','profit') then return public.list_sales(v_filters);
  elsif p_kind='inventory' then
    -- Inventory report reflects current stock. Date range filters intake date.
    return public.list_vehicles(p_filters||jsonb_build_object('status',coalesce(p_filters->>'status','UNSOLD'),'date_from',coalesce(p_filters->>'from',p_filters->>'date_from'),'date_to',coalesce(p_filters->>'to',p_filters->>'date_to')));
  elsif p_kind='vehicle_expenses' then return public.list_expenses(p_filters||jsonb_build_object('kind','vehicle','status','ACTIVE'));
  elsif p_kind='business_expenses' then return public.list_expenses(p_filters||jsonb_build_object('kind','business','status','ACTIVE'));
  else raise exception using errcode='22023',message='INVALID_REPORT_KIND';
  end if;
end $$;

create function public.dashboard(p_from date default date_trunc('month',now() at time zone 'Asia/Ho_Chi_Minh')::date,p_to date default (now() at time zone 'Asia/Ho_Chi_Minh')::date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF','VIEWER']::public.user_role[]);
  v_fin boolean:=private.can_financials(); v_manage boolean:=private.current_role() in ('OWNER','MANAGER');
  v_today date:=private.today(); v_month date:=date_trunc('month',private.today())::date; v_result jsonb; v_part jsonb;
begin
  if p_from is null or p_to is null or p_from>p_to then raise exception using errcode='22023',message='INVALID_DATE_RANGE'; end if;
  select jsonb_build_object('in_stock',count(*) filter(where status='IN_STOCK'),'reserved',count(*) filter(where status='RESERVED'),
    'inventory_cost_pending',count(*) filter(where v.status in ('IN_STOCK','RESERVED') and f.purchase_price is null),
    'inventory_cost',case when v_fin and count(*) filter(where v.status in ('IN_STOCK','RESERVED') and f.purchase_price is null)=0
      then private.safe_money(coalesce(sum(f.purchase_price::numeric+coalesce(e.expenses,0)) filter(where v.status in ('IN_STOCK','RESERVED')),0)) else null end)
  into v_result from public.vehicles v left join public.vehicle_financials f on f.vehicle_id=v.id
    left join lateral(select sum(amount) as expenses from public.vehicle_expenses where vehicle_id=v.id and status='ACTIVE') e on true;
  select jsonb_build_object('inventory_indicator',case
    when (v_result->>'in_stock')::integer+(v_result->>'reserved')::integer<low_stock_threshold then 'LOW'
    when (v_result->>'in_stock')::integer+(v_result->>'reserved')::integer>high_stock_threshold then 'HIGH'
    else 'NORMAL' end) into v_part from public.system_settings where id;
  v_result:=v_result||v_part;
  select jsonb_build_object(
    'sold_today',count(*) filter(where sale_date=v_today),'sold_month',count(*) filter(where sale_date between v_month and v_today),
    'sales_count',count(*) filter(where sale_date between p_from and p_to),
    'today_revenue',case when v_manage then private.safe_money(coalesce(sum(sale_price) filter(where sale_date=v_today),0)) else null end,
    'month_revenue',case when v_manage then private.safe_money(coalesce(sum(sale_price) filter(where sale_date between v_month and v_today),0)) else null end,
    'revenue',case when v_manage then private.safe_money(coalesce(sum(sale_price) filter(where sale_date between p_from and p_to),0)) else null end,
    'today_profit',case when v_fin then private.safe_money(coalesce(sum(gross_profit) filter(where sale_date=v_today),0)) else null end,
    'month_profit',case when v_fin then private.safe_money(coalesce(sum(gross_profit) filter(where sale_date between v_month and v_today),0)) else null end,
    'gross_profit',case when v_fin then private.safe_money(coalesce(sum(gross_profit) filter(where sale_date between p_from and p_to),0)) else null end)
  into v_part from public.sales s join public.sale_financials f on f.sale_id=s.id where status='COMPLETED';
  v_result:=v_result||v_part;
  select jsonb_build_object('business_expenses',case when v_manage then private.safe_money(coalesce(sum(amount),0)) else null end)
    into v_part from public.business_expenses where status='ACTIVE' and expense_date between p_from and p_to;
  v_result:=v_result||v_part;
  v_result:=v_result||jsonb_build_object('recent_sales',public.list_sales(jsonb_build_object('limit',5,'from',p_from,'to',p_to,'status','COMPLETED'))->'items','recent_vehicles',public.list_vehicles(jsonb_build_object('limit',5))->'items');
  if v_manage then v_result:=v_result||jsonb_build_object('recent_expenses',public.list_expenses(jsonb_build_object('limit',5,'from',p_from,'to',p_to,'status','ACTIVE'))->'items');
  else v_result:=v_result||jsonb_build_object('recent_expenses','[]'::jsonb); end if;
  select jsonb_build_object('aging',jsonb_build_array(
    jsonb_build_object('bucket','0–29','count',count(*) filter(where v_today-purchase_date<30)),
    jsonb_build_object('bucket','30–59','count',count(*) filter(where v_today-purchase_date between 30 and 59)),
    jsonb_build_object('bucket','60–89','count',count(*) filter(where v_today-purchase_date between 60 and 89)),
    jsonb_build_object('bucket','90+','count',count(*) filter(where v_today-purchase_date>=90)))) into v_part from public.vehicles where status in ('IN_STOCK','RESERVED');
  v_result:=v_result||v_part;
  select coalesce(jsonb_agg(private.vehicle_json(v) order by v.purchase_date,v.created_at),'[]'::jsonb) into v_part from public.vehicles v where v.id in(select id from public.vehicles where status in ('IN_STOCK','RESERVED') order by purchase_date,created_at limit 5);
  v_result:=v_result||jsonb_build_object('longest_stock',v_part);
  v_part:='[]'::jsonb;
  if v_fin then
    select coalesce(jsonb_agg(private.sale_json(s) order by f.gross_profit desc),'[]'::jsonb) into v_part from public.sales s join public.sale_financials f on f.sale_id=s.id
    where s.id in(select ss.id from public.sales ss join public.sale_financials ff on ff.sale_id=ss.id where ss.status='COMPLETED' and ss.sale_date between p_from and p_to order by ff.gross_profit desc limit 5);
  end if;
  v_result:=v_result||jsonb_build_object('top_profitable',v_part);
  select coalesce(jsonb_agg(to_jsonb(d) order by d.date),'[]'::jsonb) into v_part from (
    select s.sale_date as date,count(*) as count,case when v_manage then private.safe_money(sum(s.sale_price)) else null end as revenue,
      case when v_fin then private.safe_money(sum(f.gross_profit)) else null end as gross_profit
    from public.sales s join public.sale_financials f on f.sale_id=s.id where s.status='COMPLETED' and s.sale_date between p_from and p_to group by s.sale_date
  ) d;
  return v_result||jsonb_build_object('daily_sales',v_part);
end $$;
