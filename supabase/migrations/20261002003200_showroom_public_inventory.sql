-- Migration: 20261002003200_showroom_public_inventory.sql
-- Description: Kho xe công khai cho trang Showroom (A1).
--   * /showroom là trang CÔNG KHAI (không đăng nhập). list_vehicles yêu cầu
--     role nội bộ nên không thể dùng trực tiếp; RPC này là chiếu công khai
--     tối thiểu, chỉ trả về an toàn cho khách xem xe.
--   * Chính sách hiển thị (rõ ràng, chủ đích):
--       - CHỈ xe status = 'IN_STOCK' (sẵn sàng bán cho khách mới).
--       - RESERVED (đang giữ chỗ), SOLD, CANCELLED bị LOẠI khỏi showroom
--         vì không còn bán trực tiếp cho khách vãng lai.
--   * Không bao giờ lộ: internal_code, số khung/số máy, giá vốn, chi phí,
--     nhà cung cấp, ghi chú nội bộ. Ảnh xe ở bucket private nên showroom
--     hiển thị placeholder, không phải ảnh giả.
--   * Số liệu thật 100%: biển số, ODO, năm, màu, giá bán đều lấy nguyên văn
--     từ vehicles; thiếu thì client hiển thị "—", không bịa dữ liệu.

CREATE OR REPLACE FUNCTION public.list_showroom_vehicles(p_filters jsonb DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_search text := left(btrim(coalesce(p_filters->>'search', '')), 100);
  v_brand text := left(btrim(coalesce(p_filters->>'brand', '')), 80);
  v_limit integer := least(50, greatest(1, coalesce((p_filters->>'limit')::integer, 24)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
BEGIN
  IF jsonb_typeof(coalesce(p_filters, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.vehicles v
  WHERE v.status = 'IN_STOCK'
    AND (v_search = '' OR concat_ws(' ', v.brand, v.model, v.variant, v.color, v.license_plate)
      ILIKE '%' || v_search || '%')
    AND (v_brand = '' OR v.brand ILIKE v_brand);

  SELECT coalesce(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.sort_at DESC, x.id), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT v.id, v.brand, v.model, v.variant, v.year, v.color,
      nullif(v.license_plate, '') AS license_plate,
      CASE WHEN v.odometer > 0 THEN v.odometer END AS odometer,
      v.asking_price, v.purchase_date, v.created_at,
      v.created_at AS sort_at
    FROM public.vehicles v
    WHERE v.status = 'IN_STOCK'
      AND (v_search = '' OR concat_ws(' ', v.brand, v.model, v.variant, v.color, v.license_plate)
        ILIKE '%' || v_search || '%')
      AND (v_brand = '' OR v.brand ILIKE v_brand)
    ORDER BY v.created_at DESC, v.id
    LIMIT v_limit OFFSET v_offset
  ) x;

  RETURN jsonb_build_object('total', v_total, 'items', v_items);
END $$;

-- Anon truy cập được (showroom công khai). Revoke trước để không sót
-- đặc quyền mặc định của harness/Supabase, rồi mới grant có chủ đích.
REVOKE ALL ON FUNCTION public.list_showroom_vehicles(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_showroom_vehicles(jsonb) TO anon, authenticated, service_role;
