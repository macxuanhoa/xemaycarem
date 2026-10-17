-- Gộp bộ lọc trang Đối soát: "Cần bạn xử lý" (ATTENTION) và "Lịch sử" (HISTORY).
-- Đồng thời sửa lỗi whitelist sót 'RECEIVED': migration 20261014000400 thêm trạng thái
-- RECEIVED vào bảng bank_transactions nhưng không cập nhật kiểm tra của
-- list_bank_transactions, nên tab "Chờ hợp đồng" nổ INVALID_INPUT tới giờ.
-- Chữ ký hàm giữ nguyên (p_filters jsonb) nên GRANTS/REVOKE cũ vẫn y hiệu lực.
CREATE OR REPLACE FUNCTION public.list_bank_transactions(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_pending bigint;
  v_status text := nullif(btrim(coalesce(p_filters->>'status', '')), '');
  v_statuses text[];
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
BEGIN
  IF NOT private.can_financials() THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF jsonb_typeof(p_filters) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  -- ATTENTION = mọi thứ còn chờ người quyết; HISTORY = đã ngã ngũ, chỉ để tra.
  IF v_status IS NULL THEN
    v_statuses := NULL;
  ELSIF v_status = 'ATTENTION' THEN
    v_statuses := ARRAY['MATCHED_PENDING','MANUAL_REVIEW','UNMATCHED'];
  ELSIF v_status = 'HISTORY' THEN
    v_statuses := ARRAY['RECEIVED','RECORDED','IGNORED'];
  ELSIF v_status IN ('UNMATCHED','MATCHED_PENDING','MANUAL_REVIEW','RECEIVED','RECORDED','IGNORED') THEN
    v_statuses := ARRAY[v_status];
  ELSE
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;

  SELECT count(*) INTO v_total FROM public.bank_transactions t
    WHERE (v_statuses IS NULL OR t.status = ANY(v_statuses));
  SELECT count(*) INTO v_pending FROM public.bank_transactions t
    WHERE t.status IN ('MATCHED_PENDING', 'MANUAL_REVIEW');

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'provider', t.provider, 'provider_txn_id', t.provider_txn_id,
      'amount', t.amount, 'transfer_at', t.transfer_at, 'reference', t.reference,
      'transfer_content', t.transfer_content, 'sender_name', t.sender_name,
      'sender_bank', t.sender_bank, 'status', t.status, 'match_reason', t.match_reason,
      'qr_request_id', t.qr_request_id, 'sale_id', t.sale_id, 'vehicle_id', t.vehicle_id,
      'sale_code', s.sale_code,
      'vehicle_label', private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code),
      'payment_id', t.payment_id, 'confirmed_by', t.confirmed_by, 'confirmed_at', t.confirmed_at,
      'received_at', t.received_at
    ) ORDER BY t.received_at DESC, t.id DESC), '[]'::jsonb) INTO v_items
  FROM (
    SELECT * FROM public.bank_transactions bt
    WHERE (v_statuses IS NULL OR bt.status = ANY(v_statuses))
    ORDER BY bt.received_at DESC, bt.id DESC
    LIMIT v_limit OFFSET v_offset
  ) t
  LEFT JOIN public.sales s ON s.id = t.sale_id
  LEFT JOIN public.vehicles v ON v.id = t.vehicle_id;

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'pending_count', v_pending);
END $$;
