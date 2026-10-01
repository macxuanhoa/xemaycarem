create function public.save_vehicle(p_data jsonb,p_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.vehicles; v_new public.vehicles; v_purchase bigint; v_old_purchase bigint;
  v_status public.vehicle_status; v_date date; v_old_json jsonb;
begin
  if jsonb_typeof(p_data)<>'object' then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  if p_data ? 'purchase_price' and not private.can_financials() then raise exception using errcode='42501',message='FINANCIAL_ACCESS_DENIED'; end if;
  if p_id is not null then
    select * into v_old from public.vehicles where id=p_id for update;
    if not found then raise exception using errcode='P0002',message='VEHICLE_NOT_FOUND'; end if;
    select purchase_price into v_old_purchase from public.vehicle_financials where vehicle_id=p_id;
  end if;
  v_status:=coalesce((p_data->>'status')::public.vehicle_status,v_old.status,'IN_STOCK');
  if v_status='SOLD' and (p_id is null or v_old.status<>'SOLD') then raise exception using errcode='22023',message='USE_SELL_VEHICLE'; end if;
  if (v_status='CANCELLED' or v_old.status='CANCELLED') and private.current_role()='STAFF' then raise exception using errcode='42501',message='ACCESS_DENIED'; end if;
  v_purchase:=private.money_input(p_data,'purchase_price',v_old_purchase);
  v_date:=coalesce((p_data->>'purchase_date')::date,v_old.purchase_date,private.today());
  if v_date>private.today() then raise exception using errcode='22023',message='FUTURE_DATE'; end if;
  if p_id is not null and exists(select 1 from public.vehicle_expenses where vehicle_id=p_id and status='ACTIVE' and expense_date<v_date) then
    raise exception using errcode='22023',message='PURCHASE_AFTER_EXPENSE';
  end if;
  if v_old.status='SOLD' and (v_status<>'SOLD' or v_purchase is distinct from v_old_purchase
      or v_date<>v_old.purchase_date or private.money_input(p_data,'asking_price',v_old.asking_price)<>v_old.asking_price) then
    raise exception using errcode='22023',message='SOLD_VEHICLE_LOCKED';
  end if;
  if p_id is null then
    insert into public.vehicles(license_plate,brand,model,variant,year,color,frame_number,engine_number,odometer,purchase_date,asking_price,status,supplier_name,supplier_phone,notes,created_by)
    values(btrim(coalesce(p_data->>'license_plate','')),btrim(p_data->>'brand'),btrim(p_data->>'model'),btrim(coalesce(p_data->>'variant','')),
      nullif(p_data->>'year','')::integer,btrim(coalesce(p_data->>'color','')),btrim(coalesce(p_data->>'frame_number','')),btrim(coalesce(p_data->>'engine_number','')),
      coalesce(nullif(p_data->>'odometer','')::integer,0),v_date,private.money_input(p_data,'asking_price'),v_status,
      btrim(coalesce(p_data->>'supplier_name','')),btrim(coalesce(p_data->>'supplier_phone','')),coalesce(p_data->>'notes',''),v_actor) returning * into v_new;
    insert into public.vehicle_financials(vehicle_id,purchase_price,updated_by) values(v_new.id,v_purchase,v_actor);
    perform private.audit('CREATE_VEHICLE','vehicles',v_new.id,null,to_jsonb(v_new)||jsonb_build_object('purchase_price',v_purchase),v_new.id);
  else
    v_old_json:=to_jsonb(v_old)||jsonb_build_object('purchase_price',v_old_purchase);
    update public.vehicles set
      license_plate=btrim(coalesce(p_data->>'license_plate',license_plate)), brand=btrim(coalesce(p_data->>'brand',brand)), model=btrim(coalesce(p_data->>'model',model)),
      variant=btrim(coalesce(p_data->>'variant',variant)), year=case when p_data ? 'year' then nullif(p_data->>'year','')::integer else year end,
      color=btrim(coalesce(p_data->>'color',color)),frame_number=btrim(coalesce(p_data->>'frame_number',frame_number)),engine_number=btrim(coalesce(p_data->>'engine_number',engine_number)),
      odometer=coalesce(nullif(p_data->>'odometer','')::integer,odometer),purchase_date=v_date,asking_price=private.money_input(p_data,'asking_price',asking_price),status=v_status,
      supplier_name=btrim(coalesce(p_data->>'supplier_name',supplier_name)),supplier_phone=btrim(coalesce(p_data->>'supplier_phone',supplier_phone)),notes=coalesce(p_data->>'notes',notes),updated_at=now()
    where id=p_id returning * into v_new;
    if v_purchase is distinct from v_old_purchase then
      update public.vehicle_financials set purchase_price=v_purchase,updated_by=v_actor,updated_at=now() where vehicle_id=p_id;
    end if;
    perform private.audit('UPDATE_VEHICLE','vehicles',p_id,v_old_json,to_jsonb(v_new)||jsonb_build_object('purchase_price',v_purchase),p_id);
  end if;
  return v_new.id;
end $$;

create function public.save_expense(p_kind text,p_data jsonb,p_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER']::public.user_role[]);
  v_id uuid; v_vehicle_id uuid; v_vehicle public.vehicles; v_old jsonb; v_new jsonb; v_date date;
begin
  if jsonb_typeof(p_data)<>'object' then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  if p_kind='vehicle' then
    if p_id is not null then
      select vehicle_id into v_vehicle_id from public.vehicle_expenses where id=p_id;
      if not found then raise exception using errcode='P0002',message='EXPENSE_NOT_FOUND'; end if;
    else v_vehicle_id:=(p_data->>'vehicle_id')::uuid;
    end if;
    select * into v_vehicle from public.vehicles where id=v_vehicle_id for update;
    if not found then raise exception using errcode='P0002',message='VEHICLE_NOT_FOUND'; end if;
    if v_vehicle.status not in ('IN_STOCK','RESERVED') then raise exception using errcode='22023',message='VEHICLE_EXPENSE_LOCKED'; end if;
    if p_data ? 'vehicle_id' and (p_data->>'vehicle_id')::uuid<>v_vehicle_id then raise exception using errcode='22023',message='EXPENSE_VEHICLE_IMMUTABLE'; end if;
    if p_id is not null then
      select to_jsonb(e) into v_old from public.vehicle_expenses e where id=p_id for update;
      if v_old->>'status'<>'ACTIVE' then raise exception using errcode='22023',message='EXPENSE_CANCELLED'; end if;
    end if;
    v_date:=coalesce((p_data->>'expense_date')::date,(v_old->>'expense_date')::date,private.today());
    if v_date>private.today() or v_date<v_vehicle.purchase_date then raise exception using errcode='22023',message='INVALID_EXPENSE_DATE'; end if;
    if p_id is null then
      insert into public.vehicle_expenses(vehicle_id,expense_type,description,amount,expense_date,created_by)
      values(v_vehicle_id,(p_data->>'expense_type')::public.vehicle_expense_type,btrim(p_data->>'description'),private.money_input(p_data,'amount'),v_date,v_actor)
      returning id,to_jsonb(vehicle_expenses) into v_id,v_new;
    else
      update public.vehicle_expenses set expense_type=coalesce((p_data->>'expense_type')::public.vehicle_expense_type,expense_type),
        description=btrim(coalesce(p_data->>'description',description)),amount=private.money_input(p_data,'amount',amount),expense_date=v_date,updated_at=now()
      where id=p_id returning id,to_jsonb(vehicle_expenses) into v_id,v_new;
    end if;
  elsif p_kind='business' then
    if p_id is not null then
      select to_jsonb(e) into v_old from public.business_expenses e where id=p_id for update;
      if not found then raise exception using errcode='P0002',message='EXPENSE_NOT_FOUND'; end if;
      if v_old->>'status'<>'ACTIVE' then raise exception using errcode='22023',message='EXPENSE_CANCELLED'; end if;
    end if;
    v_date:=coalesce((p_data->>'expense_date')::date,(v_old->>'expense_date')::date,private.today());
    if v_date>private.today() then raise exception using errcode='22023',message='FUTURE_DATE'; end if;
    if p_id is null then
      insert into public.business_expenses(category,description,amount,expense_date,created_by)
      values((p_data->>'category')::public.business_expense_category,btrim(p_data->>'description'),private.money_input(p_data,'amount'),v_date,v_actor)
      returning id,to_jsonb(business_expenses) into v_id,v_new;
    else
      update public.business_expenses set category=coalesce((p_data->>'category')::public.business_expense_category,category),
        description=btrim(coalesce(p_data->>'description',description)),amount=private.money_input(p_data,'amount',amount),expense_date=v_date,updated_at=now()
      where id=p_id returning id,to_jsonb(business_expenses) into v_id,v_new;
    end if;
  else raise exception using errcode='22023',message='INVALID_EXPENSE_KIND';
  end if;
  perform private.audit(case when p_id is null then 'ADD_EXPENSE' else 'UPDATE_EXPENSE' end,p_kind||'_expenses',v_id,v_old,v_new,v_vehicle_id);
  return v_id;
end $$;

create function public.cancel_expense(p_kind text,p_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER']::public.user_role[]);
  v_vehicle uuid; v_status public.vehicle_status; v_old jsonb; v_new jsonb;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 1000 then raise exception using errcode='22023',message='CANCELLATION_REASON_REQUIRED'; end if;
  if p_kind='vehicle' then
    select vehicle_id into v_vehicle from public.vehicle_expenses where id=p_id;
    if not found then raise exception using errcode='P0002',message='EXPENSE_NOT_FOUND'; end if;
    select status into v_status from public.vehicles where id=v_vehicle for update;
    if v_status not in ('IN_STOCK','RESERVED') then raise exception using errcode='22023',message='VEHICLE_EXPENSE_LOCKED'; end if;
    select to_jsonb(e) into v_old from public.vehicle_expenses e where id=p_id for update;
    if v_old->>'status'<>'ACTIVE' then raise exception using errcode='22023',message='EXPENSE_CANCELLED'; end if;
    update public.vehicle_expenses set status='CANCELLED',cancellation_reason=btrim(p_reason),cancelled_at=now(),cancelled_by=v_actor,updated_at=now()
    where id=p_id returning to_jsonb(vehicle_expenses) into v_new;
  elsif p_kind='business' then
    select to_jsonb(e) into v_old from public.business_expenses e where id=p_id for update;
    if not found then raise exception using errcode='P0002',message='EXPENSE_NOT_FOUND'; end if;
    if v_old->>'status'<>'ACTIVE' then raise exception using errcode='22023',message='EXPENSE_CANCELLED'; end if;
    update public.business_expenses set status='CANCELLED',cancellation_reason=btrim(p_reason),cancelled_at=now(),cancelled_by=v_actor,updated_at=now()
    where id=p_id returning to_jsonb(business_expenses) into v_new;
  else raise exception using errcode='22023',message='INVALID_EXPENSE_KIND';
  end if;
  perform private.audit('CANCEL_EXPENSE',p_kind||'_expenses',p_id,v_old,v_new,v_vehicle);
end $$;

create function public.sell_vehicle(p_data jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles; v_sale public.sales; v_purchase bigint; v_expenses bigint;
  v_price bigint:=private.money_input(p_data,'sale_price');
  v_initial bigint:=private.money_input(p_data,'initial_payment',0);
  v_date date:=coalesce((p_data->>'sale_date')::date,private.today());
  v_payment public.payments;
begin
  select * into v_vehicle from public.vehicles where id=(p_data->>'vehicle_id')::uuid for update;
  if not found then raise exception using errcode='P0002',message='VEHICLE_NOT_FOUND'; end if;
  if v_vehicle.status not in ('IN_STOCK','RESERVED') then raise exception using errcode='22023',message='VEHICLE_NOT_AVAILABLE'; end if;
  if v_date<v_vehicle.purchase_date or v_date>private.today() then raise exception using errcode='22023',message='INVALID_SALE_DATE'; end if;
  if v_price is null or v_initial>v_price then raise exception using errcode='22023',message='INVALID_PAYMENT'; end if;
  if exists(select 1 from public.vehicle_expenses where vehicle_id=v_vehicle.id and status='ACTIVE' and expense_date>v_date) then
    raise exception using errcode='22023',message='SALE_BEFORE_EXPENSE';
  end if;
  select purchase_price into v_purchase from public.vehicle_financials where vehicle_id=v_vehicle.id;
  if v_purchase is null then raise exception using errcode='22023',message='PURCHASE_COST_REQUIRED'; end if;
  select private.safe_money(coalesce(sum(amount),0)) into v_expenses from public.vehicle_expenses where vehicle_id=v_vehicle.id and status='ACTIVE';
  perform private.safe_money(v_purchase::numeric+v_expenses);
  insert into public.sales(vehicle_id,customer_name,customer_phone,sale_price,sale_date,sold_by,notes)
  values(v_vehicle.id,btrim(p_data->>'customer_name'),btrim(coalesce(p_data->>'customer_phone','')),v_price,v_date,v_actor,coalesce(p_data->>'notes','')) returning * into v_sale;
  insert into public.sale_financials(sale_id,purchase_cost_snapshot,expense_cost_snapshot,sale_price_snapshot) values(v_sale.id,v_purchase,v_expenses,v_price);
  if v_initial>0 then
    insert into public.payments(sale_id,amount,payment_method,payment_date,created_by)
    values(v_sale.id,v_initial,coalesce((p_data->>'payment_method')::public.payment_method,'CASH'),v_date,v_actor) returning * into v_payment;
    perform private.audit('CREATE_PAYMENT','payments',v_payment.id,null,to_jsonb(v_payment),v_vehicle.id);
  end if;
  update public.vehicles set status='SOLD',updated_at=now() where id=v_vehicle.id;
  perform private.audit('CREATE_SALE','sales',v_sale.id,null,to_jsonb(v_sale)||jsonb_build_object('purchase_cost_snapshot',v_purchase,'expense_cost_snapshot',v_expenses,'total_cost_snapshot',v_purchase+v_expenses,'gross_profit',v_price-v_purchase-v_expenses),v_vehicle.id);
  return v_sale.id;
end $$;

create function public.add_payment(p_data jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_sale_id uuid:=(p_data->>'sale_id')::uuid; v_vehicle uuid; v_sale public.sales; v_payment public.payments; v_paid bigint;
  v_amount bigint:=private.money_input(p_data,'amount');
  v_date date:=coalesce((p_data->>'payment_date')::date,private.today());
begin
  select vehicle_id into v_vehicle from public.sales where id=v_sale_id;
  if not found then raise exception using errcode='P0002',message='SALE_NOT_FOUND'; end if;
  perform 1 from public.vehicles where id=v_vehicle for update;
  select * into v_sale from public.sales where id=v_sale_id for update;
  if v_sale.status<>'COMPLETED' then raise exception using errcode='22023',message='SALE_CANCELLED'; end if;
  if v_date<v_sale.sale_date or v_date>private.today() then raise exception using errcode='22023',message='INVALID_PAYMENT_DATE'; end if;
  select private.safe_money(coalesce(sum(amount),0)) into v_paid from public.payments where sale_id=v_sale_id and status='ACTIVE';
  if v_amount is null or v_amount<=0 or v_paid+v_amount>v_sale.sale_price then raise exception using errcode='22023',message='PAYMENT_EXCEEDS_BALANCE'; end if;
  insert into public.payments(sale_id,amount,payment_method,payment_date,reference,notes,created_by)
  values(v_sale_id,v_amount,(p_data->>'payment_method')::public.payment_method,v_date,coalesce(p_data->>'reference',''),coalesce(p_data->>'notes',''),v_actor) returning * into v_payment;
  perform private.audit('CREATE_PAYMENT','payments',v_payment.id,null,to_jsonb(v_payment),v_vehicle);
  return v_payment.id;
end $$;

create function public.cancel_sale(p_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER']::public.user_role[]);
  v_vehicle uuid; v_old public.sales; v_new public.sales; v_payment public.payments;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 1000 then raise exception using errcode='22023',message='CANCELLATION_REASON_REQUIRED'; end if;
  select vehicle_id into v_vehicle from public.sales where id=p_id;
  if not found then raise exception using errcode='P0002',message='SALE_NOT_FOUND'; end if;
  perform 1 from public.vehicles where id=v_vehicle for update;
  select * into v_old from public.sales where id=p_id for update;
  if v_old.status<>'COMPLETED' then raise exception using errcode='22023',message='SALE_ALREADY_CANCELLED'; end if;
  update public.sales set status='CANCELLED',cancelled_by=v_actor,cancelled_at=now(),cancellation_reason=btrim(p_reason),updated_at=now() where id=p_id returning * into v_new;
  for v_payment in select * from public.payments where sale_id=p_id and status='ACTIVE' loop
    update public.payments set status='VOIDED',voided_at=now(),voided_by=v_actor where id=v_payment.id;
    perform private.audit('VOID_PAYMENT','payments',v_payment.id,to_jsonb(v_payment),to_jsonb(v_payment)||jsonb_build_object('status','VOIDED','voided_at',now(),'voided_by',v_actor),v_vehicle);
  end loop;
  update public.vehicles set status='IN_STOCK',updated_at=now() where id=v_vehicle;
  perform private.audit('CANCEL_SALE','sales',p_id,to_jsonb(v_old),to_jsonb(v_new),v_vehicle);
end $$;

create function public.update_profile(p_id uuid,p_data jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.profiles; v_new public.profiles; v_role public.user_role; v_active boolean; v_fin boolean;
begin
  -- Serialize all role/status transitions so simultaneous demotions cannot remove every owner.
  perform pg_advisory_xact_lock(761482190);
  select * into v_old from public.profiles where id=p_id for update;
  if not found then raise exception using errcode='P0002',message='PROFILE_NOT_FOUND'; end if;
  if private.current_role()<>'OWNER' then
    if p_id<>v_actor or exists(select 1 from jsonb_object_keys(p_data) k where k<>'full_name') then raise exception using errcode='42501',message='ACCESS_DENIED'; end if;
  end if;
  v_role:=coalesce((p_data->>'role')::public.user_role,v_old.role);
  v_active:=coalesce((p_data->>'active')::boolean,v_old.active);
  v_fin:=coalesce((p_data->>'can_view_financials')::boolean,v_old.can_view_financials);
  if v_old.role='OWNER' and v_old.active and (v_role<>'OWNER' or not v_active) and not exists(select 1 from public.profiles where role='OWNER' and active and id<>p_id) then
    raise exception using errcode='22023',message='LAST_OWNER_REQUIRED';
  end if;
  update public.profiles set full_name=btrim(coalesce(p_data->>'full_name',full_name)),role=v_role,active=v_active,can_view_financials=v_fin,updated_at=now()
  where id=p_id returning * into v_new;
  perform private.audit(case when v_old.active and not v_new.active then 'DISABLE_USER' else 'UPDATE_USER' end,'profiles',p_id,to_jsonb(v_old),to_jsonb(v_new));
end $$;

create function public.save_settings(p_data jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=private.require_role(array['OWNER']::public.user_role[]); v_old jsonb; v_new jsonb;
begin
  select to_jsonb(s) into v_old from public.system_settings s where id for update;
  update public.system_settings set store_name=btrim(coalesce(p_data->>'store_name',store_name)),phone=btrim(coalesce(p_data->>'phone',phone)),
    address=btrim(coalesce(p_data->>'address',address)),low_stock_threshold=coalesce((p_data->>'low_stock_threshold')::integer,low_stock_threshold),
    high_stock_threshold=coalesce((p_data->>'high_stock_threshold')::integer,high_stock_threshold),updated_by=v_actor,updated_at=now()
  where id returning to_jsonb(system_settings) into v_new;
  perform private.audit('UPDATE_SETTINGS','system_settings',null,v_old,v_new);
end $$;
