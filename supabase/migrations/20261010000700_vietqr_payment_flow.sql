-- ============================================================
-- Migration: 20261010000700_vietqr_payment_flow.sql
-- Triển khai thanh toán chuyển khoản bằng VietQR động cho Cà Rem CRM
-- ============================================================

BEGIN;

-- 1. Thêm cấu hình ngân hàng vào system_settings
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS bank_bin text NOT NULL DEFAULT '' CHECK (length(bank_bin) <= 10),
  ADD COLUMN IF NOT EXISTS bank_name text NOT NULL DEFAULT '' CHECK (length(bank_name) <= 100),
  ADD COLUMN IF NOT EXISTS bank_account_no text NOT NULL DEFAULT '' CHECK (length(bank_account_no) <= 40),
  ADD COLUMN IF NOT EXISTS bank_account_name text NOT NULL DEFAULT '' CHECK (length(bank_account_name) <= 120),
  ADD COLUMN IF NOT EXISTS vietqr_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.system_settings.bank_bin IS 'Mã BIN ngân hàng nhận tiền (6 chữ số theo chuẩn Napas/VietQR, ví dụ: 970422 cho MBBank)';
COMMENT ON COLUMN public.system_settings.bank_name IS 'Tên ngân hàng nhận tiền (ví dụ: MBBank, Vietcombank)';
COMMENT ON COLUMN public.system_settings.bank_account_no IS 'Số tài khoản nhận tiền';
COMMENT ON COLUMN public.system_settings.bank_account_name IS 'Tên chủ tài khoản nhận tiền (in hoa không dấu)';
COMMENT ON COLUMN public.system_settings.vietqr_enabled IS 'Bật hoặc tắt tính năng tạo mã thanh toán VietQR động';

-- 2. Cập nhật hàm save_settings để OWNER lưu cấu hình tài khoản ngân hàng
CREATE OR REPLACE FUNCTION public.save_settings(p_data jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old jsonb; v_new jsonb;
  v_from time; v_until time; v_days integer[];
  v_bank_bin text;
  v_bank_name text;
  v_account_no text;
  v_account_name text;
  v_vietqr_enabled boolean;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT';
  END IF;

  -- Validate the shared working-time fields before touching the row.
  IF p_data ? 'staff_allowed_from' AND nullif(btrim(coalesce(p_data->>'staff_allowed_from','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_from')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_from := (p_data->>'staff_allowed_from')::time;
  ELSIF p_data ? 'staff_allowed_from' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_allowed_until' AND nullif(btrim(coalesce(p_data->>'staff_allowed_until','')),'') IS NOT NULL THEN
    IF (p_data->>'staff_allowed_until')::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    v_until := (p_data->>'staff_allowed_until')::time;
  ELSIF p_data ? 'staff_allowed_until' THEN
    RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
  END IF;

  IF p_data ? 'staff_working_days' THEN
    IF jsonb_typeof(p_data->'staff_working_days') <> 'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_data->'staff_working_days') e WHERE e !~ '^[1-7]$') THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_SCHEDULE';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (e)::int), ARRAY[]::integer[]) INTO v_days
      FROM jsonb_array_elements_text(p_data->'staff_working_days') e;
  END IF;

  -- Validate VietQR bank settings
  IF p_data ? 'vietqr_enabled' THEN
    v_vietqr_enabled := (p_data->>'vietqr_enabled')::boolean;
  END IF;

  IF p_data ? 'bank_bin' THEN
    v_bank_bin := btrim(coalesce(p_data->>'bank_bin', ''));
    IF length(v_bank_bin) > 10 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_BANK_BIN';
    END IF;
  END IF;

  IF p_data ? 'bank_name' THEN
    v_bank_name := btrim(coalesce(p_data->>'bank_name', ''));
    IF length(v_bank_name) > 100 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_BANK_NAME';
    END IF;
  END IF;

  IF p_data ? 'bank_account_no' THEN
    v_account_no := btrim(coalesce(p_data->>'bank_account_no', ''));
    IF length(v_account_no) > 40 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_ACCOUNT_NO';
    END IF;
  END IF;

  IF p_data ? 'bank_account_name' THEN
    v_account_name := upper(btrim(coalesce(p_data->>'bank_account_name', '')));
    IF length(v_account_name) > 120 THEN
      RAISE EXCEPTION USING errcode='22023',message='INVALID_ACCOUNT_NAME';
    END IF;
  END IF;

  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;

  -- Nếu bật VietQR, yêu cầu phải có đủ thông tin ngân hàng
  IF coalesce(v_vietqr_enabled, (v_old->>'vietqr_enabled')::boolean, false) THEN
    IF nullif(coalesce(v_bank_bin, v_old->>'bank_bin', ''), '') IS NULL
       OR nullif(coalesce(v_account_no, v_old->>'bank_account_no', ''), '') IS NULL
       OR nullif(coalesce(v_account_name, v_old->>'bank_account_name', ''), '') IS NULL THEN
      RAISE EXCEPTION USING errcode='22023',message='VIETQR_CONFIG_REQUIRED';
    END IF;
  END IF;

  UPDATE public.system_settings SET
    store_name=btrim(coalesce(p_data->>'store_name',store_name)),
    phone=btrim(coalesce(p_data->>'phone',phone)),
    address=btrim(coalesce(p_data->>'address',address)),
    low_stock_threshold=coalesce((p_data->>'low_stock_threshold')::integer,low_stock_threshold),
    high_stock_threshold=coalesce((p_data->>'high_stock_threshold')::integer,high_stock_threshold),
    customer_messaging_enabled=coalesce((p_data->>'customer_messaging_enabled')::boolean,customer_messaging_enabled),
    sale_thank_you_enabled=coalesce((p_data->>'sale_thank_you_enabled')::boolean,sale_thank_you_enabled),
    primary_message_channel=coalesce(p_data->>'primary_message_channel',primary_message_channel),
    fallback_channel=coalesce(p_data->>'fallback_channel',fallback_channel),
    support_phone=btrim(coalesce(p_data->>'support_phone',support_phone)),
    staff_allowed_from=coalesce(v_from,staff_allowed_from),
    staff_allowed_until=coalesce(v_until,staff_allowed_until),
    staff_working_days=coalesce(v_days,staff_working_days),
    bank_bin=coalesce(v_bank_bin, bank_bin),
    bank_name=coalesce(v_bank_name, bank_name),
    bank_account_no=coalesce(v_account_no, bank_account_no),
    bank_account_name=coalesce(v_account_name, bank_account_name),
    vietqr_enabled=coalesce(v_vietqr_enabled, vietqr_enabled),
    updated_by=v_actor,updated_at=now()
  WHERE id RETURNING to_jsonb(system_settings) INTO v_new;

  PERFORM private.audit(
    CASE
      WHEN (v_old->>'bank_bin') IS DISTINCT FROM (v_new->>'bank_bin')
        OR (v_old->>'bank_account_no') IS DISTINCT FROM (v_new->>'bank_account_no')
        OR (v_old->>'bank_account_name') IS DISTINCT FROM (v_new->>'bank_account_name')
        OR (v_old->>'vietqr_enabled') IS DISTINCT FROM (v_new->>'vietqr_enabled')
        THEN 'BANK_ACCOUNT_CHANGED'
      WHEN (v_old->>'staff_allowed_from') <> (v_new->>'staff_allowed_from')
        OR (v_old->>'staff_allowed_until') <> (v_new->>'staff_allowed_until')
        OR (v_old->'staff_working_days') <> (v_new->'staff_working_days')
        THEN 'STAFF_SCHEDULE_CHANGED'
      ELSE 'MESSAGE_SETTING_CHANGED'
    END,
    'system_settings',null,v_old,v_new);
END $$;

-- 3. Tạo Sequence sinh mã chuyển khoản duy nhất (ví dụ: CAREM GD01001)
CREATE SEQUENCE IF NOT EXISTS private.vietqr_ref_seq START WITH 1001;

CREATE OR REPLACE FUNCTION private.generate_vietqr_reference()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN 'CAREM GD' || lpad(nextval('private.vietqr_ref_seq')::text, 5, '0');
END $$;

-- 4. Bảng lưu trữ yêu cầu thanh toán VietQR động
CREATE TABLE IF NOT EXISTS public.vietqr_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_reference text NOT NULL UNIQUE,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
  sale_id uuid REFERENCES public.sales(id),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 1000000000000),
  bank_bin text NOT NULL,
  bank_name text NOT NULL,
  bank_account_no text NOT NULL,
  bank_account_name text NOT NULL,
  qr_payload text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED')),
  payment_id uuid UNIQUE REFERENCES public.payments(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  confirmed_by uuid REFERENCES public.profiles(id),
  confirmed_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vietqr_requests_vehicle ON public.vietqr_requests(vehicle_id);
CREATE INDEX IF NOT EXISTS vietqr_requests_sale ON public.vietqr_requests(sale_id);
CREATE INDEX IF NOT EXISTS vietqr_requests_status ON public.vietqr_requests(status);

ALTER TABLE public.vietqr_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vietqr_requests FROM PUBLIC, anon, authenticated;

-- 5. RPC tạo yêu cầu thanh toán VietQR động
CREATE OR REPLACE FUNCTION public.create_vietqr_payment_request(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_vehicle_id uuid;
  v_sale_id uuid;
  v_amount bigint;
  v_qr_payload text;
  v_vehicle public.vehicles;
  v_sale public.sales;
  v_settings public.system_settings;
  v_existing public.vietqr_requests;
  v_request public.vietqr_requests;
  v_paid bigint;
  v_ref text;
  v_superseded boolean := false;
BEGIN
  -- Kiểm tra quyền tài chính: STAFF không có quyền tài chính bị từ chối
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'ACCESS_DENIED';
  END IF;
  v_actor := auth.uid();

  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  -- Đọc cấu hình ngân hàng
  SELECT * INTO v_settings FROM public.system_settings WHERE id;
  IF NOT FOUND OR NOT v_settings.vietqr_enabled
     OR nullif(btrim(v_settings.bank_bin), '') IS NULL
     OR nullif(btrim(v_settings.bank_account_no), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VIETQR_NOT_CONFIGURED';
  END IF;

  v_sale_id := nullif(p_data->>'sale_id', '')::uuid;
  v_vehicle_id := nullif(p_data->>'vehicle_id', '')::uuid;
  v_amount := private.money_input(p_data, 'amount');
  v_qr_payload := btrim(coalesce(p_data->>'qr_payload', ''));

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT_AMOUNT';
  END IF;

  -- Kiểm tra ngữ cảnh: Có sale_id hoặc vehicle_id
  IF v_sale_id IS NOT NULL THEN
    SELECT * INTO v_sale FROM public.sales WHERE id = v_sale_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND';
    END IF;
    IF v_sale.status <> 'COMPLETED' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'SALE_CANCELLED';
    END IF;
    v_vehicle_id := v_sale.vehicle_id;

    -- Kiểm tra số tiền không vượt số dư còn phải thu
    SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_paid
      FROM public.payments WHERE sale_id = v_sale_id AND status = 'ACTIVE';
    IF v_paid + v_amount > v_sale.sale_price THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'PAYMENT_EXCEEDS_BALANCE';
    END IF;
  ELSE
    IF v_vehicle_id IS NULL THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_REQUIRED';
    END IF;
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_vehicle_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND';
    END IF;
    IF v_vehicle.status NOT IN ('IN_STOCK', 'RESERVED') THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_NOT_AVAILABLE';
    END IF;
  END IF;

  -- Khóa và kiểm tra yêu cầu PENDING hiện tại cho xe/giao dịch này
  -- (Serialization theo xe)
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_vehicle_id::text, 247));

  SELECT * INTO v_existing FROM public.vietqr_requests
    WHERE (
      (v_sale_id IS NOT NULL AND sale_id = v_sale_id)
      OR (v_sale_id IS NULL AND sale_id IS NULL AND vehicle_id = v_vehicle_id)
    )
    AND status = 'PENDING'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    -- Nếu cùng số tiền: Tái sử dụng yêu cầu hiện tại (idempotency, không tạo lặp)
    IF v_existing.amount = v_amount THEN
      RETURN to_jsonb(v_existing) || jsonb_build_object('superseded', false);
    ELSE
      -- Nếu khác số tiền: Hủy hiệu lực yêu cầu cũ và tạo mới với cảnh báo
      UPDATE public.vietqr_requests
      SET status = 'CANCELLED',
          cancelled_by = v_actor,
          cancelled_at = now(),
          cancellation_reason = 'SUPERSEDED_BY_NEW_AMOUNT',
          updated_at = now()
      WHERE id = v_existing.id;

      PERFORM private.audit('CANCEL_VIETQR_PAYMENT_REQUEST', 'vietqr_requests', v_existing.id,
        to_jsonb(v_existing),
        jsonb_build_object('reason', 'SUPERSEDED_BY_NEW_AMOUNT', 'new_amount', v_amount),
        v_vehicle_id);

      v_superseded := true;
    END IF;
  END IF;

  -- Sinh mã tham chiếu duy nhất
  v_ref := private.generate_vietqr_reference();

  INSERT INTO public.vietqr_requests(
    qr_reference,
    vehicle_id,
    sale_id,
    amount,
    bank_bin,
    bank_name,
    bank_account_no,
    bank_account_name,
    qr_payload,
    status,
    created_by
  ) VALUES (
    v_ref,
    v_vehicle_id,
    v_sale_id,
    v_amount,
    v_settings.bank_bin,
    v_settings.bank_name,
    v_settings.bank_account_no,
    v_settings.bank_account_name,
    v_qr_payload,
    'PENDING',
    v_actor
  ) RETURNING * INTO v_request;

  PERFORM private.audit('CREATE_VIETQR_PAYMENT_REQUEST', 'vietqr_requests', v_request.id,
    null, to_jsonb(v_request), v_vehicle_id);

  RETURN to_jsonb(v_request) || jsonb_build_object('superseded', v_superseded);
END $$;

-- 6. RPC lấy thông tin chi tiết một yêu cầu VietQR
CREATE OR REPLACE FUNCTION public.get_vietqr_payment_request(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req public.vietqr_requests;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'ACCESS_DENIED';
  END IF;

  SELECT * INTO v_req FROM public.vietqr_requests WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'VIETQR_REQUEST_NOT_FOUND';
  END IF;

  RETURN to_jsonb(v_req);
END $$;

CREATE OR REPLACE FUNCTION public.get_vietqr_payment_request(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
BEGIN
  IF jsonb_typeof(p_data) = 'string' THEN
    v_id := (p_data #>> '{}')::uuid;
  ELSE
    v_id := coalesce((p_data->>'p_id')::uuid, (p_data->>'id')::uuid);
  END IF;
  RETURN public.get_vietqr_payment_request(v_id);
END $$;

-- 7. RPC hủy yêu cầu VietQR
CREATE OR REPLACE FUNCTION public.cancel_vietqr_payment_request(p_id uuid, p_reason text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_req public.vietqr_requests;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'ACCESS_DENIED';
  END IF;
  v_actor := auth.uid();

  SELECT * INTO v_req FROM public.vietqr_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'VIETQR_REQUEST_NOT_FOUND';
  END IF;

  IF v_req.status <> 'PENDING' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VIETQR_REQUEST_NOT_PENDING';
  END IF;

  UPDATE public.vietqr_requests
  SET status = 'CANCELLED',
      cancelled_by = v_actor,
      cancelled_at = now(),
      cancellation_reason = coalesce(p_reason, 'USER_CANCELLED'),
      updated_at = now()
  WHERE id = p_id RETURNING * INTO v_req;

  PERFORM private.audit('CANCEL_VIETQR_PAYMENT_REQUEST', 'vietqr_requests', v_req.id,
    null, to_jsonb(v_req), v_req.vehicle_id);

  RETURN to_jsonb(v_req);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_vietqr_payment_request(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_reason text := '';
BEGIN
  IF jsonb_typeof(p_data) = 'string' THEN
    v_id := (p_data #>> '{}')::uuid;
  ELSE
    v_id := coalesce((p_data->>'p_id')::uuid, (p_data->>'id')::uuid);
    v_reason := coalesce(p_data->>'p_reason', p_data->>'reason', '');
  END IF;
  RETURN public.cancel_vietqr_payment_request(v_id, v_reason);
END $$;

-- 8. RPC xác nhận tiền đã nhận cho yêu cầu VietQR
CREATE OR REPLACE FUNCTION public.confirm_vietqr_payment(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_qr_id uuid;
  v_request_id uuid;
  v_payment_date date;
  v_notes text;
  v_req public.vietqr_requests;
  v_sale public.sales;
  v_payment_id uuid;
  v_paid bigint;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'ACCESS_DENIED';
  END IF;
  v_actor := auth.uid();

  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  v_qr_id := (p_data->>'qr_request_id')::uuid;
  v_request_id := nullif(p_data->>'request_id', '')::uuid;
  v_payment_date := coalesce(nullif(p_data->>'payment_date', '')::date, private.today());
  v_notes := coalesce(p_data->>'notes', '');

  SELECT * INTO v_req FROM public.vietqr_requests WHERE id = v_qr_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'VIETQR_REQUEST_NOT_FOUND';
  END IF;

  -- Idempotent check
  IF v_req.status = 'CONFIRMED' THEN
    RETURN v_req.payment_id;
  END IF;

  IF v_req.status = 'CANCELLED' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VIETQR_REQUEST_CANCELLED';
  END IF;

  IF v_req.sale_id IS NOT NULL THEN
    SELECT * INTO v_sale FROM public.sales WHERE id = v_req.sale_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND';
    END IF;
    IF v_sale.status <> 'COMPLETED' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'SALE_CANCELLED';
    END IF;

    -- Kiểm tra số dư còn phải thu
    SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_paid
      FROM public.payments WHERE sale_id = v_req.sale_id AND status = 'ACTIVE';
    IF v_paid + v_req.amount > v_sale.sale_price THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'PAYMENT_EXCEEDS_BALANCE';
    END IF;

    -- Ghi nhận thanh toán chuyển khoản qua hàm nội bộ an toàn add_payment_verified_impl
    v_payment_id := private.add_payment_verified_impl(jsonb_build_object(
      'sale_id', v_req.sale_id,
      'amount', v_req.amount,
      'payment_method', 'BANK_TRANSFER',
      'payment_date', v_payment_date,
      'reference', v_req.qr_reference,
      'notes', CASE WHEN v_notes <> '' THEN v_notes ELSE 'Chuyển khoản VietQR ' || v_req.qr_reference END,
      'request_id', coalesce(v_request_id, gen_random_uuid())
    ));

    UPDATE public.vietqr_requests
    SET status = 'CONFIRMED',
        payment_id = v_payment_id,
        confirmed_by = v_actor,
        confirmed_at = now(),
        updated_at = now()
    WHERE id = v_req.id RETURNING * INTO v_req;

    PERFORM private.audit('CONFIRM_VIETQR_PAYMENT', 'vietqr_requests', v_req.id,
      null, to_jsonb(v_req), v_req.vehicle_id);

    RETURN v_payment_id;
  ELSE
    -- Khi thanh toán trước lúc tạo đơn bán xe
    UPDATE public.vietqr_requests
    SET status = 'CONFIRMED',
        confirmed_by = v_actor,
        confirmed_at = now(),
        updated_at = now()
    WHERE id = v_req.id RETURNING * INTO v_req;

    PERFORM private.audit('CONFIRM_VIETQR_PAYMENT', 'vietqr_requests', v_req.id,
      null, to_jsonb(v_req), v_req.vehicle_id);

    RETURN v_req.id;
  END IF;
END $$;

-- 9. RPC lấy yêu cầu PENDING hiện tại của xe hoặc đơn bán
CREATE OR REPLACE FUNCTION public.get_active_vietqr_request(
  p_vehicle_id uuid,
  p_sale_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_req public.vietqr_requests;
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'ACCESS_DENIED';
  END IF;

  SELECT * INTO v_req FROM public.vietqr_requests
  WHERE (
    (p_sale_id IS NOT NULL AND sale_id = p_sale_id)
    OR (p_sale_id IS NULL AND sale_id IS NULL AND vehicle_id = p_vehicle_id)
  )
  AND status = 'PENDING'
  ORDER BY created_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN to_jsonb(v_req);
END $$;

-- 10. Phân quyền thực thi các hàm trên
REVOKE ALL ON FUNCTION public.create_vietqr_payment_request(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_vietqr_payment_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_vietqr_payment_request(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_vietqr_payment_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_vietqr_payment_request(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_vietqr_payment(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_active_vietqr_request(uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_vietqr_payment_request(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_vietqr_payment_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_vietqr_payment_request(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_vietqr_payment_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_vietqr_payment_request(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_vietqr_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_vietqr_request(uuid, uuid) TO authenticated;

COMMIT;

