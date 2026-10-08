-- Migration: 20261008000300_vehicle_type_catalog_and_purge.sql
-- Description: Xoá vĩnh viễn trường thông số xe, thay "Dòng xe" bằng danh mục "Loại xe", tẩy lịch sử cũ.
--   * DROP COLUMN thật trên public.vehicles: hãng xe, dòng xe thương mại, phiên bản,
--     số máy, số km đã đi, giá bán dự kiến. Không giữ cột ẩn, không tương thích ngược,
--     không giá tự động thay thế. Cột `quickpick_*` trên system_settings cũng bị DROP.
--   * "Loại xe" là danh mục do OWNER bảo trì (public.vehicle_types): STAFF chỉ chọn,
--     bắt buộc khi tạo hồ sơ, tên chuẩn hoá chống trùng, thêm loại mới không cần
--     migration. Không map dữ liệu cũ: mọi xe hiện hữu nhận hàng đợi "Chưa phân loại".
--   * Lịch sử: xoá TOÀN BỘ dòng audit_logs, vehicle_activity, notifications,
--     customer_communications, message_outbox (không tombstone). Trigger bất biến
--     được tháo và dựng lại nguyên trạng trong cùng transaction — đây là lần duy nhất
--     hồ sơ truy vết bị tẩy, được ghi rõ trong docs/DECISIONS.md.
--   * Bảo toàn dữ nghiệp vụ: vehicles, vehicle_financials, vehicle_expenses,
--     acquisitions, sales, sale_financials, payments, payment_receipts,
--     identity_documents, vehicle_images, profiles, schedules, system_announcements,
--     showroom_leads, private.operation_receipts.
--   * Định danh hiển thị: tiêu đề = Biển số · Số khung, dòng phụ = Loại xe · Đời xe ·
--     Màu sắc. private.vehicle_display() là nguồn duy nhất phía database, mirrored
--     by src/lib/vehicleDisplay.ts phía frontend.
--   * Giá: sale_price chỉ sinh ra từ form Bán xe (private.sell_vehicle_impl đã không
--     đọc giá từ hồ sơ xe — không đổi). Showroom công khai không trả bất kỳ mức giá nào.
-- Forward-only. Một transaction. Kết thúc có DO block tự kiểm chứng; sai là rollback.

BEGIN;

-- ============================================================
-- STEP 1: Danh mục loại xe
-- ============================================================

CREATE TABLE public.vehicle_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tên hiển thị cho nhân viên. Không hardcode enum: thêm loại mới là INSERT.
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Chống trùng sau chuẩn hoá (thường hoá + nén khoảng trắng ở tầng RPC).
CREATE UNIQUE INDEX vehicle_types_name_norm ON public.vehicle_types (lower(btrim(name)));

ALTER TABLE public.vehicle_types ENABLE ROW LEVEL SECURITY;
-- Không policy: mọi truy cập đi qua RPC SECURITY DEFINER bên dưới.
REVOKE ALL ON public.vehicle_types FROM public, anon, authenticated;

INSERT INTO public.vehicle_types(name) VALUES
  ('Xe số'),
  ('Xe tay ga'),
  ('Xe côn tay'),
  ('Xe điện'),
  ('Ga 50cc'),
  ('Chưa phân loại');

COMMENT ON TABLE public.vehicle_types IS
  'Danh mục loại xe do OWNER bảo trì; vehicles.vehicle_type_id là FK RESTRICT tới bảng này.';

-- ============================================================
-- STEP 2: RPC danh mục
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_vehicle_types()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role := private.current_role();
  v_items jsonb;
BEGIN
  IF v_role IS NULL THEN
    -- Trang showroom công khai (anon): chỉ trả loại đang có xe bày bán, không lộ số lượng.
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.name), '[]'::jsonb)
    INTO v_items
    FROM public.vehicle_types t
    WHERE EXISTS (
      SELECT 1 FROM public.vehicles v
      WHERE v.vehicle_type_id = t.id AND v.status = 'IN_STOCK'
    );
    RETURN v_items;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name,
      'vehicle_count', (SELECT count(*) FROM public.vehicles v WHERE v.vehicle_type_id = t.id)
    ) ORDER BY t.name), '[]'::jsonb)
  INTO v_items
  FROM public.vehicle_types t;
  RETURN v_items;
END $$;

CREATE OR REPLACE FUNCTION public.save_vehicle_type(p_id uuid, p_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_old public.vehicle_types;
  v_new public.vehicle_types;
BEGIN
  IF char_length(v_name) < 2 OR char_length(v_name) > 60 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_TYPE_NAME';
  END IF;
  IF p_id IS NULL THEN
    BEGIN
      INSERT INTO public.vehicle_types(name) VALUES (v_name) RETURNING * INTO v_new;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_TYPE';
    END;
    PERFORM private.audit('CREATE_VEHICLE_TYPE', 'vehicle_types', v_new.id, null,
      jsonb_build_object('name', v_new.name));
  ELSE
    SELECT * INTO v_old FROM public.vehicle_types WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_TYPE_NOT_FOUND';
    END IF;
    IF lower(btrim(v_old.name)) = 'chưa phân loại' AND lower(v_name) <> 'chưa phân loại' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_TYPE_PROTECTED';
    END IF;
    BEGIN
      UPDATE public.vehicle_types SET name = v_name, updated_at = now()
      WHERE id = p_id RETURNING * INTO v_new;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_VEHICLE_TYPE';
    END;
    PERFORM private.audit('UPDATE_VEHICLE_TYPE', 'vehicle_types', v_new.id,
      jsonb_build_object('name', v_old.name), jsonb_build_object('name', v_new.name));
  END IF;
  RETURN jsonb_build_object('id', v_new.id, 'name', v_new.name);
END $$;

CREATE OR REPLACE FUNCTION public.delete_vehicle_type(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_row public.vehicle_types;
BEGIN
  SELECT * INTO v_row FROM public.vehicle_types WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'VEHICLE_TYPE_NOT_FOUND';
  END IF;
  IF lower(btrim(v_row.name)) = 'chưa phân loại' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_TYPE_PROTECTED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vehicles WHERE vehicle_type_id = p_id) THEN
    RAISE EXCEPTION USING errcode = '23503', message = 'VEHICLE_TYPE_IN_USE';
  END IF;
  DELETE FROM public.vehicle_types WHERE id = p_id;
  PERFORM private.audit('DELETE_VEHICLE_TYPE', 'vehicle_types', p_id,
    jsonb_build_object('name', v_row.name), null);
END $$;

-- ============================================================
-- STEP 3: Tẩy lịch sử (quyết định chủ quán: không tombstone)
-- ============================================================
-- Trigger bất biến được tháo rồi dựng lại NGUYÊN TRẠNG trong cùng transaction.
-- sale_financials.immutable_sale_snapshot không bị đụng tới: snapshot lãi/lỗ vẫn
-- bất biến tuyệt đối.

DROP TRIGGER immutable_audit ON public.audit_logs;
DROP TRIGGER immutable_activity ON public.vehicle_activity;

DELETE FROM public.message_outbox;
DELETE FROM public.customer_communications;
DELETE FROM public.notifications;
DELETE FROM public.vehicle_activity;
DELETE FROM public.audit_logs;

CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION private.immutable_history();
CREATE TRIGGER immutable_activity BEFORE UPDATE OR DELETE ON public.vehicle_activity
  FOR EACH ROW EXECUTE FUNCTION private.immutable_history();

-- ============================================================
-- STEP 4: Cột mới trên vehicles + DROP cột cũ
-- ============================================================
-- Không map dữ liệu cũ: SH 160i không suy ra được "Xe tay ga". Toàn bộ xe nhận
-- hàng đợi "Chưa phân loại" và nhân viên phân loại lại thủ công khi sửa hồ sơ.

ALTER TABLE public.vehicles
  ADD COLUMN vehicle_type_id uuid REFERENCES public.vehicle_types(id);

UPDATE public.vehicles SET vehicle_type_id = t.id
FROM public.vehicle_types t WHERE lower(btrim(t.name)) = 'chưa phân loại';

ALTER TABLE public.vehicles ALTER COLUMN vehicle_type_id SET NOT NULL;
CREATE INDEX vehicles_vehicle_type ON public.vehicles(vehicle_type_id);

ALTER TABLE public.vehicles
  DROP COLUMN brand CASCADE,
  DROP COLUMN model CASCADE,
  DROP COLUMN variant CASCADE,
  DROP COLUMN engine_number CASCADE,
  DROP COLUMN odometer CASCADE,
  DROP COLUMN asking_price CASCADE;

DROP INDEX IF EXISTS public.vehicles_engine_number;

ALTER TABLE public.system_settings
  DROP COLUMN quickpick_brands CASCADE,
  DROP COLUMN quickpick_models CASCADE;

-- ============================================================
-- STEP 5: Helper định danh & hiển thị (nguồn duy nhất phía database)
-- ============================================================
-- Chữ ký cũ (hãng + dòng xe) bị loại bỏ hoàn toàn; mọi hàm gọi cũ được dựng lại
-- theo chữ ký mới ở các bước dưới đây.

DROP FUNCTION IF EXISTS private.vehicle_label_text(text, text, text, text);

CREATE OR REPLACE FUNCTION private.vehicle_label_text(
  p_license_plate text, p_frame_number text, p_internal_code text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_license_plate, '')) <> '' AND btrim(coalesce(p_frame_number, '')) <> ''
      THEN btrim(p_license_plate) || ' · ' || btrim(p_frame_number)
    WHEN btrim(coalesce(p_license_plate, '')) <> ''
      THEN btrim(p_license_plate) || ' · chưa có khung'
    WHEN btrim(coalesce(p_frame_number, '')) <> ''
      THEN 'chưa có biển · ' || btrim(p_frame_number)
    ELSE coalesce(nullif(btrim(coalesce(p_internal_code, '')), ''), 'xe không rõ danh tính')
  END;
$$;

CREATE OR REPLACE FUNCTION private.vehicle_subtitle_text(
  p_vehicle_type text, p_year integer, p_color text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(btrim(concat_ws(' · ',
    nullif(btrim(coalesce(p_vehicle_type, '')), ''),
    p_year::text,
    nullif(btrim(coalesce(p_color, '')), ''))), '');
$$;

-- Tiêu đề + dòng phụ + tên loại xe cho một hàng vehicles. Mọi projection (danh sách,
-- chi tiết, phiếu in, thông báo, tìm kiếm, copilot, showroom) gọi qua đây.
CREATE OR REPLACE FUNCTION private.vehicle_display(p_vehicle public.vehicles)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type text;
BEGIN
  SELECT name INTO v_type FROM public.vehicle_types WHERE id = p_vehicle.vehicle_type_id;
  RETURN jsonb_build_object(
    'vehicle_type', v_type,
    'vehicle_title', private.vehicle_label_text(
      p_vehicle.license_plate, p_vehicle.frame_number, p_vehicle.internal_code),
    'vehicle_subtitle', private.vehicle_subtitle_text(v_type, p_vehicle.year, p_vehicle.color)
  );
END $$;


-- ============================================================
-- STEP 6: Chuẩn hoá loại xe khi ghi (fail closed)
-- ============================================================

CREATE OR REPLACE FUNCTION private.vehicle_type_input(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_raw text; v_id uuid;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  -- Nhận id trực tiếp; tên chỉ dùng cho nhập bảng (CSV) và được tra cứu không phân biệt hoa thường.
  v_raw := btrim(coalesce(p_data->>'vehicle_type_id', ''));
  IF v_raw = '' THEN
    v_raw := btrim(coalesce(p_data->>'vehicle_type', ''));
    IF v_raw = '' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'VEHICLE_TYPE_REQUIRED';
    END IF;
    SELECT id INTO v_id FROM public.vehicle_types WHERE lower(btrim(name)) = lower(v_raw);
    IF v_id IS NULL THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_TYPE';
    END IF;
    RETURN v_id;
  END IF;
  BEGIN
    v_id := v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_TYPE';
  END;
  IF NOT EXISTS (SELECT 1 FROM public.vehicle_types WHERE id = v_id) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_VEHICLE_TYPE';
  END IF;
  RETURN v_id;
END $$;

-- Bản tùy chọn cho CẬP NHẬT từng phần (ví dụ chỉ đổi trạng thái): thiếu cả hai key thì
-- giữ loại xe đang có, nhưng key đã gửi mà sai vẫn bị từ chối — không âm thầm bỏ qua.
CREATE OR REPLACE FUNCTION private.vehicle_type_input_optional(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  IF btrim(coalesce(p_data->>'vehicle_type_id', '')) = ''
     AND btrim(coalesce(p_data->>'vehicle_type', '')) = '' THEN
    RETURN NULL;
  END IF;
  RETURN private.vehicle_type_input(p_data);
END $$;

-- ============================================================
-- STEP 7: Projection xe · bản bán · thông báo nghiệp vụ
-- ============================================================

CREATE OR REPLACE FUNCTION private.vehicle_json(p_vehicle public.vehicles)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare v_purchase bigint; v_expenses bigint; v_result jsonb; v_end date;
begin
  select purchase_price into v_purchase from public.vehicle_financials where vehicle_id=p_vehicle.id;
  if p_vehicle.status='SOLD' then select sale_date into v_end from public.sales where vehicle_id=p_vehicle.id and status='COMPLETED'; end if;
  v_result:=to_jsonb(p_vehicle)||private.vehicle_display(p_vehicle)||jsonb_build_object('cost_pending',v_purchase is null,'days_in_inventory',greatest(0,coalesce(v_end,private.today())-p_vehicle.purchase_date));
  if private.can_financials() then
    select private.safe_money(coalesce(sum(amount),0)) into v_expenses from public.vehicle_expenses where vehicle_id=p_vehicle.id and status='ACTIVE';
    v_result:=v_result||jsonb_build_object('purchase_price',v_purchase,'expense_total',v_expenses,'total_cost',private.safe_money(v_purchase::numeric+v_expenses));
  end if;
  return v_result;
end $$;

CREATE OR REPLACE FUNCTION private.sale_json(p_sale public.sales)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_vehicle public.vehicles;
  v_paid bigint;
  v_result jsonb;
  v_fin public.sale_financials;
  v_remaining bigint;
  v_debt_status text;
  v_is_overdue boolean := false;
  v_today date := private.today();
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_sale.vehicle_id;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_paid FROM public.payments WHERE sale_id = p_sale.id AND status = 'ACTIVE';
  v_remaining := CASE WHEN p_sale.status = 'COMPLETED' THEN greatest(0, p_sale.sale_price - v_paid) ELSE 0 END;

  IF p_sale.status = 'CANCELLED' THEN
    v_debt_status := 'CANCELLED';
  ELSIF v_remaining <= 0 THEN
    v_debt_status := 'PAID';
  ELSE
    IF p_sale.due_date IS NOT NULL AND p_sale.due_date < v_today THEN
      v_is_overdue := true;
      v_debt_status := 'OVERDUE';
    ELSIF v_paid > 0 THEN
      v_debt_status := 'PARTIALLY_PAID';
    ELSE
      v_debt_status := 'UNPAID';
    END IF;
  END IF;

  v_result := to_jsonb(p_sale) || jsonb_build_object(
    'vehicle', to_jsonb(v_vehicle),
    'vehicle_code', v_vehicle.internal_code,
    'internal_code', v_vehicle.internal_code,
    'license_plate', v_vehicle.license_plate,
    'paid_amount', v_paid,
    'remaining_amount', v_remaining,
    'due_date', p_sale.due_date,
    'debt_status', v_debt_status,
    'is_overdue', v_is_overdue
  ) || private.vehicle_display(v_vehicle);

  IF private.can_financials() THEN
    SELECT * INTO v_fin FROM public.sale_financials WHERE sale_id = p_sale.id;
    v_result := v_result || jsonb_build_object(
      'purchase_cost_snapshot', v_fin.purchase_cost_snapshot,
      'expense_cost_snapshot', v_fin.expense_cost_snapshot,
      'total_cost_snapshot', v_fin.total_cost_snapshot,
      'gross_profit', v_fin.gross_profit
    );
  END IF;

  RETURN v_result;
END $$;

-- Copy thông báo dùng danh tính biển · khung: không hãng xe, không giá dự kiến.
CREATE OR REPLACE FUNCTION private.notify_from_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text := NEW.action;
  v_actor uuid := coalesce(NEW.user_id, auth.uid());
  v_new jsonb := coalesce(NEW.new_data, '{}'::jsonb);
  v_actor_name text;
  v_label text;
  v_sale uuid;
  v_sale_code text;
  v_vehicle uuid;
  v_extra uuid;               -- entity owner to include beyond actor + bosses
  v_title text;
  v_body_money text;          -- copy shown to finance-visible recipients
  v_body_plain text;          -- copy shown to everyone else
  v_link text;
  v_amount bigint;
  v_reason text;
  v_customer text;
  v_seller text;
  r record;
BEGIN
  IF v_action NOT IN ('CREATE_ACQUISITION','CANCEL_ACQUISITION','CREATE_SALE','CANCEL_SALE',
                      'CREATE_PAYMENT','VOID_PAYMENT','CREATE_VEHICLE','UPDATE_VEHICLE',
                      'REQUEST_DELETE_VEHICLE') THEN
    RETURN NEW;
  END IF;

  -- Dedup: CREATE_VEHICLE issued inside acquire_vehicle (CREATE_ACQUISITION audited
  -- first, same transaction, same vehicle id) must not double-notify.
  IF v_action = 'CREATE_VEHICLE' AND EXISTS (
    SELECT 1 FROM public.audit_logs al
    WHERE al.action = 'CREATE_ACQUISITION'
      AND al.created_at = NEW.created_at
      AND al.new_data -> 'vehicle' ->> 'id' = NEW.entity_id::text
  ) THEN
    RETURN NEW;
  END IF;

  v_actor_name := coalesce(
    (SELECT p.full_name FROM public.profiles p WHERE p.id = v_actor), 'Hệ thống');

  IF v_action = 'CREATE_ACQUISITION' THEN
    v_vehicle := (v_new -> 'vehicle' ->> 'id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thu');
    v_seller := nullif(btrim(coalesce(v_new ->> 'seller_name', '')), '');
    -- purchase_price 0 means "chờ giá vốn" (cost pending), not a real price.
    v_amount := NULLIF((v_new ->> 'purchase_price')::bigint, 0);
    v_title := left('Thu vào xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã thu vào xe ' || v_label
      || coalesce(' từ ' || v_seller, '')
      || coalesce(', giá vốn ' || private.money_text(v_amount), '');
    v_body_plain := v_actor_name || ' đã thu vào xe ' || v_label;
    v_link := '/acquisitions';
  ELSIF v_action = 'CANCEL_ACQUISITION' THEN
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã thu');
    v_extra := (v_new ->> 'created_by')::uuid;
    v_reason := nullif(btrim(coalesce(v_new ->> 'cancellation_reason', '')), '');
    v_title := left('Hủy thu xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã hủy phiếu thu xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '');
    v_body_plain := v_body_money;
    v_link := '/acquisitions';
  ELSIF v_action = 'CREATE_SALE' THEN
    v_sale := NEW.entity_id;
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã bán');
    v_customer := nullif(btrim(coalesce(v_new ->> 'customer_name', '')), '');
    v_amount := (v_new ->> 'sale_price')::bigint;
    v_extra := (SELECT v2.created_by FROM public.vehicles v2 WHERE v2.id = v_vehicle);
    v_title := left('Bán xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã bán xe ' || v_label
      || coalesce(' cho ' || v_customer, '')
      || coalesce(', giá bán ' || private.money_text(v_amount), '');
    v_body_plain := v_actor_name || ' đã bán xe ' || v_label
      || coalesce(' cho ' || v_customer, '');
    v_link := '/sales/' || v_sale;
    -- The initial payment recorded inside sell_vehicle shares this transaction;
    -- its standalone notification is redundant noise. now() is stable per txn.
    DELETE FROM public.notifications n
    WHERE n.action = 'CREATE_PAYMENT'
      AND n.created_at = NEW.created_at
      AND n.deep_link = '/sales/' || v_sale::text;
  ELSIF v_action = 'CANCEL_SALE' THEN
    v_sale := NEW.entity_id;
    v_vehicle := (v_new ->> 'vehicle_id')::uuid;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe đã bán');
    v_extra := (v_new ->> 'sold_by')::uuid;
    v_reason := nullif(btrim(coalesce(v_new ->> 'cancellation_reason', '')), '');
    v_title := left('Hủy bán xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã hủy giao dịch bán xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '');
    v_body_plain := v_body_money;
    v_link := '/sales/' || v_sale;
    -- Same-transaction VOID_PAYMENT rows come from the cancel cascade, not a
    -- standalone correction; the CANCEL_SALE notice covers them.
    DELETE FROM public.notifications n
    WHERE n.action = 'VOID_PAYMENT'
      AND n.created_at = NEW.created_at
      AND n.deep_link = '/sales/' || v_sale::text;
  ELSIF v_action = 'CREATE_PAYMENT' OR v_action = 'VOID_PAYMENT' THEN
    v_sale := (v_new ->> 'sale_id')::uuid;
    v_amount := (v_new ->> 'amount')::bigint;
    SELECT s.sale_code, s.sold_by,
           private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_sale_code, v_extra, v_label
    FROM public.sales s
    JOIN public.vehicles v ON v.id = s.vehicle_id
    WHERE s.id = v_sale;
    v_vehicle := (SELECT s2.vehicle_id FROM public.sales s2 WHERE s2.id = v_sale);
    v_label := coalesce(v_label, 'xe đã bán');
    IF v_action = 'CREATE_PAYMENT' THEN
      v_title := left('Thu tiền đơn ' || coalesce(v_sale_code, 'bán xe'), 160);
      v_body_money := v_actor_name || ' đã ghi nhận thu ' || private.money_text(v_amount)
        || ' cho đơn bán xe ' || v_label;
      v_body_plain := v_actor_name || ' đã ghi nhận một khoản thu cho đơn bán xe ' || v_label;
    ELSE
      v_title := left('Hủy khoản thu đơn ' || coalesce(v_sale_code, 'bán xe'), 160);
      v_body_money := v_actor_name || ' đã hủy khoản thu ' || private.money_text(v_amount)
        || ' của đơn bán xe ' || v_label;
      v_body_plain := v_actor_name || ' đã hủy một khoản thu của đơn bán xe ' || v_label;
    END IF;
    v_link := '/sales/' || v_sale;
  ELSIF v_action = 'CREATE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe mới thêm');
    v_title := left('Thêm xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã thêm xe ' || v_label || ' vào tồn kho';
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  ELSIF v_action = 'REQUEST_DELETE_VEHICLE' THEN
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_reason := nullif(btrim(coalesce(v_new ->> 'reason', '')), '');
    v_title := left('Yêu cầu xóa xe ' || v_label, 160);
    v_body_money := v_actor_name || ' gửi yêu cầu xóa xe ' || v_label
      || coalesce('. Lý do: ' || v_reason, '') || ' — đang chờ chủ cửa hàng duyệt.';
    v_body_plain := v_body_money;
    v_link := '/approvals';
  ELSE -- UPDATE_VEHICLE
    v_vehicle := NEW.entity_id;
    SELECT private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code)
      INTO v_label FROM public.vehicles v WHERE v.id = v_vehicle;
    v_label := coalesce(v_label, 'xe trong kho');
    v_extra := (v_new ->> 'created_by')::uuid;
    v_title := left('Cập nhật xe ' || v_label, 160);
    v_body_money := v_actor_name || ' đã cập nhật thông tin xe ' || v_label;
    v_body_plain := v_body_money;
    v_link := '/vehicles/' || NEW.entity_id;
  END IF;

  -- Recipients: the actor (all roles, self-confirmation), every active
  -- OWNER/MANAGER, plus the non-acting owner of the affected transaction.
  FOR r IN
    SELECT p.id, p.role, p.can_view_financials FROM public.profiles p
    WHERE p.id = v_actor
       OR (p.role IN ('OWNER', 'MANAGER') AND p.active)
       OR (v_extra IS NOT NULL AND p.id = v_extra AND p.active
           AND (v_actor IS NULL OR p.id <> v_actor))
    GROUP BY p.id, p.role, p.can_view_financials
  LOOP
    -- Money copy only for OWNER, finance-visible MANAGERs, and the actor itself.
    IF r.role = 'OWNER' OR (r.role = 'MANAGER' AND r.can_view_financials) OR r.id = v_actor THEN
      INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                        vehicle_id, title, body, deep_link)
      VALUES (r.id, v_actor, v_action, NEW.entity_type, NEW.entity_id,
              v_vehicle, v_title, left(v_body_money, 400), v_link);
    ELSE
      INSERT INTO public.notifications (user_id, actor_id, action, entity_type, entity_id,
                                        vehicle_id, title, body, deep_link)
      VALUES (r.id, v_actor, v_action, NEW.entity_type, NEW.entity_id,
              v_vehicle, v_title, left(v_body_plain, 400), v_link);
    END IF;
  END LOOP;

  RETURN NEW;
END $$;


-- ============================================================
-- STEP 8: Hàm ghi (Hồ sơ xe / Thu xe / Nhập bảng / Cài đặt)
-- ============================================================

CREATE OR REPLACE FUNCTION private.save_vehicle_impl(p_data jsonb, p_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_old public.vehicles; v_new public.vehicles; v_purchase bigint; v_old_purchase bigint;
  v_status public.vehicle_status; v_date date; v_old_json jsonb;
  v_frame text; v_type uuid;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;
  IF p_data ? 'purchase_price' AND NOT private.can_financials() THEN RAISE EXCEPTION USING errcode='42501',message='FINANCIAL_ACCESS_DENIED'; END IF;
  -- Tạo hồ sơ mới bắt buộc chọn loại xe; sửa từng phần thì loại xe cũ được giữ.
  IF p_id IS NULL THEN
    v_type := private.vehicle_type_input(p_data);
  ELSE
    v_type := private.vehicle_type_input_optional(p_data);
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.vehicles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='VEHICLE_NOT_FOUND'; END IF;
    PERFORM private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
    IF EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_id = p_id AND ar.kind = 'VEHICLE_DELETION' AND ar.status = 'PENDING') THEN
      RAISE EXCEPTION USING errcode='22023',message='DELETE_PENDING';
    END IF;
    IF p_data ? 'expected_updated_at' AND v_old.updated_at IS DISTINCT FROM (p_data->>'expected_updated_at')::timestamptz THEN
      RAISE EXCEPTION USING errcode='40001',message='VEHICLE_EDIT_CONFLICT';
    END IF;
    IF p_data ? 'purchase_price' AND NOT private.can_financials() THEN
      RAISE EXCEPTION USING errcode='42501',message='FINANCIAL_ACCESS_DENIED';
    END IF;
    SELECT purchase_price INTO v_old_purchase FROM public.vehicle_financials WHERE vehicle_id = p_id;
  END IF;
  v_status := COALESCE((p_data->>'status')::public.vehicle_status, v_old.status, 'IN_STOCK');
  IF v_status = 'SOLD' AND (p_id IS NULL OR v_old.status <> 'SOLD') THEN RAISE EXCEPTION USING errcode='22023',message='USE_SELL_VEHICLE'; END IF;
  v_purchase := private.money_input(p_data, 'purchase_price', v_old_purchase);
  v_date := COALESCE((p_data->>'purchase_date')::date, v_old.purchase_date, private.today());
  IF v_date > private.today() THEN RAISE EXCEPTION USING errcode='22023',message='FUTURE_DATE'; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.vehicle_expenses WHERE vehicle_id = p_id AND status = 'ACTIVE' AND expense_date < v_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='PURCHASE_AFTER_EXPENSE';
  END IF;
  IF v_old.status = 'SOLD' AND (v_status <> 'SOLD' OR v_purchase IS DISTINCT FROM v_old_purchase
      OR v_date <> v_old.purchase_date) THEN
    RAISE EXCEPTION USING errcode='22023',message='SOLD_VEHICLE_LOCKED';
  END IF;

  v_frame := COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), 'GEN-' || substr(gen_random_uuid()::text, 1, 12));

  IF p_id IS NULL THEN
    INSERT INTO public.vehicles(
      license_plate, vehicle_type_id, year, color, frame_number,
      purchase_date, status, supplier_name, supplier_phone, notes, created_by
    ) VALUES (
      btrim(COALESCE(p_data->>'license_plate', '')), v_type,
      NULLIF(p_data->>'year', '')::integer, btrim(COALESCE(p_data->>'color', '')), v_frame,
      v_date, v_status,
      btrim(COALESCE(p_data->>'supplier_name', '')), btrim(COALESCE(p_data->>'supplier_phone', '')), COALESCE(p_data->>'notes', ''), v_actor
    ) RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by) VALUES (v_new.id, v_purchase, v_actor);
    -- Audit kèm TÊN loại xe (không chỉ vehicle_type_id) để bảng truy vết đọc được
    -- bằng tiếng người; phía client bỏ cột *_id nên nếu không có tên thì đổi loại
    -- xe sẽ không hiện ra trong phần "trước → sau".
    PERFORM private.audit('CREATE_VEHICLE', 'vehicles', v_new.id, NULL,
      to_jsonb(v_new)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_new.vehicle_type_id)),
      v_new.id);
  ELSE
    v_old_json := to_jsonb(v_old)
      || jsonb_build_object('purchase_price', v_old_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_old.vehicle_type_id));
    UPDATE public.vehicles SET
      license_plate = btrim(COALESCE(p_data->>'license_plate', license_plate)),
      vehicle_type_id = COALESCE(v_type, vehicle_type_id),
      year = CASE WHEN p_data ? 'year' THEN NULLIF(p_data->>'year', '')::integer ELSE year END,
      color = btrim(COALESCE(p_data->>'color', color)),
      frame_number = COALESCE(NULLIF(btrim(coalesce(p_data->>'frame_number','')), ''), frame_number),
      purchase_date = v_date,
      status = v_status,
      supplier_name = btrim(COALESCE(p_data->>'supplier_name', supplier_name)),
      supplier_phone = btrim(COALESCE(p_data->>'supplier_phone', supplier_phone)),
      notes = COALESCE(p_data->>'notes', notes),
      updated_at = now()
    WHERE id = p_id RETURNING * INTO v_new;

    INSERT INTO public.vehicle_financials(vehicle_id, purchase_price, updated_by)
      VALUES (p_id, v_purchase, v_actor)
      ON CONFLICT (vehicle_id) DO UPDATE
        SET purchase_price = EXCLUDED.purchase_price, updated_by = EXCLUDED.updated_by, updated_at = now();

    PERFORM private.audit('UPDATE_VEHICLE', 'vehicles', v_new.id, v_old_json,
      to_jsonb(v_new)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_new.vehicle_type_id)),
      v_new.id);
  END IF;
  RETURN v_new.id;
END $$;

CREATE OR REPLACE FUNCTION private.acquire_vehicle_impl(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_frame text := btrim(coalesce(p_data->>'frame_number', ''));
  v_vehicle_id uuid;
  v_vehicle public.vehicles;
  v_acquisition public.acquisitions;
  v_purchase bigint := private.money_input(p_data, 'purchase_price');
  v_type uuid;
  v_date date := coalesce((p_data->>'acquisition_date')::date, private.today());
  v_fin boolean := private.can_financials();
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  v_type := private.vehicle_type_input(p_data);

  IF p_data ? 'purchase_price' AND NOT v_fin THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
  END IF;

  IF v_frame = '' THEN
    v_frame := 'GEN-' || substr(gen_random_uuid()::text, 1, 12);
  END IF;

  IF v_date > private.today() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE';
  END IF;

  SELECT id INTO v_vehicle_id FROM public.vehicles WHERE frame_number = v_frame;
  IF v_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_vehicle_id FOR UPDATE;
    IF v_vehicle.status NOT IN ('CANCELLED') THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_FRAME_NUMBER';
    END IF;
  END IF;

  INSERT INTO public.vehicles (
    frame_number, license_plate,
    vehicle_type_id, year, color,
    purchase_date, status,
    supplier_name, supplier_phone, notes, created_by
  ) VALUES (
    v_frame,
    btrim(coalesce(p_data->>'license_plate', '')),
    v_type,
    nullif(p_data->>'year', '')::integer,
    btrim(coalesce(p_data->>'color', '')),
    v_date,
    'IN_STOCK'::public.vehicle_status,
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'notes', ''),
    v_actor
  ) RETURNING * INTO v_vehicle;

  INSERT INTO public.vehicle_financials (vehicle_id, purchase_price, updated_by)
  VALUES (v_vehicle.id, v_purchase, v_actor);

  INSERT INTO public.acquisitions (
    vehicle_id, acquisition_date, purchase_price,
    seller_name, seller_phone, notes, status, created_by
  ) VALUES (
    v_vehicle.id,
    v_date,
    coalesce(v_purchase, 0),
    btrim(coalesce(p_data->>'seller_name', '')),
    btrim(coalesce(p_data->>'seller_phone', '')),
    coalesce(p_data->>'acquisition_notes', ''),
    'COMPLETED'::public.acquisition_status,
    v_actor
  ) RETURNING * INTO v_acquisition;

  PERFORM private.audit(
    'CREATE_ACQUISITION', 'acquisitions', v_acquisition.id,
    null,
    to_jsonb(v_acquisition) || jsonb_build_object('vehicle', to_jsonb(v_vehicle)),
    v_vehicle.id
  );

  PERFORM private.audit(
    'CREATE_VEHICLE', 'vehicles', v_vehicle.id,
    null,
    to_jsonb(v_vehicle)
      || jsonb_build_object('purchase_price', v_purchase)
      || jsonb_build_object('vehicle_type',
           (SELECT t.name FROM public.vehicle_types t WHERE t.id = v_vehicle.vehicle_type_id)),
    v_vehicle.id
  );

  RETURN v_vehicle.id;
END $$;

-- Soát từng dòng của file nhập: bỏ khuôn trường cũ, bắt buộc loại xe.
-- Tên không khớp danh mục bị từ chối, không tự dịch sang loại gần giống.
CREATE OR REPLACE FUNCTION public.validate_import_vehicles(p_vehicles jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_row jsonb;
  v_index integer;
  v_field text;
  v_value text;
  v_seen_frames text[] := ARRAY[]::text[];
  v_seen_plates text[] := ARRAY[]::text[];
  v_duplicates jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_date date;
  v_number integer;
BEGIN
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;
  IF jsonb_array_length(p_vehicles) > 500 THEN RAISE EXCEPTION USING errcode = '22023', message = 'IMPORT_BATCH_TOO_LARGE'; END IF;
  FOR v_row, v_index IN SELECT value, (ordinality - 1)::integer FROM jsonb_array_elements(p_vehicles) WITH ORDINALITY LOOP
    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', '', 'message', 'INVALID_INPUT');
      CONTINUE;
    END IF;
    FOREACH v_field IN ARRAY ARRAY['frame_number','license_plate'] LOOP
      v_value := upper(btrim(coalesce(v_row->>v_field, '')));
      IF length(v_value) > (CASE WHEN v_field = 'license_plate' THEN 30 ELSE 100 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
      IF v_field = 'license_plate' THEN
        v_value := regexp_replace(v_value, '[^A-Z0-9]', '', 'g');
      END IF;
      IF v_value <> '' THEN
        IF (v_field = 'frame_number' AND (v_value = ANY(v_seen_frames) OR EXISTS (SELECT 1 FROM public.vehicles WHERE upper(btrim(frame_number)) = v_value)))
          OR (v_field = 'license_plate' AND (v_value = ANY(v_seen_plates) OR EXISTS (SELECT 1 FROM public.vehicles WHERE regexp_replace(upper(license_plate), '[^A-Z0-9]', '', 'g') = v_value))) THEN
          v_duplicates := v_duplicates || jsonb_build_object('index', v_index, 'field', v_field, 'value', v_value, 'message',
            CASE v_field WHEN 'frame_number' THEN 'Số khung đã tồn tại hoặc trùng trong file' ELSE 'Biển số đã tồn tại hoặc trùng trong file' END);
        END IF;
        IF v_field = 'frame_number' THEN v_seen_frames := array_append(v_seen_frames, v_value);
        ELSE v_seen_plates := array_append(v_seen_plates, v_value); END IF;
      END IF;
    END LOOP;
    -- Loại xe là trường bắt buộc khi nhập. Tên không khớp danh mục bị từ chối,
    -- không tự dịch, theo đúng quy tắc không tương thích ngược.
    BEGIN
      PERFORM private.vehicle_type_input(v_row);
    EXCEPTION WHEN sqlstate '22023' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'vehicle_type', 'message', SQLERRM);
    END;
    FOREACH v_field IN ARRAY ARRAY['color','supplier_name','supplier_phone','notes'] LOOP
      IF length(coalesce(v_row->>v_field, '')) > (CASE v_field
        WHEN 'color' THEN 80 WHEN 'supplier_name' THEN 200
        WHEN 'supplier_phone' THEN 40 ELSE 10000 END) THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', v_field, 'message', 'INVALID_' || upper(v_field));
      END IF;
    END LOOP;
    BEGIN
      PERFORM private.money_input(v_row, 'purchase_price', 0);
      IF NOT private.can_financials() AND v_row ? 'purchase_price' THEN
        RAISE EXCEPTION USING errcode = '42501', message = 'FINANCIAL_ACCESS_DENIED';
      END IF;
    EXCEPTION WHEN invalid_parameter_value OR insufficient_privilege THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'purchase_price', 'message', SQLERRM);
    END;
    BEGIN
      IF nullif(v_row->>'purchase_date', '') IS NOT NULL AND v_row->>'purchase_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PURCHASE_DATE';
      END IF;
      v_date := coalesce(nullif(v_row->>'purchase_date', '')::date, private.today());
      IF v_date > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'PURCHASE_DATE_IN_FUTURE'; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'purchase_date', 'message', 'INVALID_PURCHASE_DATE');
    END;
    v_value := nullif(v_row->>'year', '');
    IF v_value IS NOT NULL THEN
      BEGIN
        IF v_value !~ '^[0-9]+$' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER'; END IF;
        v_number := v_value::integer;
        IF v_number NOT BETWEEN 1900 AND 2100 THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INTEGER'; END IF;
      EXCEPTION WHEN invalid_parameter_value OR numeric_value_out_of_range OR invalid_text_representation THEN
        v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'year', 'message', 'INVALID_YEAR');
      END;
    END IF;
    IF v_row ? 'status' AND v_row->>'status' IS DISTINCT FROM 'IN_STOCK' THEN
      v_errors := v_errors || jsonb_build_object('index', v_index, 'field', 'status', 'message', 'INVALID_VEHICLE_STATUS');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('duplicates', v_duplicates, 'errors', v_errors);
END $$;

CREATE OR REPLACE FUNCTION private.import_vehicles_impl(p_vehicles jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_validation jsonb;
  v_row jsonb;
  v_data jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF jsonb_typeof(p_vehicles) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT'; END IF;
  IF jsonb_array_length(p_vehicles) = 0 THEN RAISE EXCEPTION USING errcode = '22023', message = 'NO_DATA_TO_IMPORT'; END IF;
  IF jsonb_array_length(p_vehicles) > 500 THEN RAISE EXCEPTION USING errcode = '22023', message = 'IMPORT_BATCH_TOO_LARGE'; END IF;
  LOCK TABLE public.vehicles IN SHARE ROW EXCLUSIVE MODE;
  v_validation := public.validate_import_vehicles(p_vehicles);
  IF jsonb_array_length(v_validation->'duplicates') > 0 THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'DUPLICATE_IMPORT_VEHICLE';
  END IF;
  IF jsonb_array_length(v_validation->'errors') > 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_IMPORT_DATA', detail = (v_validation->'errors')::text;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_vehicles) LOOP
    v_data := v_row || jsonb_build_object(
      'vehicle_type_id', private.vehicle_type_input(v_row),
      'acquisition_date', coalesce(nullif(v_row->>'purchase_date', ''), private.today()::text),
      'seller_name', coalesce(v_row->>'supplier_name', ''),
      'seller_phone', coalesce(v_row->>'supplier_phone', ''),
      'acquisition_notes', coalesce(v_row->>'notes', '')
    );
    -- The parent batch receipt already commits every row atomically. No row UUID is
    -- invented here; this internal helper is inaccessible to client roles.
    v_data := jsonb_set(v_data, '{frame_number}', to_jsonb(upper(btrim(coalesce(v_data->>'frame_number','')))));
    v_ids := array_append(v_ids, private.acquire_vehicle_impl(v_data));
  END LOOP;
  RETURN jsonb_build_object('imported_count', cardinality(v_ids), 'vehicle_ids', to_jsonb(v_ids));
END $$;

-- Cài đặt: hàng đợi "Chọn nhanh" đã bị xoá hoàn toàn, thay bằng danh mục loại xe.
CREATE OR REPLACE FUNCTION public.save_settings(p_data jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_old jsonb; v_new jsonb;
  v_from time; v_until time; v_days integer[];
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING errcode='22023',message='INVALID_INPUT'; END IF;

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

  SELECT to_jsonb(s) INTO v_old FROM public.system_settings s WHERE id FOR UPDATE;
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
    updated_by=v_actor,updated_at=now()
  WHERE id RETURNING to_jsonb(system_settings) INTO v_new;
  PERFORM private.audit(
    CASE
      WHEN (v_old->>'staff_allowed_from') <> (v_new->>'staff_allowed_from')
        OR (v_old->>'staff_allowed_until') <> (v_new->>'staff_allowed_until')
        OR (v_old->'staff_working_days') <> (v_new->'staff_working_days')
        THEN 'STAFF_SCHEDULE_CHANGED'
      ELSE 'MESSAGE_SETTING_CHANGED'
    END,
    'system_settings',null,v_old,v_new);
END $$;


-- ============================================================
-- STEP 9: Hàm đọc (danh sách, tìm kiếm, đối soát, showroom, phê duyệt)
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_vehicles(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_sort text:=coalesce(p_filters->>'sort','newest');
  v_type_name text:=nullif(btrim(coalesce(p_filters->>'vehicle_type','')),'');
  v_type uuid:=nullif(nullif(coalesce(p_filters->>'vehicle_type_id',''),'')::text,'')::uuid;
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if nullif(p_filters->>'min_days','') is not null and (p_filters->>'min_days')::integer not between 0 and 36500 then raise exception using errcode='22023',message='INVALID_STOCK_AGE'; end if;
  if v_sort='highest_cost' and not private.can_financials() then raise exception using errcode='42501',message='FINANCIAL_ACCESS_DENIED'; end if;
  if v_type is null and v_type_name is not null then
    select id into v_type from public.vehicle_types where lower(btrim(name))=lower(v_type_name);
    if v_type is null then raise exception using errcode='22023',message='INVALID_VEHICLE_TYPE'; end if;
  end if;
  with matching as (
    select v.* from public.vehicles v
    left join public.vehicle_types t on t.id=v.vehicle_type_id
    where
      not exists (select 1 from public.approval_requests ar
                  where ar.subject_id = v.id and ar.kind = 'VEHICLE_DELETION' and ar.status = 'PENDING') and
      (nullif(p_filters->>'status','') is null or p_filters->>'status'='ALL' or v.status::text=p_filters->>'status' or (p_filters->>'status' in ('AVAILABLE','UNSOLD') and v.status in ('IN_STOCK','RESERVED'))) and
      (nullif(p_filters->>'min_days','') is null or (v.status in ('IN_STOCK','RESERVED') and private.today()-v.purchase_date >= (p_filters->>'min_days')::integer)) and
      (not coalesce(nullif(p_filters->>'cost_pending','')::boolean,false) or exists(select 1 from public.vehicle_financials vf where vf.vehicle_id=v.id and vf.purchase_price is null)) and
      (v_type is null or v.vehicle_type_id=v_type) and
      (nullif(p_filters->>'year','') is null or v.year=(p_filters->>'year')::integer) and
      (nullif(p_filters->>'date_from','') is null or v.purchase_date>=(p_filters->>'date_from')::date) and
      (nullif(p_filters->>'date_to','') is null or v.purchase_date<=(p_filters->>'date_to')::date) and
      (v_search='' or concat_ws(' ',v.internal_code,v.license_plate,v.frame_number,v.color,t.name) ilike '%'||v_search||'%'
        or exists(select 1 from public.sales s where s.vehicle_id=v.id and s.customer_phone ilike '%'||v_search||'%'))
  ), ordered as (
    select m.id,row_number() over(order by
      case when v_sort='oldest' then m.created_at end asc,
      case when v_sort='longest_stock' then case when m.status in ('IN_STOCK','RESERVED') then m.purchase_date end end asc nulls last,
      case when v_sort='highest_cost' then f.purchase_price+(select coalesce(sum(amount),0) from public.vehicle_expenses e where e.vehicle_id=m.id and e.status='ACTIVE') end desc nulls last,
      m.created_at desc,m.id) as ord
    from matching m left join public.vehicle_financials f on f.vehicle_id=m.id
    order by ord
    limit v_limit offset v_offset
  )
  select (select count(*) from matching),coalesce((select jsonb_agg(private.vehicle_json(v) order by o.ord) from ordered o join public.vehicles v on v.id=o.id),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

CREATE OR REPLACE FUNCTION public.list_acquisitions(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_from date := coalesce(nullif(p_filters->>'from', ''), nullif(p_filters->>'date_from', ''))::date;
  v_to date := coalesce(nullif(p_filters->>'to', ''), nullif(p_filters->>'date_to', ''))::date;
  v_search text := left(coalesce(p_filters->>'search', ''), 200);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_total bigint;
  v_fin boolean := private.can_financials();
BEGIN
  IF v_from > v_to THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE';
  END IF;

  WITH matching AS (
    SELECT a.*, v.frame_number, v.license_plate, v.year, v.color, v.internal_code,
           t.name AS vehicle_type, p.full_name AS creator_name
    FROM public.acquisitions a
    JOIN public.vehicles v ON v.id = a.vehicle_id
    LEFT JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN public.profiles p ON p.id = a.created_by
    WHERE
      (v_from IS NULL OR a.acquisition_date >= v_from)
      AND (v_to IS NULL OR a.acquisition_date <= v_to)
      AND (nullif(p_filters->>'status', '') IS NULL OR a.status::text = p_filters->>'status')
      AND (v_search = '' OR concat_ws(' ', v.frame_number, v.license_plate, v.internal_code, t.name, a.seller_name, a.seller_phone) ILIKE '%' || v_search || '%')
  ),
  paged AS (
    SELECT * FROM matching
    ORDER BY acquisition_date DESC, created_at DESC, id
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    (SELECT count(*) FROM matching),
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'vehicle_id', p.vehicle_id,
          'frame_number', p.frame_number,
          'license_plate', p.license_plate,
          'vehicle_type', p.vehicle_type,
          'year', p.year,
          'color', p.color,
          'internal_code', p.internal_code,
          'vehicle_title', private.vehicle_label_text(p.license_plate, p.frame_number, p.internal_code),
          'vehicle_subtitle', private.vehicle_subtitle_text(p.vehicle_type, p.year, p.color),
          'acquisition_date', p.acquisition_date,
          'purchase_price', CASE WHEN v_fin THEN p.purchase_price ELSE NULL END,
          'seller_name', p.seller_name,
          'seller_phone', p.seller_phone,
          'status', p.status,
          'notes', p.notes,
          'creator_name', p.creator_name,
          'created_by', p.created_by,
          'created_at', p.created_at
        ) ORDER BY p.acquisition_date DESC, p.created_at DESC, p.id
      ) FROM paged p
    ), '[]'::jsonb)
  INTO v_total, v_items;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

CREATE OR REPLACE FUNCTION public.list_sales(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_from date:=coalesce(nullif(p_filters->>'from',''),nullif(p_filters->>'date_from',''))::date;
  v_to date:=coalesce(nullif(p_filters->>'to',''),nullif(p_filters->>'date_to',''))::date;
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if v_from>v_to then raise exception using errcode='22023',message='INVALID_DATE_RANGE'; end if;
  with matching as (
    select s.* from public.sales s
    join public.vehicles v on v.id=s.vehicle_id
    left join public.vehicle_types t on t.id=v.vehicle_type_id
    where
      (v_from is null or s.sale_date>=v_from) and (v_to is null or s.sale_date<=v_to) and
      (nullif(p_filters->>'status','') is null or s.status::text=p_filters->>'status') and
      (v_search='' or concat_ws(' ',s.sale_code,s.customer_name,s.customer_phone,v.internal_code,v.license_plate,v.frame_number,t.name) ilike '%'||v_search||'%')
  ), paged as (select * from matching order by sale_date desc,created_at desc,id limit v_limit offset v_offset)
  select (select count(*) from matching),coalesce((select jsonb_agg(private.sale_json(s) order by sale_date desc,created_at desc,id) from public.sales s where id in(select id from paged)),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

CREATE OR REPLACE FUNCTION public.list_receivables(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_search text := left(btrim(coalesce(p_filters->>'search', '')), 200);
  v_status text := coalesce(p_filters->>'payment_status', 'DEBT_ONLY');
  v_from date := coalesce(nullif(p_filters->>'from', ''), nullif(p_filters->>'date_from', ''))::date;
  v_to date := coalesce(nullif(p_filters->>'to', ''), nullif(p_filters->>'date_to', ''))::date;
  v_sort text := coalesce(p_filters->>'sort', 'highest_debt');
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_result jsonb;
BEGIN
  IF v_from > v_to THEN RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_DATE_RANGE'; END IF;
  IF v_status NOT IN ('ALL','DEBT_ONLY','OVERDUE','PARTIALLY_PAID','UNPAID','PAID') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_PAYMENT_STATUS';
  END IF;
  WITH paid AS (
    SELECT sale_id, private.safe_money(sum(amount)) AS amount
    FROM public.payments WHERE status = 'ACTIVE' GROUP BY sale_id
  ), balances AS (
    SELECT s.id, s.sale_code, s.customer_name, s.customer_phone, s.sale_date, s.due_date, s.created_at,
      v.internal_code, v.license_plate, v.frame_number, t.name AS vehicle_type,
      coalesce(p.amount, 0) AS paid_amount,
      greatest(0, s.sale_price - coalesce(p.amount, 0)) AS remaining_amount,
      s.due_date IS NOT NULL AND s.due_date < private.today()
        AND s.sale_price > coalesce(p.amount, 0) AS is_overdue
    FROM public.sales s JOIN public.vehicles v ON v.id = s.vehicle_id
    LEFT JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN paid p ON p.sale_id = s.id WHERE s.status = 'COMPLETED'
  ), filtered AS (
    SELECT b.* FROM balances b WHERE
      (v_from IS NULL OR b.sale_date >= v_from) AND (v_to IS NULL OR b.sale_date <= v_to)
      AND (v_status = 'ALL'
        OR (v_status = 'DEBT_ONLY' AND b.remaining_amount > 0)
        OR (v_status = 'OVERDUE' AND b.is_overdue)
        OR (v_status = 'PARTIALLY_PAID' AND b.remaining_amount > 0 AND b.paid_amount > 0)
        OR (v_status = 'UNPAID' AND b.remaining_amount > 0 AND b.paid_amount = 0)
        OR (v_status = 'PAID' AND b.remaining_amount = 0))
      AND (v_search = '' OR concat_ws(' ', b.sale_code, b.customer_name, b.customer_phone,
        b.internal_code, b.license_plate, b.frame_number, b.vehicle_type) ILIKE '%' || v_search || '%')
  ), ordered AS (
    SELECT f.id, row_number() OVER (ORDER BY
      CASE WHEN v_sort = 'highest_debt' THEN f.remaining_amount END DESC,
      CASE WHEN v_sort = 'due_date' THEN f.due_date END ASC NULLS LAST,
      CASE WHEN v_sort = 'oldest' THEN f.sale_date END ASC,
      f.sale_date DESC, f.created_at DESC, f.id) AS ord
    FROM filtered f
  ), paged AS (
    SELECT * FROM ordered ORDER BY ord LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(private.sale_json(s) ORDER BY p.ord)
      FROM paged p JOIN public.sales s ON s.id = p.id), '[]'::jsonb),
    'total', count(*),
    'total_receivable', private.safe_money(coalesce(sum(remaining_amount), 0)),
    'total_overdue', private.safe_money(coalesce(sum(remaining_amount) FILTER (WHERE is_overdue), 0)),
    'overdue_count', count(*) FILTER (WHERE is_overdue),
    'unpaid_count', count(*) FILTER (WHERE remaining_amount > 0)
  ) INTO v_result FROM filtered;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.list_expenses(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER']::public.user_role[]);
  v_from date:=coalesce(nullif(p_filters->>'from',''),nullif(p_filters->>'date_from',''))::date;
  v_to date:=coalesce(nullif(p_filters->>'to',''),nullif(p_filters->>'date_to',''))::date;
  v_kind text:=coalesce(p_filters->>'kind','all');
  v_search text:=left(coalesce(p_filters->>'search',''),200);
  v_limit integer:=least(100,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  v_offset integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0)); v_items jsonb; v_total bigint;
begin
  if v_from>v_to then raise exception using errcode='22023',message='INVALID_DATE_RANGE'; end if;
  with combined as (
    select e.id,e.expense_date,e.created_at,e.status,e.description,to_jsonb(e)||jsonb_build_object('kind','vehicle','vehicle_code',v.internal_code,'internal_code',v.internal_code)||private.vehicle_display(v) as data
    from public.vehicle_expenses e join public.vehicles v on v.id=e.vehicle_id where v_kind in ('all','vehicle')
    union all
    select e.id,e.expense_date,e.created_at,e.status,e.description,to_jsonb(e)||jsonb_build_object('kind','business') from public.business_expenses e where v_kind in ('all','business')
  ), matching as (
    select * from combined where (v_from is null or expense_date>=v_from) and (v_to is null or expense_date<=v_to)
      and (nullif(p_filters->>'status','') is null or status::text=p_filters->>'status') and (v_search='' or description ilike '%'||v_search||'%')
      and (nullif(p_filters->>'vehicle_id','') is null or data->>'vehicle_id'=p_filters->>'vehicle_id')
  ), paged as (select * from matching order by expense_date desc,created_at desc,id limit v_limit offset v_offset)
  select (select count(*) from matching),coalesce((select jsonb_agg(data order by expense_date desc,created_at desc,id) from paged),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

CREATE OR REPLACE FUNCTION public.daily_reconciliation(p_date date DEFAULT NULL::date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER']::public.user_role[]);
  v_day date := coalesce(p_date, private.today());
  v_summary jsonb;
  v_collected jsonb;
  v_payments jsonb;
  v_sales jsonb;
  v_expenses jsonb;
  v_business bigint;
  v_vehicle bigint;
BEGIN
  IF v_day > private.today() THEN RAISE EXCEPTION USING errcode = '22023', message = 'FUTURE_DATE'; END IF;
  SELECT jsonb_build_object('sales_count', count(*), 'sales_revenue', private.safe_money(coalesce(sum(sale_price), 0)))
  INTO v_summary FROM public.sales WHERE status = 'COMPLETED' AND sale_date = v_day;
  SELECT jsonb_build_object(
    'today_sales_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE s.sale_date = v_day), 0)),
    'debt_collected_today', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE s.sale_date < v_day), 0)),
    'total_collected', private.safe_money(coalesce(sum(p.amount), 0)),
    'cash_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'CASH'), 0)),
    'bank_transfer_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'BANK_TRANSFER'), 0)),
    'other_collected', private.safe_money(coalesce(sum(p.amount) FILTER (WHERE p.payment_method = 'OTHER'), 0))
  ) INTO v_collected FROM public.payments p JOIN public.sales s ON s.id = p.sale_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED';
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_business FROM public.business_expenses WHERE status = 'ACTIVE' AND expense_date = v_day;
  SELECT private.safe_money(coalesce(sum(amount), 0)) INTO v_vehicle FROM public.vehicle_expenses WHERE status = 'ACTIVE' AND expense_date = v_day;
  SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('sale_code', s.sale_code,
    'customer_name', s.customer_name, 'customer_phone', s.customer_phone, 'sale_date', s.sale_date,
    'internal_code', v.internal_code, 'license_plate', v.license_plate,
    'is_prior_debt', s.sale_date < v_day)
    || private.vehicle_display(v) ORDER BY p.created_at DESC, p.id), '[]'::jsonb)
  INTO v_payments FROM public.payments p JOIN public.sales s ON s.id = p.sale_id
  JOIN public.vehicles v ON v.id = s.vehicle_id
  WHERE p.status = 'ACTIVE' AND p.payment_date = v_day AND s.status = 'COMPLETED';
  -- Day details deliberately override lifetime balances with amounts as of this day.
  SELECT coalesce(jsonb_agg(private.sale_json(s) || jsonb_build_object(
    'paid_amount', coalesce(p.paid_today, 0), 'paid_today', coalesce(p.paid_today, 0),
    'remaining_amount', greatest(0, s.sale_price - coalesce(p.paid_to_day, 0))) ORDER BY s.created_at DESC, s.id), '[]'::jsonb)
  INTO v_sales FROM public.sales s
  LEFT JOIN LATERAL (SELECT private.safe_money(sum(amount) FILTER (WHERE payment_date = v_day)) AS paid_today,
    private.safe_money(sum(amount) FILTER (WHERE payment_date <= v_day)) AS paid_to_day
    FROM public.payments WHERE sale_id = s.id AND status = 'ACTIVE') p ON true
  WHERE s.status = 'COMPLETED' AND s.sale_date = v_day;
  SELECT coalesce(jsonb_agg(data ORDER BY expense_date, created_at, id), '[]'::jsonb) INTO v_expenses
  FROM (SELECT e.id, e.expense_date, e.created_at, to_jsonb(e) || jsonb_build_object('kind', 'vehicle',
    'internal_code', v.internal_code) || private.vehicle_display(v) AS data
    FROM public.vehicle_expenses e JOIN public.vehicles v ON v.id = e.vehicle_id WHERE e.status = 'ACTIVE' AND e.expense_date = v_day
    UNION ALL SELECT e.id, e.expense_date, e.created_at, to_jsonb(e) || jsonb_build_object('kind', 'business')
    FROM public.business_expenses e WHERE e.status = 'ACTIVE' AND e.expense_date = v_day) expenses;
  RETURN v_summary || v_collected || jsonb_build_object('date', v_day,
    'new_debt_created', private.safe_money((v_summary->>'sales_revenue')::numeric - (v_collected->>'today_sales_collected')::numeric),
    'business_expenses', v_business, 'vehicle_expenses', v_vehicle,
    'total_expenses', private.safe_money(v_business::numeric + v_vehicle),
    'net_cash_movement', private.safe_money((v_collected->>'total_collected')::numeric - v_business - v_vehicle),
    'payments', v_payments, 'sales', v_sales, 'expenses', v_expenses);
END $$;

CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_query text := left(btrim(coalesce(p_query, '')), 100);
  v_phone text := private.normalize_customer_phone(v_query);
  v_limit integer := least(30, greatest(1, coalesce(p_limit, 10)));
  v_vehicles jsonb := '[]'::jsonb;
  v_customers jsonb := '[]'::jsonb;
  v_sales jsonb := '[]'::jsonb;
BEGIN
  IF length(v_query) < 2 THEN RETURN jsonb_build_object('vehicles', v_vehicles, 'customers', v_customers, 'sales', v_sales); END IF;
  SELECT coalesce(jsonb_agg(private.vehicle_json(v) ORDER BY v.created_at DESC, v.id), '[]'::jsonb) INTO v_vehicles
  FROM public.vehicles v
  WHERE v.id IN (
    SELECT x.id FROM public.vehicles x
    LEFT JOIN public.vehicle_types t ON t.id = x.vehicle_type_id
    WHERE concat_ws(' ', x.internal_code, x.license_plate, x.frame_number, x.color, t.name)
      ILIKE '%' || v_query || '%'
    ORDER BY x.created_at DESC, x.id LIMIT v_limit
  );
  v_customers := public.list_customers(jsonb_build_object('search', v_query, 'limit', v_limit))->'items';
  SELECT coalesce(jsonb_agg(to_jsonb(result) ORDER BY result.sale_date DESC, result.created_at DESC, result.id), '[]'::jsonb)
  INTO v_sales FROM (
    SELECT s.id, s.sale_code, s.customer_name, s.customer_phone,
      private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) AS vehicle_title,
      v.internal_code, v.license_plate,
      s.sale_date, s.created_at, s.sale_price, s.status,
      CASE WHEN s.status = 'COMPLETED' THEN greatest(0, s.sale_price - coalesce(p.paid, 0)) ELSE 0 END AS remaining_amount
    FROM public.sales s JOIN public.vehicles v ON v.id = s.vehicle_id
    LEFT JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    LEFT JOIN LATERAL (SELECT private.safe_money(sum(amount)) AS paid FROM public.payments
      WHERE sale_id = s.id AND status = 'ACTIVE') p ON true
    WHERE concat_ws(' ', s.sale_code, s.customer_name, s.customer_phone, v.internal_code, v.license_plate,
      v.frame_number, t.name) ILIKE '%' || v_query || '%'
      OR (v_phone <> '' AND private.normalize_customer_phone(s.customer_phone) LIKE '%' || v_phone || '%')
    ORDER BY s.sale_date DESC, s.created_at DESC, s.id LIMIT v_limit
  ) result;
  RETURN jsonb_build_object('vehicles', v_vehicles, 'customers', v_customers, 'sales', v_sales);
END $$;

-- Showroom công khai: danh tính xe + loại + đời + màu. Không bất kỳ mức giá nào,
-- không số km đã đi, không phiên bản, không hãng xe.
CREATE OR REPLACE FUNCTION public.list_showroom_vehicles(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_search text := left(btrim(coalesce(p_filters->>'search', '')), 100);
  v_type text := left(btrim(coalesce(p_filters->>'vehicle_type', '')), 60);
  v_limit integer := least(50, greatest(1, coalesce((p_filters->>'limit')::integer, 24)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb;
  v_types jsonb;
  v_total bigint;
BEGIN
  IF jsonb_typeof(coalesce(p_filters, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.vehicles v
  JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
  WHERE v.status = 'IN_STOCK'
    AND (v_search = '' OR concat_ws(' ', t.name, v.color, v.license_plate, v.frame_number, v.year)
      ILIKE '%' || v_search || '%')
    AND (v_type = '' OR t.name ILIKE v_type);

  SELECT coalesce(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.sort_at DESC, x.id), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT v.id, v.internal_code, nullif(v.license_plate, '') AS license_plate, v.frame_number,
      v.year, nullif(v.color, '') AS color, t.name AS vehicle_type,
      private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) AS vehicle_title,
      private.vehicle_subtitle_text(t.name, v.year, v.color) AS vehicle_subtitle,
      v.created_at, v.created_at AS sort_at
    FROM public.vehicles v
    JOIN public.vehicle_types t ON t.id = v.vehicle_type_id
    WHERE v.status = 'IN_STOCK'
      AND (v_search = '' OR concat_ws(' ', t.name, v.color, v.license_plate, v.frame_number, v.year)
        ILIKE '%' || v_search || '%')
      AND (v_type = '' OR t.name ILIKE v_type)
    ORDER BY v.created_at DESC, v.id
    LIMIT v_limit OFFSET v_offset
  ) x;

  -- Danh sách bộ lọc cho khách vãng lai: chỉ loại đang có xe bày bán.
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.name) ORDER BY t.name), '[]'::jsonb) INTO v_types
  FROM public.vehicle_types t
  WHERE EXISTS (SELECT 1 FROM public.vehicles v WHERE v.status = 'IN_STOCK' AND v.vehicle_type_id = t.id);

  RETURN jsonb_build_object('total', v_total, 'items', v_items, 'vehicle_types', v_types);
END $$;

CREATE OR REPLACE FUNCTION public.list_pending_approvals(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER']::public.user_role[]);
  v_limit integer := least(100, greatest(1, coalesce((p_filters->>'limit')::integer, 50)));
  v_offset integer := greatest(0, coalesce((p_filters->>'offset')::integer, 0));
  v_items jsonb; v_total bigint;
BEGIN
  SELECT count(*) INTO v_total FROM public.approval_requests ar WHERE ar.status = 'PENDING';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'kind', x.kind, 'subject_id', x.subject_id, 'reason', x.reason,
      'requested_by', x.requested_by, 'requester_name', x.requester_name, 'created_at', x.created_at,
      'vehicle_code', x.vehicle_code, 'vehicle_title', x.vehicle_title,
      'vehicle_subtitle', x.vehicle_subtitle, 'license_plate', x.license_plate,
      'vehicle_status', x.vehicle_status
    ) ORDER BY x.rn), '[]'::jsonb) INTO v_items
  FROM (
    SELECT row_number() OVER (ORDER BY ar.created_at DESC, ar.id DESC) AS rn,
      ar.id, ar.kind, ar.subject_id, ar.reason, ar.requested_by, ar.created_at,
      req.full_name AS requester_name,
      v.internal_code AS vehicle_code,
      private.vehicle_label_text(v.license_plate, v.frame_number, v.internal_code) AS vehicle_title,
      private.vehicle_display(v) ->> 'vehicle_subtitle' AS vehicle_subtitle,
      v.license_plate, v.status::text AS vehicle_status
    FROM public.approval_requests ar
    LEFT JOIN public.profiles req ON req.id = ar.requested_by
    LEFT JOIN public.vehicles v ON v.id = ar.subject_id
    WHERE ar.status = 'PENDING'
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT v_limit OFFSET v_offset
  ) x;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END $$;

-- ============================================================
-- STEP 10: Phân quyền RPC danh mục
-- ============================================================
-- list_vehicle_types() mở cho anon vì trang showroom công khai cần danh sách chip
-- lọc; nhánh anon trong hàm chỉ trả loại đang có xe bày bán và ẩn số lượng.
-- save/delete vẫn là OWNER tuyệt đối.

REVOKE ALL ON FUNCTION
  public.list_vehicle_types(),
  public.save_vehicle_type(uuid, text),
  public.delete_vehicle_type(uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.list_vehicle_types(),
  public.save_vehicle_type(uuid, text),
  public.delete_vehicle_type(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_vehicle_types() TO anon;

REVOKE ALL ON FUNCTION
  private.vehicle_type_input(jsonb),
  private.vehicle_type_input_optional(jsonb),
  private.vehicle_display(public.vehicles),
  private.vehicle_label_text(text, text, text),
  private.vehicle_subtitle_text(text, integer, text)
  FROM public, anon, authenticated;


-- ============================================================
-- STEP 11: Tự kiểm chứng — sai bất kỳ điều kiện nào là rollback cả migration
-- ============================================================

DO $$
DECLARE
  v_bad text;
  v_rows bigint;
BEGIN
  -- 1. Column đã loại bỏ không còn tồn tại ở bất kỳ dạng nào.
  SELECT string_agg(x.col, ', ' ORDER BY x.col) INTO v_bad
  FROM (
    SELECT table_schema || '.' || table_name || '.' || column_name AS col
    FROM information_schema.columns
    WHERE (table_schema, table_name, column_name) IN (
      ('public','vehicles','brand'), ('public','vehicles','model'), ('public','vehicles','variant'),
      ('public','vehicles','engine_number'), ('public','vehicles','odometer'), ('public','vehicles','asking_price'),
      ('public','system_settings','quickpick_brands'), ('public','system_settings','quickpick_models')
    )
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: columns still present: %', v_bad USING errcode = 'P0001';
  END IF;

  -- 2. Bảng lịch sử đã trắng 100% (không tombstone, không JSONB sót lại).
  SELECT (SELECT count(*) FROM public.audit_logs)
       + (SELECT count(*) FROM public.vehicle_activity)
       + (SELECT count(*) FROM public.notifications)
       + (SELECT count(*) FROM public.customer_communications)
       + (SELECT count(*) FROM public.message_outbox) INTO v_rows;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: history tables still hold % rows', v_rows USING errcode = 'P0001';
  END IF;

  -- 3. Mọi xe có đúng một loại xe; danh mục đã seed và FK đang chắn xoá.
  SELECT count(*) INTO v_rows FROM public.vehicles WHERE vehicle_type_id IS NULL;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: % vehicles without a vehicle type', v_rows USING errcode = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vehicles'::regclass
      AND conname = 'vehicles_vehicle_type_id_fkey' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: vehicles_vehicle_type_id_fkey missing' USING errcode = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.vehicle_types) < 6 THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: vehicle_types catalogue not seeded' USING errcode = 'P0001';
  END IF;

  -- 4. Không còn hàm nào trong public/private tham chiếu tên trường đã tẩy chay
  --    (kể cả trong chú thích bên trong thân hàm — đây là lỗi fail-closed).
  SELECT string_agg(x.who, ', ' ORDER BY x.who) INTO v_bad
  FROM (
    SELECT n.nspname || '.' || p.proname AS who
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','private')
      AND p.prosrc ~ '\m(brand|model|variant|engine_number|odometer|asking_price|quickpick_brands|quickpick_models)\M'
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: functions still reference purged fields: %', v_bad USING errcode = 'P0001';
  END IF;

  -- 5. Index cũ trên cột số máy đã bị xoá theo CASCADE; trigger bất biến dựng lại.
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'vehicles_engine_number') THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: vehicles_engine_number index still exists' USING errcode = 'P0001';
  END IF;
  SELECT count(*) INTO v_rows FROM pg_trigger
  WHERE tgname IN ('immutable_audit', 'immutable_activity') AND NOT tgisinternal;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: immutable history triggers not restored (% found)', v_rows USING errcode = 'P0001';
  END IF;

  -- 6. Chữ ký cũ của hàm nhận diện (4 đối số) đã bị loại hoàn toàn.
  SELECT count(*) INTO v_rows FROM pg_proc
  WHERE proname = 'vehicle_label_text' AND array_length(proargtypes, 1) = 4;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'PURGE_ASSERT_FAILED: legacy four-argument vehicle_label_text still exists' USING errcode = 'P0001';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
