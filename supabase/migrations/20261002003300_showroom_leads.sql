-- Migration: 20261002003300_showroom_leads.sql
-- Description: Lưu yêu cầu liên hệ từ Showroom (A2) — "thảo mai" thành thật.
--   * Trang /showroom hiện chỉ bật Zalo và báo "Đã gửi yêu cầu" giả.
--     Khách phải được ghi nhận thật vào DB TRƯỚC khi UI báo thành công.
--   * Mô hình hiện có không dùng được: customer_communications/message_outbox
--     buộc gắn sale_id (chỉ tin sau bán hàng), customers chỉ suy ra từ sales
--     hoàn tất. Nên bảng tối thiểu showroom_leads là mới, forward-only.
--   * Khách vãng lai (anon) chỉ được INSERT qua create_showroom_lead với
--     SĐT Việt Nam chuẩn hóa + hợp lệ, giới hạn spam 10 phút/SĐT.
--     Anon KHÔNG được đọc danh sách lead; nhân sự đọc/cập nhật trạng thái
--     qua RPC có require_role + audit.
--   * KHÔNG gọi private.audit khi tạo từ anon (audit_logs.user_id là auth.uid()
--     NULL với anon); bản thân row lead kèm created_at là bằng chứng.

-- ============================================================
-- STEP 1: showroom_leads table
-- ============================================================

CREATE TABLE public.showroom_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- BUYBACK: khách muốn bán xe cho cửa hàng (form "Bán xe cho Cà Rem").
  -- VEHICLE_INQUIRY: khách hỏi mua một xe đang bày trong showroom.
  kind TEXT NOT NULL DEFAULT 'VEHICLE_INQUIRY'
    CHECK (kind IN ('BUYBACK', 'VEHICLE_INQUIRY')),
  -- Xe được hỏi (chỉ khi VEHICLE_INQUIRY); ON DELETE SET NULL để lead
  -- không biến mất khi hồ sơ xe bị xóa.
  vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
  vehicle_name TEXT CHECK (vehicle_name IS NULL OR char_length(vehicle_name) <= 160),
  vehicle_year TEXT CHECK (vehicle_year IS NULL OR vehicle_year ~ '^(19|20)[0-9]{2}$'),
  customer_name TEXT NOT NULL CHECK (char_length(customer_name) BETWEEN 2 AND 120),
  -- Số điện thoại đã chuẩn hóa (mở đầu 0, 10 chữ số) ở tầng RPC.
  phone TEXT NOT NULL CHECK (phone ~ '^0[35789][0-9]{8}$'),
  message TEXT CHECK (message IS NULL OR char_length(message) <= 1000),
  expected_price BIGINT CHECK (expected_price IS NULL OR expected_price BETWEEN 0 AND 1000000000000),
  source TEXT NOT NULL DEFAULT 'SHOWROOM_WEB' CHECK (char_length(source) <= 40),
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW', 'CONTACTED', 'CLOSED', 'SPAM')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX showroom_leads_status_created
  ON public.showroom_leads(status, created_at DESC);
CREATE INDEX showroom_leads_phone
  ON public.showroom_leads(phone);

ALTER TABLE public.showroom_leads ENABLE ROW LEVEL SECURITY;
-- Không có policy SELECT/INSERT cho anon/authenticated: mọi truy cập bàn
-- đi qua SECURITY DEFINER RPC bên dưới. REVOKE để harness/Supabase mặc định
-- không mở quyền trực tiếp trên table.
REVOKE ALL ON public.showroom_leads FROM public, anon, authenticated;

-- ============================================================
-- STEP 2: public write RPC (anon được phép)
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_showroom_lead(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind text := coalesce(nullif(btrim(p_data->>'kind'), ''), 'VEHICLE_INQUIRY');
  v_name text := left(btrim(coalesce(p_data->>'customer_name', '')), 120);
  v_phone text := private.normalize_customer_phone(p_data->>'phone');
  v_message text := nullif(left(btrim(coalesce(p_data->>'message', '')), 1000), '');
  v_vehicle_text text := btrim(coalesce(p_data->>'vehicle_id', ''));
  v_vehicle_id uuid;
  v_vehicle_name text := nullif(left(btrim(coalesce(p_data->>'vehicle_name', '')), 160), '');
  v_vehicle_year text := nullif(btrim(coalesce(p_data->>'vehicle_year', '')), '');
  v_expected_text text := nullif(btrim(coalesce(p_data->>'expected_price', '')), '');
  v_source text := left(coalesce(nullif(btrim(coalesce(p_data->>'source', '')), ''), 'SHOWROOM_WEB'), 40);
  v_id uuid;
BEGIN
  IF jsonb_typeof(coalesce(p_data, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  IF v_kind NOT IN ('BUYBACK', 'VEHICLE_INQUIRY') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_KIND';
  END IF;
  IF char_length(v_name) < 2 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_NAME';
  END IF;
  -- Khách gõ tay "84..." (không có dấu +) vẫn là format phổ biến ở VN.
  IF v_phone ~ '^84[35789][0-9]{8}$' THEN
    v_phone := '0' || substr(v_phone, 3);
  END IF;
  IF v_phone !~ '^0[35789][0-9]{8}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PHONE';
  END IF;
  IF v_vehicle_year IS NOT NULL AND v_vehicle_year !~ '^(19|20)[0-9]{2}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_YEAR';
  END IF;
  IF v_expected_text IS NOT NULL AND v_expected_text !~ '^[0-9]{1,13}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PRICE';
  END IF;
  -- Chặn spam: mỗi SĐT chỉ gửi 1 lead / 10 phút.
  IF EXISTS (
    SELECT 1 FROM public.showroom_leads
    WHERE phone = v_phone AND created_at > now() - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION USING errcode = 'P0001', message = 'LEAD_TOO_FREQUENT';
  END IF;
  -- vehicle_id chỉ được giữ nếu đúng định dạng UUID và xe đang bày bán
  -- công khai (IN_STOCK, cùng điều kiện với list_showroom_vehicles).
  IF v_vehicle_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO v_vehicle_id FROM public.vehicles
    WHERE id = v_vehicle_text::uuid AND status = 'IN_STOCK';
  END IF;
  IF v_kind = 'VEHICLE_INQUIRY' AND v_vehicle_id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_NOT_FOUND';
  END IF;
  IF v_kind = 'BUYBACK' AND v_vehicle_name IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_NAME';
  END IF;

  INSERT INTO public.showroom_leads(
    kind, vehicle_id, vehicle_name, vehicle_year, customer_name, phone,
    message, expected_price, source
  ) VALUES (
    v_kind, v_vehicle_id,
    CASE WHEN v_kind = 'BUYBACK' THEN v_vehicle_name END,
    CASE WHEN v_kind = 'BUYBACK' THEN v_vehicle_year END,
    v_name, v_phone, v_message,
    CASE WHEN v_expected_text IS NOT NULL
      THEN LEAST(GREATEST(v_expected_text::bigint, 0), 1000000000000) END,
    v_source
  ) RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ============================================================
-- STEP 3: staff read/triage RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_showroom_leads(p_filters jsonb DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_status text := left(btrim(coalesce(p_filters->>'status', '')), 20);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
BEGIN
  SELECT count(*) INTO v_total FROM public.showroom_leads l
  WHERE v_status = '' OR l.status = v_status;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC, l.id), '[]'::jsonb)
  INTO v_items
  FROM public.showroom_leads l
  WHERE v_status = '' OR l.status = v_status
  LIMIT v_limit OFFSET v_offset;

  RETURN jsonb_build_object('total', v_total, 'items', v_items);
END $$;

CREATE OR REPLACE FUNCTION public.update_showroom_lead_status(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.showroom_leads;
  v_new public.showroom_leads;
BEGIN
  IF p_status NOT IN ('NEW', 'CONTACTED', 'CLOSED', 'SPAM') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_STATUS';
  END IF;
  SELECT * INTO v_old FROM public.showroom_leads WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'LEAD_NOT_FOUND';
  END IF;
  UPDATE public.showroom_leads SET status = p_status WHERE id = p_id RETURNING * INTO v_new;
  PERFORM private.audit('UPDATE_SHOWROOM_LEAD_STATUS', 'showroom_leads', v_new.id,
    jsonb_build_object('status', v_old.status), jsonb_build_object('status', v_new.status));
END $$;

-- ============================================================
-- STEP 4: grants
-- ============================================================

REVOKE ALL ON FUNCTION
  public.create_showroom_lead(jsonb),
  public.list_showroom_leads(jsonb),
  public.update_showroom_lead_status(uuid, text)
FROM public, anon, authenticated;

-- Khách vãng lai chỉ được TẠO lead; đọc/triage dành cho nhân sự đăng nhập.
GRANT EXECUTE ON FUNCTION public.create_showroom_lead(jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.list_showroom_leads(jsonb),
  public.update_showroom_lead_status(uuid, text)
TO authenticated, service_role;
