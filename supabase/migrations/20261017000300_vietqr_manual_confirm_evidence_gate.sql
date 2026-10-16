-- Cổng bằng chứng ngân hàng cho confirm_vietqr_payment — forward-only, CHƯA áp production.
--
-- Bối cảnh: 20261015000200 ("tiền về đúng đơn", mục 5b) khôi phục đường ghi tiền của
-- confirm_vietqr_payment nhưng đồng thời bỏ luôn cổng "phải có bằng chứng ngân hàng".
-- Hệ quả: tài khoản có quyền tài chính bấm nút là ghi thẳng một dòng payments qua
-- private.add_payment_verified_impl cho mã mới PENDING, chưa có giao dịch ngân hàng
-- nào — kể cả khi không còn lối nào trong giao diện gọi RPC này (api.confirmVietQrPayment,
-- src/lib/api.ts:607, có đúng một nơi khai báo và không nơi nào dùng). Ba test DB đang
-- đỏ vì hợp đồng cũ bị phá:
--   tests/db/vietqr-payment.test.mjs:157        "Legacy confirmation cannot manufacture receipt of money"
--   tests/db/smart-sales-automation.test.mjs:95 "OWNER cannot turn a manual claim into a verified bank payment"
--   tests/db/vietqr-lifecycle.test.mjs:199      "manual button, forged bank sale ... cannot create paid state"
--
-- Chính chú giải của 20261015000200 nêu nguyên tắc "tiền vào đúng đơn qua hàm thu nội
-- bộ, không tự xưng phía client". Bản này giữ nguyên mọi thứ 20261015000200 làm được
-- (hòa giải sell_vehicle_impl, khóa vehicle→sale, kiểm tra lại quyền tài chính sau khi
-- chờ khóa, provenance-privacy) và chỉ đặt lại đúng một cổng: chỉ ghi tiền khi yêu cầu
-- đã gắn giao dịch ngân hàng thật — cùng điều kiện mà đường webhook đặt ra
-- (status='RECEIVED' + bank_transaction_id, xem 20261014000400:215). Mã chưa có bằng
-- chứng nhận lại đúng mã lỗi cũ mà modal vẫn hứa với người dùng: "Cà Rem chỉ xác nhận
-- khi ngân hàng báo tiền đã vào đúng tài khoản".
--
-- Không đổi quyền đã cấp: CREATE OR REPLACE giữ nguyên GRANT/REVOKE của 20261010000700.
BEGIN;

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

  IF v_req.status = 'EXPIRED' THEN
    -- Hết đời mã: không được phép tự xưng đã thu bằng nút bấm. Vòng modal bên
    -- khách tự sinh mã mới (auto-reissue), tiền về muộn rơi vào đường ingest.
    RAISE EXCEPTION USING errcode = '22023', message = 'VIETQR_BANK_EVIDENCE_REQUIRED';
  END IF;

  -- Cổng bằng chứng ngân hàng: một cú bấm không được tạo trạng thái "đã thu tiền".
  -- Khoản thu chỉ được ghi khi yêu cầu đã gắn giao dịch ngân hàng thật, đúng cặp
  -- điều kiện mà record_vietqr_bank_credit (webhook) ghi nhận.
  IF v_req.status <> 'RECEIVED' OR v_req.bank_transaction_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VIETQR_BANK_EVIDENCE_REQUIRED';
  END IF;

  IF v_req.sale_id IS NOT NULL THEN
    -- Hòa giải hợp đồng an toàn của nền mới: giành khóa vehicle trước (đúng
    -- thứ tự vehicle→sale mọi đường ghi tiền) rồi KIỂM TRA LẠI quyền tài
    -- chính — quyền bị thu hồi trong lúc chờ khóa phải nhận ACCESS_DENIED,
    -- không được ghi tiền.
    PERFORM 1 FROM public.vehicles
      WHERE id = (SELECT vehicle_id FROM public.sales WHERE id = v_req.sale_id)
      FOR UPDATE;
    IF NOT private.can_financials() THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'ACCESS_DENIED';
    END IF;
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
        receipt_id = coalesce(receipt_id,
          (SELECT pr.id FROM public.payment_receipts pr
           WHERE pr.payment_id = v_payment_id LIMIT 1)),
        confirmed_by = v_actor,
        confirmed_at = now(),
        updated_at = now()
    WHERE id = v_req.id RETURNING * INTO v_req;

    PERFORM private.audit('CONFIRM_VIETQR_PAYMENT', 'vietqr_requests', v_req.id,
      null, to_jsonb(v_req), v_req.vehicle_id);

    RETURN v_payment_id;
  ELSE
    -- Tiền về trước khi lập đơn bán: mã đã có bằng chứng ngân hàng nên giữ nguyên
    -- RECEIVED để sell_vehicle nối chứng từ vào đơn khi lập đơn (hòa giải của
    -- 20261015000200). Không còn đường "bấm tay tự đặt CONFIRMED" — chính đường đó
    -- là thứ cổng ở trên chặn.
    RETURN NULL;
  END IF;
END $$;

COMMIT;
