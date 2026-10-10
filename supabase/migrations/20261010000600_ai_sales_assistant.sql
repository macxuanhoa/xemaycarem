-- Migration: 20261010000600_ai_sales_assistant.sql
-- Description: Cà Rem AI Sales Assistant — Post Studio (tạo bài Facebook/Zalo từ xe trong kho)
--   và Trợ lý trả lời tin nhắn khách, dùng chung AI Brand Memory (thư viện bài mẫu + quy tắc
--   phong cách do OWNER duyệt). Forward-only: không sửa migration cũ, không xóa dữ liệu nghiệp vụ.
--   * AN TOÀN DỮ LIỆU: mọi nội dung công khai chỉ được lấy từ "chiếu an toàn Tier-A" — đúng các
--     trường mà /showroom (list_showroom_vehicles, anon) đã công bố từ 2026-10-08: danh tính xe
--     (biển số · số khung · mã nội bộ), loại xe, đời xe, màu sơn, trạng thái, ảnh đăng ký của xe
--     IN_STOCK/SOLD và thông tin liên hệ công khai của cửa hàng. KHÔNG BAO GIỜ rời database qua
--     RPC này: giá thu (vehicle_financials), lợi nhuận, chi phí, công nợ, CCCD, tên/sđt người bán,
--     khách hàng, ghi chú nội bộ (notes). Cấm cả đường SELECT trực tiếp — bảng mới chỉ mở qua
--     SECURITY DEFINER, browser role không có policy nào.
--   * DUYỆT: OWNER là người duyệt cuối. Bản nháp (DRAFT) → APPROVED chỉ do OWNER; khi duyệt có
--     thể đưa ngay vào thư viện bài mẫu (brand_memory APPROVED). Bài mẫu PENDING do
--     MANAGER/STAFF thêm chỉ OWNER mới được duyệt. Bài đã APPROVED không còn sửa được.
--   * XE PHẢI CÒN HÀNG: khi duyệt bài NEW_STOCK/PROMO/MULTI, server đối chiếu trạng thái mới nhất
--     của xe; xe không còn IN_STOCK → POST_STUDIO_STOCK_CHANGED (chống quảng cáo xe đã bán).
--   * THEO DÕI CHI TIÊU AI: post_ai_usage ghi task/model/số token/kết quả theo user, append-only
--     (IMMUTABLE_HISTORY), OWNER đọc tổng hợp qua get_post_ai_usage để canh hạn mức Free Tier.
--   * LỊCH SỬ PHIÊN BẢN: mỗi lần đổi caption của bản nháp lưu một dòng post_draft_edits
--     (nguồn AI hoặc HUMAN), append-only, để so sánh và hồi nhớ bản được duyệt.
-- Phụ thuộc: 20260930000100 (schema nền, private.require_role/audit/immutable_history),
-- 20261008000300 (vehicle_types, private.vehicle_label_text/vehicle_subtitle_text).

BEGIN;

-- ============================================================
-- STEP 1: Bảng thư viện ký ức thương hiệu (bài mẫu + quy tắc, chỉ dùng bản APPROVED)
-- ============================================================

CREATE TABLE public.brand_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type text NOT NULL CHECK (entry_type IN ('EXAMPLE','RULE')),
  channel text NOT NULL DEFAULT 'ANY' CHECK (channel IN ('FACEBOOK','ZALO','MESSENGER','ANY')),
  post_kind text CHECK (post_kind IN ('NEW_STOCK','PROMO','SOLD','MULTI','BUYBACK','REPLY')),
  content text NOT NULL CHECK (char_length(btrim(content)) BETWEEN 3 AND 4000),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','AI','EDITED')),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  approved_by uuid REFERENCES public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_memory_status ON public.brand_memory(status, entry_type, channel);
CREATE INDEX brand_memory_created ON public.brand_memory(created_at DESC);
ALTER TABLE public.brand_memory ENABLE ROW LEVEL SECURITY;
-- Không policy: browser role không đọc/ghi trực tiếp; mọi truy vấn qua RPC bên dưới.
REVOKE ALL ON public.brand_memory FROM public, anon, authenticated;
COMMENT ON TABLE public.brand_memory IS
  'AI Brand Memory: bài đăng mẫu và quy tắc phong cách Cà Rem; chỉ hàng APPROVED được đưa vào ngữ cảnh AI; OWNER duyệt.';

-- ============================================================
-- STEP 2: Bản nháp bài đăng + lịch sử phiên bản
-- ============================================================

CREATE TABLE public.post_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  post_kind text NOT NULL CHECK (post_kind IN ('NEW_STOCK','PROMO','SOLD','MULTI','BUYBACK')),
  channel text NOT NULL CHECK (channel IN ('FACEBOOK','FB_GROUP','ZALO')),
  tone text NOT NULL DEFAULT '' CHECK (length(tone) <= 40),
  caption text NOT NULL CHECK (char_length(btrim(caption)) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','ARCHIVED')),
  ai_generated boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  approved_by uuid REFERENCES public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_drafts_author ON public.post_drafts(created_by, created_at DESC);
CREATE INDEX post_drafts_status ON public.post_drafts(status, created_at DESC);
ALTER TABLE public.post_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_drafts FROM public, anon, authenticated;
COMMENT ON TABLE public.post_drafts IS
  'Bản nháp bài đăng Facebook/Zalo sinh từ chiếu an toàn Tier-A của xe; caption là chữ người dùng đã duyệt — không chứa dữ liệu cấm vì RPC nguồn không bao giờ trả dữ liệu cấm.';

CREATE TABLE public.post_draft_edits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES public.post_drafts(id) ON DELETE CASCADE,
  caption text NOT NULL CHECK (char_length(btrim(caption)) BETWEEN 1 AND 5000),
  source text NOT NULL CHECK (source IN ('AI','HUMAN')),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_draft_edits_draft ON public.post_draft_edits(draft_id, created_at DESC);
ALTER TABLE public.post_draft_edits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_draft_edits FROM public, anon, authenticated;
CREATE TRIGGER immutable_post_draft_edits before update or delete on public.post_draft_edits
  for each row execute function private.immutable_history();
COMMENT ON TABLE public.post_draft_edits IS
  'Lịch sử phiên bản caption (append-only): mỗi lần lưu khác caption ghi thêm một dòng.';

-- ============================================================
-- STEP 3: Sổ đo sử dụng AI (canh hạn mức Free Tier; chỉ chủ quán đọc tổng hợp)
-- ============================================================

CREATE TABLE public.post_ai_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  task text NOT NULL CHECK (task IN ('captions','refine','reply')),
  model text NOT NULL CHECK (length(model) <= 80),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 100000000),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 100000000),
  outcome text NOT NULL CHECK (outcome IN ('OK','ERROR','QUOTA','BLOCKED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_ai_usage_day ON public.post_ai_usage(created_at DESC);
ALTER TABLE public.post_ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_ai_usage FROM public, anon, authenticated;
CREATE TRIGGER immutable_post_ai_usage before update or delete on public.post_ai_usage
  for each row execute function private.immutable_history();
COMMENT ON TABLE public.post_ai_usage IS
  'Đếm tiêu phí AI theo phiên (append-only): user, task, model, token, kết quả. Nội dung bài không nằm ở đây.';

-- ============================================================
-- STEP 4: Chiếu an toàn Tier-A cho xe (nguồn duy nhất của mọi ngữ cảnh AI/bài đăng)
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_post_studio_context(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_row jsonb;
  v_images jsonb;
  v_store jsonb;
BEGIN
  -- Chỉ xe đang bày bán hoặc đã bán (làm bài "xe đã bán") — không lộ xe RESERVED/CANCELLED.
  SELECT jsonb_build_object(
      'id', v.id, 'internal_code', v.internal_code,
      'license_plate', nullif(btrim(v.license_plate), ''),
      'frame_number', nullif(btrim(v.frame_number), ''),
      'vehicle_type', t.name, 'year', v.year,
      'color', nullif(btrim(v.color), ''),
      'status', v.status::text,
      'vehicle_title', private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code),
      'vehicle_subtitle', private.vehicle_subtitle_text(t.name, v.year, v.color),
      'listed_at', v.created_at
    )
  INTO v_row
  FROM public.vehicles v
  JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
  WHERE v.id = p_vehicle_id AND v.status IN ('IN_STOCK','SOLD');
  IF v_row IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='POST_STUDIO_VEHICLE_UNAVAILABLE';
  END IF;
  -- Đường dẫn tương đối của ảnh đã đăng ký (kỷ luật storageGateway: DB không chứa URL).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'storage_path', i.storage_path, 'display_order', i.display_order)
      ORDER BY i.display_order, i.created_at), '[]'::jsonb)
  INTO v_images
  FROM public.vehicle_images i
  WHERE i.vehicle_id = p_vehicle_id AND i.deleted_at IS NULL;
  -- Liên hệ công khai (showroom đang hiển thị công khai ba giá trị này).
  SELECT jsonb_build_object('store_name', s.store_name, 'phone', s.phone, 'address', s.address)
  INTO v_store FROM public.system_settings s WHERE s.id = true;
  RETURN v_row || jsonb_build_object('images', v_images, 'store', v_store, 'actor', v_actor);
END $$;

-- Tìm xe khớp mô tả của khách: chỉ IN_STOCK, chỉ trường Tier-A, tối đa 12 kết quả.
CREATE OR REPLACE FUNCTION public.find_matching_vehicles(p_query text, p_limit integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_query text := lower(left(btrim(coalesce(p_query, '')), 200));
  v_limit integer := least(12, greatest(1, coalesce(p_limit, 8)));
  v_tokens text[];
  v_items jsonb;
BEGIN
  IF v_query = '' THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  -- Tối đa 6 từ khóa dài ≥2 ký tự; MỌI token phải khớp chuỗi mô tả an toàn (AND các token).
  v_tokens := (SELECT (array_agg(tok) FILTER (WHERE char_length(tok) >= 2))[:6]
    FROM unnest(regexp_split_to_array(v_query, '\s+')) AS tok);
  IF v_tokens IS NULL OR cardinality(v_tokens) = 0 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  SELECT coalesce(jsonb_agg(x.row ORDER BY x.created_at DESC, x.id), '[]'::jsonb) INTO v_items
  FROM (
    SELECT v.created_at, v.id,
      jsonb_build_object(
        'id', v.id, 'internal_code', v.internal_code,
        'license_plate', nullif(btrim(v.license_plate), ''),
        'vehicle_type', t.name, 'year', v.year, 'color', nullif(btrim(v.color), ''),
        'status', v.status::text,
        'vehicle_title', private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code),
        'vehicle_subtitle', private.vehicle_subtitle_text(t.name, v.year, v.color),
        'images', (SELECT coalesce(jsonb_agg(path_row.row), '[]'::jsonb) FROM (
            SELECT jsonb_build_object('id', i.id, 'storage_path', i.storage_path) AS row
            FROM public.vehicle_images i
            WHERE i.vehicle_id = v.id AND i.deleted_at IS NULL
            ORDER BY i.display_order, i.created_at LIMIT 3
          ) path_row)
      ) AS row
    FROM public.vehicles v
    JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    WHERE v.status = 'IN_STOCK'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(v_tokens) AS tok(word)
        WHERE lower(concat_ws(' ', t.name, v.color, v.license_plate, v.frame_number,
          v.internal_code, v.year)) NOT ILIKE '%' || tok.word || '%'
      )
    ORDER BY v.created_at DESC, v.id
    LIMIT v_limit
  ) x;
  RETURN jsonb_build_object('items', v_items, 'total', jsonb_array_length(v_items));
END $$;

-- ============================================================
-- STEP 5: RPC bản nháp bài đăng (lưu/liệt kê/phiên bản/duyệt vào thư viện)
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_post_draft(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_role public.user_role := private.current_role();
  v_id uuid := NULLIF(p_data->>'id', '')::uuid;
  v_vehicle uuid := NULLIF(p_data->>'vehicle_id', '')::uuid;
  v_kind text := btrim(coalesce(p_data->>'post_kind', ''));
  v_channel text := btrim(coalesce(p_data->>'channel', ''));
  v_tone text := left(btrim(coalesce(p_data->>'tone', '')), 40);
  v_caption text := btrim(coalesce(p_data->>'caption', ''));
  v_ai boolean := coalesce((p_data->>'ai_generated')::boolean, false);
  v_old public.post_drafts;
  v_row public.post_drafts;
BEGIN
  IF jsonb_typeof(coalesce(p_data, '{}'::jsonb)) <> 'object'
     OR v_kind NOT IN ('NEW_STOCK','PROMO','SOLD','MULTI','BUYBACK')
     OR v_channel NOT IN ('FACEBOOK','FB_GROUP','ZALO')
     OR char_length(v_caption) < 1 OR char_length(v_caption) > 5000 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  IF v_vehicle IS NOT NULL THEN
    -- Xe phải tồn tại và ở trạng thái làm được bài (IN_STOCK/SOLD); server không tin client.
    PERFORM 1 FROM public.vehicles WHERE id = v_vehicle AND status IN ('IN_STOCK','SOLD');
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode='22023', message='POST_STUDIO_VEHICLE_UNAVAILABLE';
    END IF;
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.post_drafts(vehicle_id,post_kind,channel,tone,caption,ai_generated,created_by)
      VALUES (v_vehicle, v_kind, v_channel, v_tone, v_caption, v_ai, v_actor)
      RETURNING * INTO v_row;
    INSERT INTO public.post_draft_edits(draft_id,caption,source,created_by)
      VALUES (v_row.id, v_caption, CASE WHEN v_row.ai_generated THEN 'AI' ELSE 'HUMAN' END, v_actor);
    PERFORM private.audit('SAVE_POST_DRAFT','post_drafts',v_row.id,NULL,
      to_jsonb(v_row) - 'caption', v_row.vehicle_id);
    RETURN v_row.id;
  END IF;
  SELECT * INTO v_old FROM public.post_drafts WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='POST_DRAFT_NOT_FOUND';
  END IF;
  IF v_old.created_by <> v_actor AND v_role <> 'OWNER' THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  IF v_old.status <> 'DRAFT' THEN
    -- Bản đã duyệt/đã lưu trữ là mốc kiểm chứng: lập bản sao mới thay vì sửa.
    RAISE EXCEPTION USING errcode='22023', message='POST_DRAFT_LOCKED';
  END IF;
  UPDATE public.post_drafts
    SET vehicle_id = v_vehicle, post_kind = v_kind, channel = v_channel,
        tone = v_tone, caption = v_caption, ai_generated = v_ai, updated_at = now()
    WHERE id = v_id RETURNING * INTO v_row;
  IF v_row.caption <> v_old.caption THEN
    INSERT INTO public.post_draft_edits(draft_id,caption,source,created_by)
      VALUES (v_id, v_row.caption, CASE WHEN v_row.ai_generated THEN 'AI' ELSE 'HUMAN' END, v_actor);
  END IF;
  PERFORM private.audit('SAVE_POST_DRAFT','post_drafts',v_id,to_jsonb(v_old) - 'caption',
    to_jsonb(v_row) - 'caption', v_row.vehicle_id);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.list_post_drafts(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_role public.user_role := private.current_role();
  v_status text := left(btrim(coalesce(p_filters->>'status', '')), 20);
  v_limit integer := least(50, greatest(1, coalesce((p_filters->>'limit')::integer, 20)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
BEGIN
  IF jsonb_typeof(coalesce(p_filters, '{}'::jsonb)) <> 'object'
     OR (v_status <> '' AND v_status NOT IN ('DRAFT','APPROVED','ARCHIVED')) THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  SELECT count(*) INTO v_total
  FROM public.post_drafts d
  WHERE (v_status = '' OR d.status = v_status)
    AND (v_role IN ('OWNER','MANAGER') OR d.created_by = v_actor);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'vehicle_id', d.vehicle_id, 'post_kind', d.post_kind, 'channel', d.channel,
      'tone', d.tone, 'caption', d.caption, 'status', d.status, 'ai_generated', d.ai_generated,
      'created_by', d.created_by, 'creator_name', p.full_name,
      'approved_by', d.approved_by, 'approved_at', d.approved_at,
      'created_at', d.created_at, 'updated_at', d.updated_at,
      'vehicle_title', CASE WHEN d.vehicle_id IS NULL THEN NULL
        ELSE private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) END
    ) ORDER BY d.created_at DESC, d.id DESC), '[]'::jsonb)
  INTO v_items
  FROM public.post_drafts d
  LEFT JOIN public.profiles p ON p.id = d.created_by
  LEFT JOIN public.vehicles v ON v.id = d.vehicle_id
  WHERE (v_status = '' OR d.status = v_status)
    AND (v_role IN ('OWNER','MANAGER') OR d.created_by = v_actor)
  LIMIT v_limit OFFSET v_offset;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

CREATE OR REPLACE FUNCTION public.list_post_draft_versions(p_draft_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_role public.user_role := private.current_role();
  v_draft public.post_drafts;
  v_items jsonb;
BEGIN
  SELECT * INTO v_draft FROM public.post_drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='POST_DRAFT_NOT_FOUND';
  END IF;
  IF v_draft.created_by <> v_actor AND v_role NOT IN ('OWNER','MANAGER') THEN
    RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'caption', e.caption, 'source', e.source,
      'created_by', e.created_by, 'creator_name', p.full_name, 'created_at', e.created_at
    ) ORDER BY e.created_at DESC, e.id DESC), '[]'::jsonb)
  INTO v_items
  FROM public.post_draft_edits e
  LEFT JOIN public.profiles p ON p.id = e.created_by
  WHERE e.draft_id = p_draft_id;
  RETURN jsonb_build_object('items', v_items, 'current_caption', v_draft.caption,
    'status', v_draft.status);
END $$;

-- Duyệt là việc của chủ quán; lưu trữ thì tác giả (hoặc quản lý) tự làm được.
CREATE OR REPLACE FUNCTION public.set_post_draft_status(p_id uuid, p_status text,
  p_add_to_library boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_role public.user_role := private.current_role();
  v_old public.post_drafts;
  v_example_id uuid := NULL;
BEGIN
  IF p_status NOT IN ('APPROVED','ARCHIVED') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  SELECT * INTO v_old FROM public.post_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='POST_DRAFT_NOT_FOUND';
  END IF;
  IF p_status = 'APPROVED' THEN
    IF v_role <> 'OWNER' THEN
      RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
    END IF;
    IF v_old.status <> 'DRAFT' THEN
      RAISE EXCEPTION USING errcode='22023', message='POST_DRAFT_LOCKED';
    END IF;
    -- Kiểm tra tồn kho mới nhất trước khi xác nhận "xe còn hàng".
    IF v_old.vehicle_id IS NOT NULL AND v_old.post_kind IN ('NEW_STOCK','PROMO','MULTI') THEN
      PERFORM 1 FROM public.vehicles WHERE id = v_old.vehicle_id AND status = 'IN_STOCK';
      IF NOT FOUND THEN
        RAISE EXCEPTION USING errcode='22023', message='POST_STUDIO_STOCK_CHANGED';
      END IF;
    END IF;
    UPDATE public.post_drafts SET status='APPROVED', approved_by=v_actor,
      approved_at=now(), updated_at=now() WHERE id = p_id;
    IF p_add_to_library THEN
      INSERT INTO public.brand_memory(entry_type,channel,post_kind,content,status,source,created_by,approved_by,approved_at)
        VALUES ('EXAMPLE', v_old.channel, v_old.post_kind, v_old.caption, 'APPROVED', 'EDITED',
                v_actor, v_actor, now())
        RETURNING id INTO v_example_id;
    END IF;
  ELSE
    IF v_old.created_by <> v_actor AND v_role NOT IN ('OWNER','MANAGER') THEN
      RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
    END IF;
    UPDATE public.post_drafts SET status='ARCHIVED', updated_at=now() WHERE id = p_id;
  END IF;
  PERFORM private.audit(CASE WHEN p_status = 'APPROVED' THEN 'APPROVE_POST_DRAFT' ELSE 'ARCHIVE_POST_DRAFT' END,
    'post_drafts', p_id, to_jsonb(v_old) - 'caption',
    jsonb_build_object('status', p_status, 'library_example', v_example_id), v_old.vehicle_id);
END $$;

-- ============================================================
-- STEP 6: RPC Brand Memory (OWNER nhập/duyệt; nhân viên chỉ thấy hàng đã duyệt)
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_brand_memory(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_role public.user_role := private.current_role();
  v_status text := left(btrim(coalesce(p_filters->>'status', '')), 20);
  v_entry text := left(btrim(coalesce(p_filters->>'entry_type', '')), 20);
  v_channel text := left(btrim(coalesce(p_filters->>'channel', '')), 20);
  v_limit integer := least(30, greatest(1, coalesce((p_filters->>'limit')::integer, 20)));
  v_items jsonb;
  v_total bigint;
BEGIN
  IF jsonb_typeof(coalesce(p_filters, '{}'::jsonb)) <> 'object'
     OR (v_status <> '' AND v_status NOT IN ('PENDING','APPROVED','REJECTED'))
     OR (v_entry <> '' AND v_entry NOT IN ('EXAMPLE','RULE'))
     OR (v_channel <> '' AND v_channel NOT IN ('FACEBOOK','ZALO','MESSENGER','ANY')) THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  -- Ngoài OWNER: chỉ hàng APPROVED — PENDING là bản chờ chủ quán duyệt, chưa phải bài chuẩn.
  SELECT count(*) INTO v_total
  FROM public.brand_memory m
  WHERE (v_role = 'OWNER' OR m.status = 'APPROVED')
    AND (v_status = '' OR m.status = v_status)
    AND (v_entry = '' OR m.entry_type = v_entry)
    AND (v_channel = '' OR m.channel = v_channel);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'entry_type', m.entry_type, 'channel', m.channel, 'post_kind', m.post_kind,
      'content', m.content, 'status', m.status, 'source', m.source,
      'created_by', m.created_by, 'creator_name', p.full_name,
      'approved_by', m.approved_by, 'approved_at', m.approved_at, 'created_at', m.created_at
    ) ORDER BY m.approved_at DESC NULLS LAST, m.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM public.brand_memory m
  LEFT JOIN public.profiles p ON p.id = m.created_by
  WHERE (v_role = 'OWNER' OR m.status = 'APPROVED')
    AND (v_status = '' OR m.status = v_status)
    AND (v_entry = '' OR m.entry_type = v_entry)
    AND (v_channel = '' OR m.channel = v_channel)
  LIMIT v_limit;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

-- OWNER nhập trực tiếp hàng APPROVED; MANAGER/STAFF chỉ gửi PENDING và không tạo RULE.
CREATE OR REPLACE FUNCTION public.save_brand_memory(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_role public.user_role := private.current_role();
  v_entry text := btrim(coalesce(p_data->>'entry_type', 'EXAMPLE'));
  v_channel text := btrim(coalesce(p_data->>'channel', 'ANY'));
  v_post_kind text := NULLIF(btrim(coalesce(p_data->>'post_kind', '')), '');
  v_content text := btrim(coalesce(p_data->>'content', ''));
  v_status text := btrim(coalesce(p_data->>'status', 'PENDING'));
  v_source text := btrim(coalesce(p_data->>'source', 'MANUAL'));
  v_row public.brand_memory;
BEGIN
  IF jsonb_typeof(coalesce(p_data, '{}'::jsonb)) <> 'object'
     OR v_entry NOT IN ('EXAMPLE','RULE')
     OR v_channel NOT IN ('FACEBOOK','ZALO','MESSENGER','ANY')
     OR (v_post_kind IS NOT NULL AND v_post_kind NOT IN
         ('NEW_STOCK','PROMO','SOLD','MULTI','BUYBACK','REPLY'))
     OR char_length(v_content) < 3 OR char_length(v_content) > 4000
     OR v_status NOT IN ('PENDING','APPROVED')
     OR v_source NOT IN ('MANUAL','AI','EDITED') THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  IF v_role <> 'OWNER' THEN
    IF v_entry = 'RULE' THEN
      RAISE EXCEPTION USING errcode='42501', message='ACCESS_DENIED';
    END IF;
    v_status := 'PENDING';
  END IF;
  INSERT INTO public.brand_memory(entry_type,channel,post_kind,content,status,source,created_by,approved_by,approved_at)
    VALUES (v_entry, v_channel,
            CASE WHEN v_entry = 'RULE' THEN NULL ELSE v_post_kind END,
            v_content, v_status, v_source, v_actor,
            CASE WHEN v_status = 'APPROVED' THEN v_actor ELSE NULL END,
            CASE WHEN v_status = 'APPROVED' THEN now() ELSE NULL END)
    RETURNING * INTO v_row;
  PERFORM private.audit('SAVE_BRAND_MEMORY','brand_memory',v_row.id,NULL,
    jsonb_build_object('entry_type', v_row.entry_type, 'channel', v_row.channel,
      'post_kind', v_row.post_kind, 'status', v_row.status), NULL);
  RETURN v_row.id;
END $$;

CREATE OR REPLACE FUNCTION public.approve_brand_memory(p_id uuid, p_approve boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old public.brand_memory;
BEGIN
  SELECT * INTO v_old FROM public.brand_memory WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='BRAND_MEMORY_NOT_FOUND';
  END IF;
  IF v_old.status <> 'PENDING' THEN
    RAISE EXCEPTION USING errcode='22023', message='BRAND_MEMORY_LOCKED';
  END IF;
  UPDATE public.brand_memory
    SET status = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END,
        approved_by = v_actor, approved_at = now(), updated_at = now()
    WHERE id = p_id;
  PERFORM private.audit(CASE WHEN p_approve THEN 'APPROVE_BRAND_MEMORY' ELSE 'REJECT_BRAND_MEMORY' END,
    'brand_memory', p_id, to_jsonb(v_old),
    jsonb_build_object('status', CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END), NULL);
END $$;

-- ============================================================
-- STEP 7: Đo lường tiêu phí AI (edge function gọi bằng JWT người dùng; OWNER đọc)
-- ============================================================

CREATE OR REPLACE FUNCTION public.log_post_ai_usage(p_task text, p_model text,
  p_input_tokens bigint DEFAULT 0, p_output_tokens bigint DEFAULT 0, p_outcome text DEFAULT 'OK')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
BEGIN
  IF p_task NOT IN ('captions','refine','reply')
     OR p_outcome NOT IN ('OK','ERROR','QUOTA','BLOCKED')
     OR btrim(coalesce(p_model, '')) = '' OR char_length(p_model) > 80 THEN
    RAISE EXCEPTION USING errcode='22023', message='INVALID_INPUT';
  END IF;
  INSERT INTO public.post_ai_usage(user_id,task,model,input_tokens,output_tokens,outcome)
    VALUES (v_actor, p_task, left(btrim(p_model), 80),
            least(greatest(coalesce(p_input_tokens, 0), 0), 100000000),
            least(greatest(coalesce(p_output_tokens, 0), 0), 100000000),
            p_outcome);
END $$;

CREATE OR REPLACE FUNCTION public.get_post_ai_usage(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_days integer := least(90, greatest(1, coalesce(p_days, 7)));
  v_total jsonb;
  v_daily jsonb;
BEGIN
  SELECT jsonb_build_object(
      'days', v_days,
      'requests', count(*),
      'ok', count(*) FILTER (WHERE outcome = 'OK'),
      'quota', count(*) FILTER (WHERE outcome = 'QUOTA'),
      'errors', count(*) FILTER (WHERE outcome IN ('ERROR','BLOCKED')),
      'input_tokens', coalesce(sum(input_tokens), 0),
      'output_tokens', coalesce(sum(output_tokens), 0)
    )
  INTO v_total
  FROM public.post_ai_usage
  WHERE created_at >= now() - make_interval(days => v_days);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'day', u.day, 'requests', u.requests, 'ok', u.ok, 'quota', u.quota,
      'errors', u.errors, 'tokens', u.tokens
    ) ORDER BY u.day), '[]'::jsonb)
  INTO v_daily
  FROM (
    SELECT (created_at at time zone 'Asia/Ho_Chi_Minh')::date AS day,
      count(*) AS requests,
      count(*) FILTER (WHERE outcome = 'OK') AS ok,
      count(*) FILTER (WHERE outcome = 'QUOTA') AS quota,
      count(*) FILTER (WHERE outcome IN ('ERROR','BLOCKED')) AS errors,
      coalesce(sum(input_tokens + output_tokens), 0) AS tokens
    FROM public.post_ai_usage
    WHERE created_at >= now() - make_interval(days => v_days)
    GROUP BY 1
  ) u;
  RETURN v_total || jsonb_build_object('daily', v_daily);
END $$;

-- ============================================================
-- STEP 8: Cấp quyền thực thi — mọi browser role gọi RPC; không có đường vòng
-- ============================================================

REVOKE ALL ON FUNCTION
  public.get_post_studio_context(uuid), public.find_matching_vehicles(text, integer),
  public.save_post_draft(jsonb), public.list_post_drafts(jsonb), public.list_post_draft_versions(uuid),
  public.set_post_draft_status(uuid, text, boolean),
  public.list_brand_memory(jsonb), public.save_brand_memory(jsonb), public.approve_brand_memory(uuid, boolean),
  public.log_post_ai_usage(text, text, bigint, bigint, text), public.get_post_ai_usage(integer)
FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.get_post_studio_context(uuid), public.find_matching_vehicles(text, integer),
  public.save_post_draft(jsonb), public.list_post_drafts(jsonb), public.list_post_draft_versions(uuid),
  public.set_post_draft_status(uuid, text, boolean),
  public.list_brand_memory(jsonb), public.save_brand_memory(jsonb), public.approve_brand_memory(uuid, boolean),
  public.log_post_ai_usage(text, text, bigint, bigint, text), public.get_post_ai_usage(integer)
TO authenticated;

COMMIT;
