-- 16/10/2026: list_notifications trả thêm vehicle_internal_code (mã nội bộ xe)
-- để chuông hiển thị mã xe ngay dưới dòng tiêu đề, giúp chủ quán nhận ra xe
-- nhanh hơn khi có nhiều xe cùng biển hoặc chưa có biển.
-- Forward-only: CREATE OR REPLACE, không xóa dữ liệu, không đổi schema.

CREATE OR REPLACE FUNCTION public.list_notifications(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := private.require_role(ARRAY['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_limit integer := least(100, greatest(1, coalesce((p_filters ->> 'limit')::integer, 25)));
  v_offset integer := greatest(0, coalesce((p_filters ->> 'offset')::integer, 0));
  v_unread_only boolean := coalesce((p_filters ->> 'unread_only')::boolean, false);
  v_items jsonb;
  v_total bigint;
  v_unread bigint;
BEGIN
  IF jsonb_typeof(p_filters) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_INPUT';
  END IF;
  SELECT count(*) INTO v_total FROM public.notifications n WHERE n.user_id = v_actor;
  SELECT count(*) INTO v_unread
  FROM public.notifications n WHERE n.user_id = v_actor AND n.read_at IS NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'action', x.action, 'entity_type', x.entity_type,
      'entity_id', x.entity_id, 'vehicle_id', x.vehicle_id,
      'title', x.title, 'body', x.body, 'deep_link', x.deep_link,
      'read_at', x.read_at, 'created_at', x.created_at,
      'actor_id', x.actor_id, 'actor_name', x.actor_name,
      'vehicle_type', x.vehicle_type,
      'vehicle_internal_code', x.vehicle_internal_code
    ) ORDER BY x.rn), '[]'::jsonb) INTO v_items
  FROM (
    SELECT row_number() OVER (ORDER BY n.created_at DESC, n.id DESC) AS rn,
           n.id, n.action, n.entity_type, n.entity_id, n.vehicle_id,
           n.title, n.body, n.deep_link, n.read_at, n.created_at,
           n.actor_id, a.full_name AS actor_name,
           vt.name AS vehicle_type,
           v.internal_code AS vehicle_internal_code
    FROM public.notifications n
    LEFT JOIN public.profiles a ON a.id = n.actor_id
    LEFT JOIN public.vehicles v ON v.id = n.vehicle_id
    LEFT JOIN public.vehicle_types vt ON vt.id = v.vehicle_type_id
    WHERE n.user_id = v_actor
      AND (NOT v_unread_only OR n.read_at IS NULL)
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT v_limit OFFSET v_offset
  ) x;

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'unread_count', v_unread);
END $$;
