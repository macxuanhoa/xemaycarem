-- DEVELOPMENT ONLY. Creates fictional business data for an already-provisioned
-- active OWNER. No credentials or personally identifying customer data are stored.
-- First create the local owner using Auth Admin/Studio, then run this file again.
do $$
declare
  v_owner uuid; v_vehicle uuid; v_sale uuid; v_row record;
  v_today date:=(now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  select id into v_owner from public.profiles where role='OWNER' and active order by created_at limit 1;
  if v_owner is null then
    raise notice 'Seed skipped: provision an active local OWNER, then run supabase/seed.sql in the local SQL console.';
    return;
  end if;
  if exists(select 1 from public.vehicles where notes like '[DEVELOPMENT-SEED]%') then
    raise notice 'Development data already exists; seed skipped.';
    return;
  end if;
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'role','authenticated')::text,true);
  for v_row in select * from (values
    ('Honda','SH 160i','Trắng',2025,5200,79000000::bigint,89000000::bigint,6,'IN_STOCK'),
    ('Honda','Air Blade 125','Đen',2024,12000,32000000::bigint,38500000::bigint,18,'IN_STOCK'),
    ('Yamaha','Grande','Xanh',2025,4100,36500000::bigint,42000000::bigint,35,'RESERVED'),
    ('Piaggio','Liberty 125','Trắng',2023,19000,34000000::bigint,39500000::bigint,65,'IN_STOCK'),
    ('Honda','Wave Alpha','Đỏ',2024,16000,13000000::bigint,16800000::bigint,95,'IN_STOCK'),
    ('Yamaha','Exciter 155','Xanh đen',2025,7500,37500000::bigint,43500000::bigint,3,'IN_STOCK'),
    ('Honda','Vision','Xám',2024,8800,26000000::bigint,31500000::bigint,12,'SOLD_TODAY'),
    ('Suzuki','Raider 150','Đen',2023,14500,31000000::bigint,36500000::bigint,22,'SOLD_BEFORE')
  ) as d(brand,model,color,year,odometer,purchase,asking,age,state) loop
    v_vehicle:=public.save_vehicle(jsonb_build_object('brand',v_row.brand,'model',v_row.model,'color',v_row.color,'year',v_row.year,'odometer',v_row.odometer,
      'purchase_date',v_today-v_row.age,'purchase_price',v_row.purchase,'asking_price',v_row.asking,'status',case when v_row.state='RESERVED' then 'RESERVED' else 'IN_STOCK' end,
      'supplier_name','Nhà cung cấp mẫu','notes','[DEVELOPMENT-SEED] Dữ liệu giả lập để kiểm thử; không phải giao dịch thực tế.'));
    perform public.save_expense('vehicle',jsonb_build_object('vehicle_id',v_vehicle,'expense_type','CLEANING','description','Vệ sinh và kiểm tra xe mẫu','amount',150000,'expense_date',v_today-v_row.age+1));
    if v_row.state like 'SOLD%' then
      v_sale:=public.sell_vehicle(jsonb_build_object('vehicle_id',v_vehicle,'customer_name','Khách hàng minh họa','customer_phone','',
        'sale_price',v_row.asking-500000,'sale_date',case when v_row.state='SOLD_TODAY' then v_today else v_today-2 end,
        'initial_payment',case when v_row.state='SOLD_TODAY' then 15000000 else v_row.asking-500000 end,'payment_method','BANK_TRANSFER','notes','Giao dịch mẫu'));
    end if;
  end loop;
  perform public.save_expense('business',jsonb_build_object('category','RENT','description','Thuê mặt bằng — dữ liệu mẫu','amount',8000000,'expense_date',date_trunc('month',v_today)::date));
  perform public.save_expense('business',jsonb_build_object('category','ELECTRICITY','description','Điện nước — dữ liệu mẫu','amount',450000,'expense_date',v_today));
end $$;
