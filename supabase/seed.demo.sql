-- DEVELOPMENT / DEMO ONLY — richer fictional data for visual testing.
-- Populates every screen: Kho xe (vehicles), Thu vào (acquisitions), Bán hàng (sales),
-- Thu công nợ (receivables), Khách hàng (customers), Chăm sóc (communications),
-- Chi phí (vehicle + business expenses), Tổng quan (dashboard) and Lịch sử (audit).
--
-- It reuses the real SECURITY DEFINER RPCs (acquire_vehicle, save_vehicle, save_expense,
-- sell_vehicle, prepare_payment_receipt, add_payment, cancel_acquisition) so RLS, cost
-- snapshots and derived views behave exactly like real usage. Data is marked
-- '[DEVELOPMENT-SEED-DEMO]%' and the whole script is idempotent: it exits early if that
-- marker already exists.
--
-- Requires an already-provisioned, ACTIVE OWNER (role='OWNER', active=true).
-- Safe on a development database only. Never run against production customer data.
--
-- Contract notes: a vehicle is identified by biển số · số khung and described only by
-- loại xe (catalog), đời xe and màu sơn. There is no brand/model/variant, no engine
-- number, no odometer and no expected asking price; the only price a vehicle ever
-- carries is the sale_price typed on a real bán hàng form.

do $$
declare
  v_owner uuid;
  v_vehicle uuid;
  v_sale uuid;
  v_acq uuid;
  v_receipt jsonb;
  v_row record;
  v_purchase_date date;
  v_expense_date date;
  v_sale_date date;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  select id into v_owner from public.profiles where role = 'OWNER' and active order by created_at limit 1;
  if v_owner is null then
    raise notice 'Demo seed skipped: provision an active OWNER first, then run supabase/seed.demo.sql.';
    return;
  end if;
  if exists(select 1 from public.vehicles where notes like '[DEVELOPMENT-SEED-DEMO]%') then
    raise notice 'Demo data already exists; seed skipped.';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- Columns: vehicle_type, color, year, plate, frame,
  --          purchase, age(days held), state, customer, phone,
  --          saleage(days ago sold), price, initial, method, dueoff(days from today; 0=none), addpay
  for v_row in
    select * from (values
      ('Xe tay ga','Trắng',2025,'59B1-234.56','RLHKC2025AA00123', 79000000::bigint, 4,'IN_STOCK','','',0,0::bigint,0::bigint,'',0,0::bigint),
      ('Ga 50cc','Đen',2025,'59E1-8801','RLHKC2025AA00456', 31500000, 0,'IN_STOCK','','',0,0,0,'',0,0),
      ('Xe số','Đỏ đen',2024,'59F8-2136','RLHKC2024AA00789', 12800000, 110,'IN_STOCK','','',0,0,0,'',0,0),
      ('Xe côn tay','Xám đen',2025,'59M1-777.77','RLHYC2025AA00321', 38500000, 22,'RESERVED','','',0,0,0,'',0,0),
      ('Xe tay ga','Xanh ngọc',2024,'61B1-456.78','RLHYC2024AA00654', 30500000, 48,'IN_STOCK','','',0,0,0,'',0,0),
      ('Xe tay ga','Trắng',2023,'59D1-333.33','RLPIA2023AA00987', 30000000, 125,'IN_STOCK','','',0,0,0,'',0,0),
      ('Xe côn tay','Đen nhám',2024,'59S1-222.22','RLSUZ2024AA00111', 22500000, 66,'IN_STOCK','','',0,0,0,'',0,0),
      ('Xe côn tay','Xanh',2024,'59W1-111.11','RLHKC2024AA00777', 34000000, 30,'IN_STOCK','','',0,0,0,'',0,0),
      ('Xe điện','Đen',2024,'59D9-900.90','VFKTE2024AA00333', 24000000, 18,'IN_STOCK','','',0,0,0,'',0,0),
      ('Xe tay ga','Nâu',2025,'59G1-456.12','RLHKC2025AA00222', 33000000, 9,'SOLD','Trần Minh Anh','0903123456', 0,39000000,39000000,'BANK_TRANSFER',0,0),
      ('Xe tay ga','Trắng kem',2024,'59B2-888.88','RLHKC2024AA00333', 45000000, 16,'SOLD','Nguyễn Thị Hồng','0912345678', 6,53000000,20000000,'CASH',14,10000000),
      ('Xe tay ga','Hồng',2023,'59N1-555.55','RLHYC2023AA00444', 25000000, 98,'SOLD','Lê Hoàng Phúc','0978654321', 35,30000000,10000000,'BANK_TRANSFER',-10,0),
      ('Xe tay ga','Xanh titan',2025,'59P1-606.06','RLHKC2025AA00555', 41000000, 5,'SOLD','Phạm Thu Hà','0988776655', 0,48000000,48000000,'BANK_TRANSFER',0,0),
      ('Xe tay ga','Xanh',2023,'59V1-999.99','RLPIA2023AA00666', 48000000, 150,'SOLD','Đặng Văn Khoa','0905111222', 62,58000000,58000000,'CASH',0,0)
    ) as d(vehicle_type,color,year,plate,frame,purchase,age,state,cust,phone,saleage,price,init,method,dueoff,addpay)
  loop
    v_purchase_date := v_today - v_row.age;

    -- Thu vào: creates vehicle + financials + acquisition atomically.
    v_vehicle := public.acquire_vehicle(jsonb_build_object(
      'request_id', gen_random_uuid(),
      'frame_number', v_row.frame, 'license_plate', v_row.plate,
      'vehicle_type', v_row.vehicle_type, 'color', v_row.color, 'year', v_row.year,
      'purchase_price', v_row.purchase,
      'acquisition_date', v_purchase_date::text,
      'seller_name', 'Nhà cung cấp mẫu', 'seller_phone', '',
      'notes', '[DEVELOPMENT-SEED-DEMO] Dữ liệu giả lập để kiểm thử trực quan; không phải giao dịch thực tế.',
      'acquisition_notes', '[DEVELOPMENT-SEED-DEMO] Phiếu thu vào mẫu.'));

    -- Chi phí xe (chỉ khi còn IN_STOCK/RESERVED).
    v_expense_date := least(v_purchase_date + 1, v_today);
    perform public.save_expense('vehicle', jsonb_build_object(
      'vehicle_id', v_vehicle, 'expense_type', 'CLEANING', 'description', 'Vệ sinh & kiểm tra xe mẫu',
      'amount', 150000, 'expense_date', v_expense_date::text));

    if v_row.state = 'RESERVED' then
      perform public.save_vehicle(jsonb_build_object('status', 'RESERVED'), v_vehicle);
    elsif v_row.state = 'SOLD' then
      v_sale_date := v_today - v_row.saleage;
      v_sale := public.sell_vehicle(jsonb_build_object(
        'request_id', gen_random_uuid(),
        'vehicle_id', v_vehicle, 'customer_name', v_row.cust, 'customer_phone', v_row.phone,
        'sale_price', v_row.price, 'sale_date', v_sale_date::text,
        'initial_payment', v_row.init, 'payment_method', v_row.method,
        'due_date', case when v_row.dueoff <> 0 then (v_today + v_row.dueoff)::text else null end,
        'notes', '[DEVELOPMENT-SEED-DEMO] Giao dịch bán mẫu.')
        - 'null');
      if v_row.addpay > 0 then
        -- Một đợt thu bổ sung đi đúng protocol biên lai đã xác minh.
        v_receipt := public.prepare_payment_receipt(jsonb_build_object(
          'request_id', gen_random_uuid(), 'sale_id', v_sale, 'amount', v_row.addpay,
          'payment_method', 'CASH', 'payment_date', v_today::text,
          'evidence_kind', 'CASH_VOUCHER', 'evidence_scope', 'QUẦY THU NGÂN',
          'evidence_reference', 'SAMPLE-' || v_row.frame,
          'notes', '[DEVELOPMENT-SEED-DEMO] Đợt thu bổ sung.'));
        perform public.add_payment(jsonb_build_object(
          'request_id', gen_random_uuid(), 'receipt_id', (v_receipt->>'id')::uuid,
          'sale_id', v_sale, 'amount', v_row.addpay, 'payment_method', 'CASH',
          'payment_date', v_today::text,
          'verification_reference', '[DEVELOPMENT-SEED-DEMO] Đã đối soát chứng từ mẫu'));
      end if;
    end if;
  end loop;

  -- Một thương vụ thu vào đã hủy để màn hình Thu vào có trạng thái CANCELLED.
  v_vehicle := public.acquire_vehicle(jsonb_build_object(
    'request_id', gen_random_uuid(),
    'frame_number', 'RLSUZ2022AA00888', 'license_plate', '59A1-313.13',
    'vehicle_type', 'Xe tay ga', 'color', 'Đen', 'year', 2022,
    'purchase_price', 15000000,
    'acquisition_date', (v_today - 80)::text,
    'seller_name', 'Nhà cung cấp mẫu (đổi ý)', 'seller_phone', '',
    'notes', '[DEVELOPMENT-SEED-DEMO] Xe mẫu đã hủy thu vào.',
    'acquisition_notes', '[DEVELOPMENT-SEED-DEMO] Phiếu đã hủy mẫu.'));
  select id into v_acq from public.acquisitions where vehicle_id = v_vehicle and status = 'COMPLETED' limit 1;
  if v_acq is not null then
    perform public.cancel_acquisition(v_acq, 'Khách bán đổi ý — dữ liệu mẫu');
  end if;

  -- Chi phí cửa hàng rải trong 4 tháng gần nhất để báo cáo/đồ thị có dữ liệu.
  perform public.save_settings(jsonb_build_object('store_name', 'Cửa Hàng Xe Máy Cà Rem (Môi trường thử nghiệm)'));
  for v_row in select generate_series(0, 3) as k loop
    perform public.save_expense('business', jsonb_build_object(
      'category', 'RENT', 'description', 'Thuê mặt bằng — dữ liệu mẫu',
      'amount', 8000000, 'expense_date', least((date_trunc('month', v_today) - make_interval(months => v_row.k))::date, v_today)::text));
    perform public.save_expense('business', jsonb_build_object(
      'category', 'SALARY', 'description', 'Lương nhân viên — dữ liệu mẫu',
      'amount', 15000000, 'expense_date', least((date_trunc('month', v_today) - make_interval(months => v_row.k) + interval '25 day')::date, v_today)::text));
    perform public.save_expense('business', jsonb_build_object(
      'category', 'ELECTRICITY', 'description', 'Điện nước — dữ liệu mẫu',
      'amount', 600000, 'expense_date', least((date_trunc('month', v_today) - make_interval(months => v_row.k) + interval '3 day')::date, v_today)::text));
  end loop;
  perform public.save_expense('business', jsonb_build_object(
    'category', 'MARKETING', 'description', 'Chạy quảng cáo Facebook/Zalo — dữ liệu mẫu',
    'amount', 2500000, 'expense_date', (v_today - 3)::text));
  perform public.save_expense('business', jsonb_build_object(
    'category', 'OFFICE', 'description', 'Văn phòng phẩm — dữ liệu mẫu',
    'amount', 800000, 'expense_date', v_today::text));

  raise notice 'Demo seed complete: % xe (thu vào/bán/chi phí/khách hàng/công nợ) đã được tạo.',
    (select count(*) from public.vehicles where notes like '[DEVELOPMENT-SEED-DEMO]%');
end $$;
