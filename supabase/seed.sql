-- DEVELOPMENT ONLY. Creates fictional business data for an already-provisioned
-- active OWNER. No credentials or personally identifying customer data are stored.
-- First create the local owner using Auth Admin/Studio, then run this file again.
--
-- Vehicle identity is biển số · số khung; the only vehicle descriptor fields are
-- loại xe (catalog `vehicle_types`), đời xe and màu sơn. There is no brand, model,
-- variant, engine number, odometer or expected asking price any more, and a price
-- exists only on an actual sale — exactly like the production contract.
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
  -- Columns: vehicle_type, color, year, plate, frame, purchase, sale_price, age, state
  for v_row in select * from (values
    ('Xe tay ga','Trắng',2025,'59-H1 101.01','RLHKC2025SEED001',79000000::bigint,0::bigint,6,'IN_STOCK'),
    ('Xe tay ga','Đen',2024,'59-H2 102.02','RLHKC2024SEED002',32000000::bigint,0::bigint,18,'IN_STOCK'),
    ('Xe tay ga','Xanh',2025,'59-H3 103.03','RLHKC2025SEED003',36500000::bigint,0::bigint,35,'RESERVED'),
    ('Xe tay ga','Trắng',2023,'59-P1 104.04','RLPIA2023SEED004',34000000::bigint,0::bigint,65,'IN_STOCK'),
    ('Xe số','Đỏ',2024,'59-H4 105.05','RLHKC2024SEED005',13000000::bigint,0::bigint,95,'IN_STOCK'),
    ('Xe côn tay','Xanh đen',2025,'59-Y1 106.06','RLHYC2025SEED006',37500000::bigint,0::bigint,3,'IN_STOCK'),
    ('Ga 50cc','Xám',2024,'59-H5 107.07','RLHKC2024SEED007',26000000::bigint,31000000::bigint,12,'SOLD_TODAY'),
    ('Xe côn tay','Đen',2023,'59-S1 108.08','RLSUZ2023SEED008',31000000::bigint,36000000::bigint,22,'SOLD_BEFORE')
  ) as d(vehicle_type,color,year,plate,frame,purchase,sale_price,age,state) loop
    v_vehicle:=public.save_vehicle(jsonb_build_object('request_id',gen_random_uuid(),'vehicle_type',v_row.vehicle_type,
      'color',v_row.color,'year',v_row.year,'license_plate',v_row.plate,'frame_number',v_row.frame,
      'purchase_date',v_today-v_row.age,'purchase_price',v_row.purchase,
      'status',case when v_row.state='RESERVED' then 'RESERVED' else 'IN_STOCK' end,
      'supplier_name','Nhà cung cấp mẫu','notes','[DEVELOPMENT-SEED] Dữ liệu giả lập để kiểm thử; không phải giao dịch thực tế.'));
    perform public.save_expense('vehicle',jsonb_build_object('vehicle_id',v_vehicle,'expense_type','CLEANING','description','Vệ sinh và kiểm tra xe mẫu','amount',150000,'expense_date',v_today-v_row.age+1));
    if v_row.state like 'SOLD%' then
      v_sale:=public.sell_vehicle(jsonb_build_object('request_id',gen_random_uuid(),'vehicle_id',v_vehicle,
        'customer_name','Khách hàng minh họa','customer_phone','',
        'sale_price',v_row.sale_price,'sale_date',case when v_row.state='SOLD_TODAY' then v_today else v_today-2 end,
        'initial_payment',case when v_row.state='SOLD_TODAY' then 15000000 else v_row.sale_price end,'payment_method','BANK_TRANSFER','notes','Giao dịch mẫu'));
    end if;
  end loop;
  perform public.save_expense('business',jsonb_build_object('category','RENT','description','Thuê mặt bằng — dữ liệu mẫu','amount',8000000,'expense_date',date_trunc('month',v_today)::date));
  perform public.save_expense('business',jsonb_build_object('category','ELECTRICITY','description','Điện nước — dữ liệu mẫu','amount',450000,'expense_date',v_today));
end $$;
