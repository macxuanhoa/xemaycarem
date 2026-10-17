-- Nhân viên ghi được chi phí cho xe (save_expense mở cho mọi role đang công tác,
-- xem permissions.ts:canManageVehicleExpenses) nhưng get_vehicle chỉ gắn mảng
-- chi phí khi người đọc là OWNER/MANAGER. Hệ quả thật trên màn hình: nhân viên
-- bấm "Lưu chi phí", hệ thống báo đã lưu, rồi mở hồ sơ xe ra thấy
-- "Chưa ghi nhận chi phí cho xe này" — họ không thể biết mình ghi trùng, ghi
-- thiếu hay sai loại chi phí, và phải hỏi quản lý cho một việc họ vừa tự làm.
--
-- Ba nhánh chiếu theo người đọc, giữ đúng một ranh giới: TIỀN chỉ đi theo
-- người có quyền tài chính, hoặc theo đúng dòng mà chính người đó ghi.
--   * OWNER / MANAGER có can_view_financials -> bản ghi đầy đủ như trước;
--   * STAFF -> loại, ngày, trạng thái, người ghi; `description` và `amount` chỉ
--     trả ở dòng do chính họ tạo (tiền lệ sẵn có: thông báo cho người trong
--     cuộc thấy số tiền của thao tác mình vừa làm). Ghi chú tự do của người
--     khác vẫn ẩn vì có thể chứa tên khách hoặc nhà cung cấp;
--   * MANAGER không giữ quyền tài chính -> vẫn thấy mô tả vận hành nhưng KHÔNG
--     còn amount. Trước migration này vai trò đó nhận nguyên bản ghi đầy đủ:
--     UI ẩn số tiền nhưng dữ liệu đã đi qua mạng.
--
-- Body dưới đây sao nguyên bản mới nhất (20261014000600, vốn là bản của
-- 20261008000200 + cột is_favorite), chỉ thay khối `if` gắn chi phí. Chữ ký hàm
-- không đổi (p_id uuid) nên GRANTS/REVOKE và RLS hiện hành vẫn y hiệu lực.
-- Trạng thái: LOCAL/PENDING — chưa áp production; áp production cần
-- `npm run backup:prod` trước và sự uỷ quyền tường minh của OWNER.

CREATE OR REPLACE FUNCTION public.get_vehicle(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
declare
  v_actor uuid:=private.require_role(array['OWNER','MANAGER','STAFF']::public.user_role[]);
  v_vehicle public.vehicles; v_images jsonb; v_expenses jsonb:='[]'; v_sales jsonb; v_activity jsonb;
  v_pending boolean;
begin
  select * into v_vehicle from public.vehicles where id=p_id;
  if not found then raise exception using errcode='P0002',message='VEHICLE_NOT_FOUND'; end if;
  select exists (select 1 from public.approval_requests ar
                 where ar.subject_id=p_id and ar.kind='VEHICLE_DELETION' and ar.status='PENDING') into v_pending;
  select coalesce(jsonb_agg(to_jsonb(i) order by display_order,created_at),'[]'::jsonb) into v_images from public.vehicle_images i where vehicle_id=p_id and deleted_at is null;
  if private.can_financials() then
    -- OWNER và MANAGER được xem tài chính: nguyên bản ghi, như trước đây.
    select coalesce(jsonb_agg(to_jsonb(e) order by e.expense_date desc,e.created_at desc),'[]'::jsonb) into v_expenses from public.vehicle_expenses e where e.vehicle_id=p_id;
  elsif private.current_role() = 'STAFF' then
    -- Nhân viên là người ghi chi phí, nên sổ của xe phải đọc lại được với họ:
    -- loại, ngày, trạng thái, ai ghi. Số tiền và ghi chú tự do chỉ đi kèm đúng
    -- dòng chính họ tạo — không phải vì họ đáng tin hơn, mà vì đó là con số và
    -- câu chữ do chính họ vừa nhập.
    select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'vehicle_id', e.vehicle_id,
          'expense_type', e.expense_type,
          'expense_date', e.expense_date,
          'status', e.status,
          'created_by', e.created_by,
          'created_at', e.created_at,
          'description', case when e.created_by = v_actor then e.description end)
        || case when e.created_by = v_actor then jsonb_build_object('amount', e.amount) else '{}'::jsonb end
        order by e.expense_date desc, e.created_at desc), '[]'::jsonb) into v_expenses
    from public.vehicle_expenses e where e.vehicle_id=p_id;
  else
    -- MANAGER thường (không can_view_financials): thấy toàn bộ mô tả vận hành
    -- để điều hành cửa hàng, nhưng khóa `amount` ngay từ server.
    select coalesce(jsonb_agg((to_jsonb(e) - 'amount')
        order by e.expense_date desc, e.created_at desc), '[]'::jsonb) into v_expenses
    from public.vehicle_expenses e where e.vehicle_id=p_id;
  end if;
  select coalesce(jsonb_agg(public.get_sale(s.id) order by created_at desc),'[]'::jsonb) into v_sales from public.sales s where vehicle_id=p_id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc),'[]'::jsonb) into v_activity from (
    select a.*,p.full_name as actor_name from public.vehicle_activity a left join public.profiles p on p.id=a.user_id where vehicle_id=p_id order by a.created_at desc,a.id desc limit 100
  ) a;
  return private.vehicle_json(v_vehicle)||jsonb_build_object(
    'images',v_images,'expenses',v_expenses,'sales',v_sales,'activity',v_activity,
    'pending_deletion',v_pending,
    'is_favorite',exists(select 1 from public.vehicle_favorites fv where fv.vehicle_id=p_id and fv.user_id=v_actor));
end $$;

COMMENT ON FUNCTION public.get_vehicle(uuid) IS
  'Hồ sơ xe cho mọi role đang công tác. expenses phân chiếu theo người đọc: OWNER/MANAGER được xem tài chính nhận bản đầy đủ; STAFF nhận dòng rút gọn và chỉ thấy amount + description của đúng dòng họ ghi; MANAGER không có can_view_financials không nhận amount.';
