-- Migration: 20261012000100_smart_sales_customer_contacts.sql
-- Smart Sales Automation V1 — liên kết khách hàng ↔ xe/đơn bán ↔ số điện thoại ↔
-- kênh liên hệ đã xác minh (Zalo/Messenger cá nhân, Zalo OA, FB Page, SMS).
-- Forward-only: không sửa RPC nghiệp vụ hiện có. RLS mở toàn bộ qua RPC
-- SECURITY DEFINER theo chuẩn dự án (REVOKE ALL trên bảng, client không đụng trực tiếp).
-- Quyền riêng tư tài chính: bảng này KHÔNG chứa giá; handle kênh là PII liên lạc,
-- chỉ người đọc được đơn (OWNER/MANAGER/STAFF) mới truy xuất qua RPC.

BEGIN;

-- ============================================================
-- 1. Bảng liên hệ khách hàng theo kênh
-- ============================================================

CREATE TABLE IF NOT EXISTS public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 20),
  channel text NOT NULL CHECK (channel IN (
    'ZALO_PERSONAL', 'MESSENGER_PERSONAL', 'ZALO_OA', 'FB_MESSENGER', 'SMS', 'OTHER')),
  handle text NOT NULL DEFAULT '' CHECK (length(handle) <= 160),
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 120),
  verified boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR length(note) <= 240),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_id, channel, handle)
);

CREATE INDEX IF NOT EXISTS customer_contacts_sale ON public.customer_contacts (sale_id);
CREATE INDEX IF NOT EXISTS customer_contacts_vehicle ON public.customer_contacts (vehicle_id);
-- Tra soát tự động theo số điên thoại chuẩn hóa (0xxxxxxxxx) khi giao dịch ngân hàng về.
CREATE INDEX IF NOT EXISTS customer_contacts_phone ON public.customer_contacts (phone)
  WHERE phone <> '';

ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_contacts FROM public, anon, authenticated;

-- ============================================================
-- 2. RPC ghi/đọc
-- ============================================================

-- Danh sách liên hệ của một đơn bán. STAFF trở lên (họ cần để mở liên hệ chăm sóc).
CREATE OR REPLACE FUNCTION public.list_sale_contacts(p_sale_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  IF p_sale_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.id = p_sale_id) THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'sale_id', c.sale_id, 'vehicle_id', c.vehicle_id,
      'phone', c.phone, 'channel', c.channel, 'handle', c.handle,
      'display_name', c.display_name, 'verified', c.verified, 'note', c.note,
      'created_by', c.created_by, 'created_at', c.created_at, 'updated_at', c.updated_at
    ) ORDER BY c.verified DESC, c.created_at), '[]'::jsonb)
    INTO v_items
  FROM public.customer_contacts c WHERE c.sale_id = p_sale_id;
  RETURN v_items;
END $$;

-- Chủ cửa hàng bật automation có thể cần thấy liên hệ của mọi đơn.
CREATE OR REPLACE FUNCTION public.list_automation_contacts(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER']::public.user_role[]);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'sale_id', c.sale_id, 'sale_code', s.sale_code,
      'vehicle_id', c.vehicle_id, 'phone', c.phone, 'channel', c.channel,
      'handle', c.handle, 'display_name', c.display_name, 'verified', c.verified,
      'created_at', c.created_at
    ) ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_items
  FROM public.customer_contacts c
  JOIN public.sales s ON s.id = c.sale_id
  LIMIT greatest(1, least(200, coalesce(p_limit, 50)));
  RETURN v_items;
END $$;

-- Thêm hoặc cập nhật (upsert theo sale+channel+handle) một liên hệ.
CREATE OR REPLACE FUNCTION public.save_sale_contact(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_sale public.sales;
  v_contact public.customer_contacts;
  v_id uuid;
  v_channel text;
  v_handle text;
  v_phone text;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  v_id := nullif(p_data->>'id', '')::uuid;
  v_channel := btrim(coalesce(p_data->>'channel', ''));
  v_handle := left(btrim(coalesce(p_data->>'handle', '')), 160);
  v_phone := private.normalize_customer_phone(coalesce(p_data->>'phone', ''));
  IF v_phone = '0' THEN v_phone := ''; END IF;

  IF v_channel NOT IN ('ZALO_PERSONAL','MESSENGER_PERSONAL','ZALO_OA','FB_MESSENGER','SMS','OTHER') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_CHANNEL';
  END IF;
  IF v_channel IN ('ZALO_PERSONAL','MESSENGER_PERSONAL','ZALO_OA','FB_MESSENGER') AND v_handle = ''
     AND v_phone = '' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'CONTACT_IDENTIFIER_REQUIRED';
  END IF;
  IF v_phone <> '' AND v_phone !~ '^0[0-9]{9,10}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PHONE';
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_contact FROM public.customer_contacts WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = 'P0002', message = 'CONTACT_NOT_FOUND';
    END IF;
    UPDATE public.customer_contacts SET
      channel = v_channel,
      handle = v_handle,
      phone = v_phone,
      display_name = left(btrim(coalesce(p_data->>'display_name', display_name)), 120),
      note = nullif(left(btrim(coalesce(p_data->>'note', note, '')), 240), ''),
      updated_at = now()
    WHERE id = v_id RETURNING * INTO v_contact;
    PERFORM private.audit('UPDATE_SALE_CONTACT', 'customer_contacts', v_contact.id,
      null, to_jsonb(v_contact), v_contact.vehicle_id);
    RETURN to_jsonb(v_contact);
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = nullif(p_data->>'sale_id', '')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'SALE_NOT_FOUND';
  END IF;

  INSERT INTO public.customer_contacts (
    sale_id, vehicle_id, phone, channel, handle, display_name, note, created_by
  ) VALUES (
    v_sale.id, v_sale.vehicle_id, v_phone, v_channel, v_handle,
    left(btrim(coalesce(p_data->>'display_name', '')), 120),
    nullif(left(btrim(coalesce(p_data->>'note', '')), 240), ''),
    v_actor
  )
  ON CONFLICT (sale_id, channel, handle) DO UPDATE SET
    phone = EXCLUDED.phone,
    display_name = EXCLUDED.display_name,
    note = EXCLUDED.note,
    updated_at = now()
  RETURNING * INTO v_contact;

  PERFORM private.audit('CREATE_SALE_CONTACT', 'customer_contacts', v_contact.id,
    null, to_jsonb(v_contact), v_contact.vehicle_id);
  RETURN to_jsonb(v_contact);
END $$;

-- Xác minh liên hệ (chủ/MANAGER duyệt để kích hoạt automation gửi lời cảm ơn).
CREATE OR REPLACE FUNCTION public.verify_sale_contact(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_contact public.customer_contacts;
  v_verify boolean := coalesce((p_data->>'verified')::boolean, true);
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  SELECT * INTO v_contact FROM public.customer_contacts
    WHERE id = nullif(p_data->>'id', '')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'CONTACT_NOT_FOUND';
  END IF;
  IF v_contact.verified = v_verify THEN
    RETURN to_jsonb(v_contact);
  END IF;
  UPDATE public.customer_contacts SET verified = v_verify, updated_at = now()
    WHERE id = v_contact.id RETURNING * INTO v_contact;
  PERFORM private.audit(CASE WHEN v_verify THEN 'VERIFY_SALE_CONTACT' ELSE 'UNVERIFY_SALE_CONTACT' END,
    'customer_contacts', v_contact.id, null, to_jsonb(v_contact), v_contact.vehicle_id);
  RETURN to_jsonb(v_contact);
END $$;

CREATE OR REPLACE FUNCTION public.delete_sale_contact(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_contact public.customer_contacts;
BEGIN
  PERFORM private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  SELECT * INTO v_contact FROM public.customer_contacts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'CONTACT_NOT_FOUND';
  END IF;
  DELETE FROM public.customer_contacts WHERE id = v_contact.id;
  PERFORM private.audit('DELETE_SALE_CONTACT', 'customer_contacts', v_contact.id,
    to_jsonb(v_contact), null, v_contact.vehicle_id);
END $$;

-- ============================================================
-- 3. Phân quyền RPC
-- ============================================================

REVOKE ALL ON FUNCTION
  public.list_sale_contacts(uuid), public.list_automation_contacts(integer),
  public.save_sale_contact(jsonb), public.verify_sale_contact(jsonb),
  public.delete_sale_contact(uuid)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION
  public.list_sale_contacts(uuid), public.list_automation_contacts(integer),
  public.save_sale_contact(jsonb), public.verify_sale_contact(jsonb),
  public.delete_sale_contact(uuid)
  TO authenticated;

COMMIT;
