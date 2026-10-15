-- 14/10/2026: Follow-up BẮT BUỘC cho 20261014000500_retire_thankyou_messaging.sql.
-- Forward-only, không DROP, không xóa dữ liệu — chỉ định nghĩa lại hàm.
--
-- Bản 000500 nghỉ hưu subsystem cảm ơn nhưng để lại hai lỗi tiềm ẩn chỉ nổ khi chạy:
--  1) public.check_user_can_hard_delete vẫn EXISTS trên public.customer_communications
--     và public.message_outbox — hai bảng bị DROP ở chính migration đó. plpgsql không
--     kiểm tra tên bảng lúc tạo hàm, nên mọi phán quyết "xóa tài khoản" chạy tới khối
--     IF là nổ 42P01 (parserOpenTable) → trang Nhân sự không còn xóa/mộ hóa được ai.
--  2) 000500 định nghĩa lại private.sell_vehicle_impl theo bản 20261014000100, nhưng
--     20261014000400_vietqr_verified_lifecycle đã ĐỔI TÊN bản 000100 thành
--     private.sell_vehicle_before_verified_qr_impl rồi đặt wrapper gắn VietQR lên tên
--     private.sell_vehicle_impl. CREATE OR REPLACE vì vậy đã ghi đè wrapper: bán xe kèm
--     mã QR đã nhận tiền không còn chặn thiếu bằng chứng ngân hàng, không bind sale_id
--     vào vietqr_requests và không ghi có từ bank credit.
--
-- Cách sửa: hành vi đúng = 000400 + 000500 cộng lại. Nền bán xe (đã cắt outbox) nằm ở
-- sell_vehicle_before_verified_qr_impl; wrapper VietQR dựng lại y nguyên như 000400 ở
-- sell_vehicle_impl. Quyền EXECUTE/REVOKE gắn theo OID hàm nên giữ nguyên, không đổi.

-- (1) Nền bán xe: đúng bản 000500 — đã bỏ khối QUEUED cảm ơn (outbox +
--     customer_communications + audit AUTO_MESSAGE_*), giữ nguyên giao dịch bán,
--     khoản thu đầu, snapshot giá vốn/chi phí, audit CREATE_SALE, anti-oracle gate.
CREATE OR REPLACE FUNCTION private.sell_vehicle_before_verified_qr_impl(p_data jsonb)
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
  RETURN v_sale.id;
END $fn$;

-- (2) Wrapper VietQR: dựng lại đúng nguyên văn 20261014000400 (chặn bán BANK_TRANSFER
--     không có mã QR đã RECEIVED, đối chiếu xe/số tiền/tên người trả, bind sale_id,
--     ghi có bank credit) và gọi nền bán xe ở bước (1).
CREATE OR REPLACE FUNCTION private.sell_vehicle_impl(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_qr uuid:=nullif(p_data->>'vietqr_request_id','')::uuid; v_req public.vietqr_requests; v_sale uuid;
BEGIN
 PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
 IF v_qr IS NULL THEN
   IF coalesce(p_data->>'payment_method','')='BANK_TRANSFER' AND private.money_input(p_data,'initial_payment',0)>0
     THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
   RETURN private.sell_vehicle_before_verified_qr_impl(p_data);
 END IF;
 PERFORM 1 FROM public.vehicles WHERE id=(p_data->>'vehicle_id')::uuid FOR UPDATE;
 SELECT * INTO v_req FROM public.vietqr_requests WHERE id=v_qr FOR UPDATE;
 IF v_req.id IS NULL OR v_req.status<>'RECEIVED' OR v_req.sale_id IS NOT NULL OR v_req.bank_transaction_id IS NULL
   THEN RAISE EXCEPTION 'VIETQR_BANK_EVIDENCE_REQUIRED'; END IF;
 IF v_req.vehicle_id IS DISTINCT FROM (p_data->>'vehicle_id')::uuid
   OR v_req.amount IS DISTINCT FROM private.money_input(p_data,'initial_payment')
   OR coalesce(p_data->>'payment_method','')<>'BANK_TRANSFER'
   OR private.vietqr_name_key(v_req.payer_name) IS DISTINCT FROM private.vietqr_name_key(p_data->>'customer_name')
   THEN RAISE EXCEPTION 'VIETQR_SALE_BINDING_MISMATCH'; END IF;
 v_sale:=private.sell_vehicle_before_verified_qr_impl(p_data||jsonb_build_object('initial_payment',0));
 UPDATE public.vietqr_requests SET sale_id=v_sale WHERE id=v_req.id;
 PERFORM private.record_vietqr_bank_credit(v_req.id,v_req.bank_transaction_id);
 RETURN v_sale;
END $$;

-- (3) Phán quyết xóa tài khoản: bỏ hai EXISTS trỏ tới bảng đã DROP, mọi tham chiếu
--     nghiệp vụ còn lại giữ nguyên thứ tự và nội dung như 20261008000100.
CREATE OR REPLACE FUNCTION public.check_user_can_hard_delete(p_user_id UUID) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_caller uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_target public.profiles;
BEGIN
  SELECT * INTO v_target FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  END IF;

  IF v_target.role = 'OWNER' THEN
    RETURN jsonb_build_object('can_delete', false, 'reason', 'CANNOT_DELETE_OWNER', 'message', 'Không thể xóa tài khoản Chủ cửa hàng.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.acquisitions WHERE created_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicles WHERE created_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_financials WHERE updated_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE created_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_images WHERE created_by = p_user_id OR deleted_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.vehicle_activity WHERE user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.sales WHERE sold_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.payments WHERE created_by = p_user_id OR voided_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.payment_receipts WHERE created_by = p_user_id OR verified_by = p_user_id)
    OR EXISTS (SELECT 1 FROM private.payment_receipt_requests WHERE actor_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.business_expenses WHERE created_by = p_user_id OR cancelled_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.identity_documents WHERE created_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.system_announcements WHERE created_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.system_settings WHERE updated_by = p_user_id)
    OR EXISTS (SELECT 1 FROM public.audit_logs WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object(
      'can_delete', false,
      'reason', 'USER_HAS_BUSINESS_HISTORY',
      'message', 'Tài khoản này đã ghi nhận nghiệp vụ. Hệ thống xóa tài khoản đăng nhập nhưng giữ hồ sơ để đối soát.'
    );
  END IF;

  RETURN jsonb_build_object('can_delete', true);
END $$;
